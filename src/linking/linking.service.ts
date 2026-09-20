import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service';
import type { Identity } from '../auth/workspace.guard';
import { CoreRecordClient } from '../core-record/core-record.client';

@Injectable()
export class LinkingService {
  constructor(
    private readonly db: PrismaService,
    private readonly coreRecord: CoreRecordClient,
  ) {}

  async confirmRecommendation(identity: Identity, recommendationId: string, reason?: string) {
    const recommendation = await this.db.candidateJobRecommendation.findFirst({
      where: { id: recommendationId, workspaceId: identity.workspaceId },
      include: {
        job: { include: { criteriaVersions: { where: { status: 'confirmed' }, orderBy: { version: 'desc' }, take: 1 } } },
        candidate: { include: { profiles: { orderBy: { version: 'desc' }, take: 1 } } },
        prelinkEvaluation: true,
      },
    });
    if (!recommendation) throw new NotFoundException({ code: 'NOT_FOUND' });
    if (!['proposed', 'deferred'].includes(recommendation.status)) {
      if (recommendation.applicationRef) return this.getApplication(identity, recommendation.applicationRef);
      throw new ConflictException({ code: 'RECOMMENDATION_NOT_CONFIRMABLE', status: recommendation.status });
    }
    const criteria = recommendation.job.criteriaVersions[0];
    const profile = recommendation.candidate.profiles[0];
    if (recommendation.job.status !== 'open') {
      throw new ConflictException({ code: 'JOB_NOT_OPEN', status: recommendation.job.status });
    }
    if (recommendation.candidate.libraryStatus !== 'available') {
      throw new ConflictException({ code: 'CANDIDATE_NOT_AVAILABLE' });
    }
    if (!criteria || recommendation.prelinkEvaluation.criteriaVersion !== criteria.version) {
      throw new ConflictException({ code: 'RECOMMENDATION_STALE', reason: 'Criteria version changed. Refresh matching first.' });
    }
    if (!profile || recommendation.prelinkEvaluation.profileVersion !== profile.version) {
      throw new ConflictException({ code: 'RECOMMENDATION_STALE', reason: 'Candidate profile changed. Refresh matching first.' });
    }

    const inputManifest = {
      candidateId: recommendation.candidateId,
      jobId: recommendation.jobId,
      profileVersion: profile.version,
      criteriaVersion: criteria.version,
      prelinkEvaluationId: recommendation.prelinkEvaluationId,
    };
    const linkReason = reason?.trim() || 'Confirmed from a current job recommendation.';
    const coreApplication = await this.coreRecord.createApplication(identity, {
      candidateId: recommendation.candidateId,
      jobId: recommendation.jobId,
      cycleId: 'cycle-1',
      origin: 'sourced',
      linkReason,
    }, `screening:application:create:${identity.workspaceId}:${recommendation.candidateId}:${recommendation.jobId}:cycle-1`);
    const application = await this.db.$transaction(async (tx) => {
      const existing = await tx.application.findUnique({
        where: {
          workspaceId_candidateId_jobId_cycleId: {
            workspaceId: identity.workspaceId,
            candidateId: recommendation.candidateId,
            jobId: recommendation.jobId,
            cycleId: 'cycle-1',
          },
        },
      });
      const created = existing || await tx.application.create({
        data: {
          ...(coreApplication?.id ? { id: coreApplication.id } : {}),
          workspaceId: identity.workspaceId,
          candidateId: recommendation.candidateId,
          jobId: recommendation.jobId,
          cycleId: 'cycle-1',
          status: 'active',
          screeningStatus: 'not_started',
          origin: 'sourced',
          linkedBy: identity.actorId,
          linkReason,
        },
      });
      await tx.candidateJobRecommendation.update({
        where: { id: recommendation.id },
        data: { status: 'confirmed', applicationRef: created.id },
      });
      await tx.linkDecision.create({
        data: {
          workspaceId: identity.workspaceId,
          candidateId: recommendation.candidateId,
          jobId: recommendation.jobId,
          recommendationId: recommendation.id,
          applicationId: created.id,
          action: 'confirm',
          reason: linkReason,
          actorId: identity.actorId,
          inputManifest,
        },
      });
      await tx.humanTask.create({
        data: {
          workspaceId: identity.workspaceId,
          sourceModule: 'Resume Library',
          taskType: 'screening_review',
          title: `Review screening: ${recommendation.candidate.displayName} — ${recommendation.job.title}`,
          subjectLabel: 'Linked, screening not yet run.',
          requiredAction: 'Review screening and choose next step.',
          completionRule: { requiredResultType: 'screening_review_completed' },
          candidateId: recommendation.candidateId,
          jobId: recommendation.jobId,
          applicationId: created.id,
          recommendationId: recommendation.id,
          assigneeId: identity.actorId,
          priority: 'normal',
          linkRoute: `/applications/${created.id}`,
        },
      });
      await tx.job.update({
        where: { id: recommendation.jobId },
        data: { applicantCount: { increment: existing ? 0 : 1 } },
      });
      await tx.auditRecord.create({
        data: {
          workspaceId: identity.workspaceId,
          actorId: identity.actorId,
          action: 'job_link_confirmed',
          objectType: 'Application',
          objectId: created.id,
          payload: { recommendationId: recommendation.id, inputManifest },
        },
      });
      return created;
    });
    return toFrontendApplication(application);
  }

  async getApplication(identity: Identity, id: string) {
    const application = await this.db.application.findFirst({
      where: { id, workspaceId: identity.workspaceId },
      include: {
        candidate: { select: { id: true, displayName: true } },
        job: { select: { id: true, title: true } },
      },
    });
    if (!application) throw new NotFoundException({ code: 'NOT_FOUND' });
    return toFrontendApplication(application);
  }

  async listApplications(identity: Identity, jobId?: string) {
    const applications = await this.db.application.findMany({
      where: { workspaceId: identity.workspaceId, ...(jobId ? { jobId } : {}) },
      orderBy: { linkedAt: 'desc' },
      include: {
        candidate: { select: { id: true, displayName: true } },
        job: { select: { id: true, title: true } },
      },
    });
    return applications.map(toFrontendApplication);
  }
}

function toFrontendApplication(application: {
  id: string;
  candidateId: string;
  jobId: string;
  cycleId: string;
  status: string;
    screeningStatus: string;
    assessmentStatus: string;
  origin: string;
  linkedAt: Date;
  linkedBy: string;
  linkReason: string;
  candidate?: { id: string; displayName: string };
  job?: { id: string; title: string };
}) {
  return {
    id: application.id,
    candidateId: application.candidateId,
    jobId: application.jobId,
    cycleId: application.cycleId,
    status: application.status,
    screeningStatus: application.screeningStatus,
    assessmentStatus: application.assessmentStatus,
    origin: application.origin,
    linkedAt: application.linkedAt.toISOString(),
    linkedBy: application.linkedBy,
    linkReason: application.linkReason,
    candidateName: application.candidate?.displayName,
    jobTitle: application.job?.title,
  };
}
