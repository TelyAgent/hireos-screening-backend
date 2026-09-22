/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../persistence/prisma.service';
import { jobRequiresAssessment } from '../jobs/jobs.service';
import type { Identity } from '../auth/workspace.guard';

const OUTCOMES = ['strong_advance', 'advance', 'hold', 'do_not_advance', 'request_information'];
const TARGETS = ['record_only', 'send_assessment', 'move_to_interview'];

@Injectable()
export class DecisionsService {
  constructor(private readonly db: PrismaService) {}

  async record(identity: Identity, applicationId: string, raw: {
    outcome?: string;
    reason?: string;
    nextStepTarget?: string;
    overrideAi?: boolean;
    exceptionApproved?: boolean;
  }) {
    if (!OUTCOMES.includes(raw.outcome || '') || !TARGETS.includes(raw.nextStepTarget || '') || !raw.reason?.trim()) {
      throw new BadRequestException({ code: 'INVALID_DECISION' });
    }
    const application = await this.db.application.findFirst({
      where: { id: applicationId, workspaceId: identity.workspaceId },
      include: {
        job: true,
        candidate: { include: { resumeVersions: { where: { isLatest: true }, take: 1, include: { material: true } } } },
      },
    });
    if (!application) throw new NotFoundException({ code: 'NOT_FOUND' });
    const currentEvaluation = await this.db.screeningEvaluation.findFirst({
      where: { applicationId, workspaceId: identity.workspaceId, freshness: 'current' },
      orderBy: { version: 'desc' },
    });
    if (raw.nextStepTarget === 'move_to_interview' && application.job.criteriaStatus !== 'confirmed') {
      throw new ConflictException({ code: 'CRITERIA_NOT_CONFIRMED' });
    }
    const requiresAssessment = jobRequiresAssessment(application.job);
    if (
      requiresAssessment &&
      raw.nextStepTarget === 'move_to_interview' &&
      application.assessmentStatus !== 'completed' &&
      !raw.exceptionApproved
    ) {
      throw new ConflictException({ code: 'ASSESSMENT_REQUIRED', message: 'Required assessment is missing — request an exception to proceed' });
    }
    const existing = await this.db.screeningDecision.findFirst({
      where: { applicationId, workspaceId: identity.workspaceId, status: 'approved' },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      // Belt-and-suspenders: if an earlier run recorded the decision but this
      // step never ran (e.g. deployed after the decision was made), close the
      // task now rather than leaving it stuck open forever.
      await this.completeScreeningTask(identity, applicationId, existing.id);
      return this.serializeDecisionResult(existing, await this.latestPackage(identity.workspaceId, applicationId));
    }
    const decision = await this.db.$transaction(async (tx) => {
      const created = await tx.screeningDecision.create({
        data: {
          workspaceId: identity.workspaceId,
          applicationId,
          jobId: application.jobId,
          evaluationId: currentEvaluation?.id,
          outcome: raw.outcome!,
          reason: raw.reason!.trim(),
          actorId: identity.actorId,
          overrideAi: Boolean(raw.overrideAi),
          nextStepTarget: raw.nextStepTarget!,
          exceptionRef: raw.exceptionApproved ? `exception:${applicationId}:${Date.now()}` : null,
          policyRef: `job:${application.jobId}:criteria:${application.job.criteriaVersion}`,
        },
      });
      if (raw.exceptionApproved) {
        await tx.decisionExceptionApproval.createMany({
          data: [
            { workspaceId: identity.workspaceId, decisionId: created.id, role: 'hr', actorId: identity.actorId, reason: 'Local development exception approval.' },
            { workspaceId: identity.workspaceId, decisionId: created.id, role: 'hiring_manager', actorId: identity.actorId, reason: 'Local development exception approval.' },
          ],
        });
      }
      await tx.application.update({
        where: { id: applicationId },
        data: { screeningStatus: 'decided' },
      });
      await tx.auditRecord.create({
        data: {
          workspaceId: identity.workspaceId,
          actorId: identity.actorId,
          action: 'screening_decision_recorded',
          objectType: 'ScreeningDecision',
          objectId: created.id,
          payload: json({ applicationId, evaluationId: currentEvaluation?.id || null, outcome: raw.outcome, nextStepTarget: raw.nextStepTarget }),
        },
      });
      // Recording a decision *is* what "screening_review" was waiting on -- close
      // the loop here so the task never has to be marked done by hand.
      await tx.humanTask.updateMany({
        where: { workspaceId: identity.workspaceId, applicationId, taskType: 'screening_review', status: { notIn: ['completed', 'cancelled'] } },
        data: { status: 'completed', completedAt: new Date(), completionRef: created.id },
      });
      // "Move to interview" is a fact Interview needs to know about. Written in this
      // same transaction so the decision and the announcement of it can never disagree
      // (see docs/HireOS-Database-Architecture-Decision.md §7/§9 -- Screening owns this
      // event, a background dispatcher delivers it, Interview upserts by Core Record id).
      if (raw.nextStepTarget === 'move_to_interview') {
        await tx.screeningOutboxEvent.create({
          data: {
            workspaceId: identity.workspaceId,
            eventType: 'candidate.advanced_to_interview',
            aggregateId: applicationId,
            payload: json({
              coreJobId: application.jobId,
              coreCandidateId: application.candidateId,
              jobTitle: application.job.title,
              jobDepartment: application.job.team || undefined,
              jobLocation: application.job.location || undefined,
              jobLevel: application.job.seniority || undefined,
              jdText: application.job.jdText || undefined,
              candidateName: application.candidate.displayName,
              candidateEmail: application.candidate.email || undefined,
              candidatePhone: application.candidate.phone || undefined,
              // A stable reference, not the file itself (see screeningHandoffSchema's
              // comment on the receiving end) -- only set once that résumé's own Material
              // has been registered with Core Record (CORE_RECORD_MODE=remote); in mock
              // mode Interview just won't get a résumé automatically, same as before.
              coreMaterialId: application.candidate.resumeVersions[0]?.material.coreMaterialId || undefined,
              matchScore: currentEvaluation?.overallScore != null ? Math.round(currentEvaluation.overallScore) : undefined,
              matchRecommendation: mapMatchRecommendation(raw.outcome!),
            }),
          },
        });
      }
      return created;
    });
    const pkg = raw.nextStepTarget === 'send_assessment' || raw.nextStepTarget === 'move_to_interview'
      ? await this.createPackage(identity, application, decision, raw.nextStepTarget)
      : null;
    return this.serializeDecisionResult(decision, pkg);
  }

  async createReviewOnlyPackage(identity: Identity, applicationId: string) {
    const application = await this.db.application.findFirst({
      where: { id: applicationId, workspaceId: identity.workspaceId },
      include: { job: true },
    });
    if (!application) throw new NotFoundException({ code: 'NOT_FOUND' });
    const pkg = await this.createPackage(identity, application, null, 'review_only');
    return pkg;
  }

  async sendDeclineNotice(identity: Identity, applicationId: string) {
    const application = await this.db.application.findFirst({ where: { id: applicationId, workspaceId: identity.workspaceId } });
    if (!application) throw new NotFoundException({ code: 'NOT_FOUND' });
    await this.db.auditRecord.create({
      data: {
        workspaceId: identity.workspaceId,
        actorId: identity.actorId,
        action: 'candidate_decline_notice_requested',
        objectType: 'Application',
        objectId: applicationId,
        payload: json({ communication: 'decline_notice', explicit: true }),
      },
    });
    return { status: 'succeeded', applicationId };
  }

  async completeAssessment(identity: Identity, applicationId: string) {
    const application = await this.db.application.findFirst({
      where: { id: applicationId, workspaceId: identity.workspaceId },
    });
    if (!application) throw new NotFoundException({ code: 'NOT_FOUND' });
    const updated = await this.db.application.update({
      where: { id: applicationId },
      data: { assessmentStatus: 'completed' },
    });
    return { applicationId: updated.id, assessmentStatus: updated.assessmentStatus };
  }

  private async createPackage(identity: Identity, application: any, decision: any, target: string) {
    const evaluation = await this.db.screeningEvaluation.findFirst({
      where: { applicationId: application.id, workspaceId: identity.workspaceId, freshness: 'current' },
      orderBy: { version: 'desc' },
      include: { dimensionScores: true, verificationItems: true },
    });
    const kind = target === 'send_assessment' ? 'create_assessment' : target === 'move_to_interview' ? 'create_interview' : 'review_only';
    const targetLabel = kind === 'create_assessment'
      ? 'assessments-intake@partner-vendor.demo'
      : kind === 'create_interview'
        ? 'interviews@partner-agency.demo'
        : 'Report on file (not routed — review only)';
    const payload = {
      applicationId: application.id,
      kind,
      decisionId: decision?.id || null,
      evaluation: evaluation ? {
        id: evaluation.id,
        overall: evaluation.overallScore,
        coverage: evaluation.coverage,
        eligibilityStatus: evaluation.eligibilityStatus,
        dimensionScores: evaluation.dimensionScores.map((item) => ({ dimensionId: item.dimensionId, name: item.name, score: item.score, status: item.status, reason: item.reason })),
      } : null,
      verificationItems: kind === 'review_only' ? [] : evaluation?.verificationItems.map((item) => ({ question: item.question, acceptance: item.acceptance, status: item.status })) || [],
      accessPolicy: 'restricted_evidence_redacted',
    };
    const created = await this.db.handoffPackage.create({
      data: {
        workspaceId: identity.workspaceId,
        applicationId: application.id,
        jobId: application.jobId,
        decisionId: decision?.id,
        kind,
        transport: kind === 'review_only' ? null : 'email',
        targetLabel,
        reviewStatus: kind === 'review_only' ? 'human_reviewed' : null,
        status: 'package_ready',
        manifest: json({ files: ['manifest.json', 'payload.json', 'report.md'], renderer: 'local-structured-package-v1' }),
        payload: json(payload),
        attempts: {
          create: {
            workspaceId: identity.workspaceId,
            attemptNo: 1,
            status: 'prepared',
            transport: kind === 'review_only' ? null : 'email',
            targetLabel,
            history: json([{ at: new Date().toISOString(), state: 'Package ready' }]),
          },
        },
      },
      include: { attempts: true },
    });
    return serializePackage(created);
  }

  private async completeScreeningTask(identity: Identity, applicationId: string, decisionId: string) {
    await this.db.humanTask.updateMany({
      where: { workspaceId: identity.workspaceId, applicationId, taskType: 'screening_review', status: { notIn: ['completed', 'cancelled'] } },
      data: { status: 'completed', completedAt: new Date(), completionRef: decisionId },
    });
  }

  private async latestPackage(workspaceId: string, applicationId: string) {
    return this.db.handoffPackage.findFirst({
      where: { workspaceId, applicationId },
      orderBy: { createdAt: 'desc' },
      include: { attempts: { orderBy: { attemptNo: 'asc' } } },
    });
  }

  private serializeDecisionResult(decision: any, pkg: any) {
    return {
      decision: serializeDecision(decision),
      delivery: pkg
        ? typeof pkg.createdAt === 'string' ? pkg : serializePackage(pkg)
        : null,
    };
  }
}

export function serializeDecision(decision: any) {
  return {
    id: decision.id,
    applicationId: decision.applicationId,
    outcome: decision.outcome,
    reason: decision.reason,
    decidedBy: decision.actorId,
    decidedAt: decision.createdAt.toISOString(),
    status: decision.status,
    overrideAi: decision.overrideAi,
    exceptionRef: decision.exceptionRef || undefined,
  };
}

function serializePackage(pkg: any) {
  const attempts = pkg.attempts || [];
  const attempt = [...attempts].sort((a, b) => b.attemptNo - a.attemptNo)[0];
  return {
    id: pkg.id,
    applicationId: pkg.applicationId,
    kind: pkg.kind,
    transport: pkg.transport || undefined,
    targetLabel: pkg.targetLabel,
    reviewStatus: pkg.reviewStatus || undefined,
    status: attempt?.status === 'prepared' ? 'prepared' : attempt?.status || pkg.status,
    createdAt: pkg.createdAt.toISOString(),
    history: attempt?.history || [],
    packageStatus: pkg.status,
    attemptNo: attempt?.attemptNo || 0,
  };
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

// Interview's InterviewTask.matchRecommendation is a free string (comment: strong_match |
// match | weak_match) with no shared enum -- this is Screening's side of that informal
// contract, derived from the human's own decision outcome rather than re-deriving it from
// the AI evaluation, since the human's call is what actually sent the candidate onward.
function mapMatchRecommendation(outcome: string): string {
  if (outcome === 'strong_advance') return 'strong_match';
  if (outcome === 'advance') return 'match';
  return 'weak_match';
}
