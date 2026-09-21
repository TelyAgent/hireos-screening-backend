/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../persistence/prisma.service';
import type { Identity } from '../auth/workspace.guard';
import { AiScreeningEvaluatorService } from './ai-screening-evaluator.service';
import { AiCallError } from '../shared/ai-json-client';
import { serializeDecision } from '../decisions/decisions.service';

type DimensionInput = { id: string; name: string; weight: number; rubric: string };
type RequirementInput = {
  id: string;
  label: string;
  dimension: string;
  priority: 'must_have' | 'nice_to_have';
  hard: boolean;
  kind: 'authorization' | 'experience' | 'skill' | 'other';
};

type NormalizedDimensionResult = DimensionInput & {
  status: 'evaluated' | 'unknown';
  score: number | null;
  confidence: number | null;
  reason: string;
  evidenceQuote: string | null;
};

type NormalizedRequirementResult = {
  requirementId: string;
  status: 'met' | 'not_met' | 'unknown';
  reason: string;
  evidenceQuote: string | null;
};

@Injectable()
export class ScreeningService {
  constructor(
    private readonly db: PrismaService,
    private readonly aiEvaluator: AiScreeningEvaluatorService,
  ) {}

  async getDetail(identity: Identity, applicationId: string) {
    const application = await this.findApplication(identity, applicationId);
    const evaluation = await this.currentEvaluation(identity.workspaceId, applicationId);
    const decision = await this.db.screeningDecision.findFirst({
      where: { workspaceId: identity.workspaceId, applicationId, status: 'approved' },
      orderBy: { createdAt: 'desc' },
    });
    return this.serializeDetail(application, evaluation, decision);
  }

  async listEvaluations(identity: Identity, applicationId: string) {
    await this.findApplication(identity, applicationId);
    const evaluations = await this.db.screeningEvaluation.findMany({
      where: { workspaceId: identity.workspaceId, applicationId },
      orderBy: { version: 'desc' },
      include: { dimensionScores: true, concerns: true, verificationItems: true, humanAssessments: true, evidenceItems: true },
    });
    return evaluations.map((evaluation) => serializeEvaluation(evaluation));
  }

  async run(identity: Identity, applicationId: string, purpose: string) {
    const application = await this.findApplication(identity, applicationId);
    const input = await this.loadInputs(identity.workspaceId, applicationId);
    if (input.job.criteriaStatus !== 'confirmed' || !input.criteria) {
      throw new ConflictException({ code: 'CRITERIA_NOT_CONFIRMED' });
    }
    if (!input.profile) throw new ConflictException({ code: 'PROFILE_NOT_READY' });
    if (input.profile.parseStatus !== 'succeeded') {
      throw new ConflictException({ code: 'PROFILE_NOT_READY', status: input.profile.parseStatus });
    }

    const version = await this.db.screeningEvaluation.aggregate({
      where: { workspaceId: identity.workspaceId, applicationId },
      _max: { version: true },
    });
    return this.createEvaluation(identity, application, input, (version._max.version || 0) + 1, purpose);
  }

  async refresh(identity: Identity, evaluationId: string) {
    const previous = await this.db.screeningEvaluation.findFirst({
      where: { id: evaluationId, workspaceId: identity.workspaceId },
      include: { application: true },
    });
    if (!previous) throw new NotFoundException({ code: 'NOT_FOUND' });
    const input = await this.loadInputs(identity.workspaceId, previous.applicationId);
    if (input.job.criteriaStatus !== 'confirmed' || !input.criteria) {
      throw new ConflictException({ code: 'CRITERIA_NOT_CONFIRMED' });
    }
    if (!input.profile || input.profile.parseStatus !== 'succeeded') {
      throw new ConflictException({ code: 'PROFILE_NOT_READY' });
    }
    return this.createEvaluation(
      identity,
      previous.application,
      input,
      previous.version + 1,
      'rescreen',
    );
  }

  async saveHumanAssessment(
    identity: Identity,
    evaluationId: string,
    raw: { dimensionId?: string; dimensionName?: string; score?: number; reason?: string },
  ) {
    const evaluation = await this.db.screeningEvaluation.findFirst({
      where: { id: evaluationId, workspaceId: identity.workspaceId },
      include: { dimensionScores: true },
    });
    if (!evaluation) throw new NotFoundException({ code: 'NOT_FOUND' });
    if (!raw.dimensionId || !raw.dimensionName || raw.score == null || raw.score < 0 || raw.score > 100 || !raw.reason?.trim()) {
      throw new BadRequestException({ code: 'INVALID_HUMAN_ASSESSMENT' });
    }
    const dimension = evaluation.dimensionScores.find((item) => item.dimensionId === raw.dimensionId);
    if (!dimension || dimension.name !== raw.dimensionName) {
      throw new BadRequestException({ code: 'DIMENSION_NOT_FOUND' });
    }
    const assessment = await this.db.humanAssessment.upsert({
      where: { evaluationId_dimensionId: { evaluationId, dimensionId: raw.dimensionId } },
      create: {
        workspaceId: identity.workspaceId,
        applicationId: evaluation.applicationId,
        evaluationId,
        dimensionId: raw.dimensionId,
        dimensionName: raw.dimensionName,
        score: raw.score,
        reason: raw.reason.trim(),
        byActorId: identity.actorId,
      },
      update: {
        score: raw.score,
        reason: raw.reason.trim(),
        byActorId: identity.actorId,
        createdAt: new Date(),
      },
    });
    await this.db.auditRecord.create({
      data: {
        workspaceId: identity.workspaceId,
        actorId: identity.actorId,
        action: 'screening_human_assessment_saved',
        objectType: 'HumanAssessment',
        objectId: assessment.id,
        payload: { evaluationId, dimensionId: raw.dimensionId },
      },
    });
    return serializeHumanAssessment(assessment);
  }

  async resolveConcern(identity: Identity, concernId: string, resolution?: string) {
    if (!['dismissed', 'confirmed', 'accepted_risk'].includes(resolution || '')) {
      throw new BadRequestException({ code: 'INVALID_CONCERN_RESOLUTION' });
    }
    const concern = await this.db.screeningConcern.findFirst({
      where: { id: concernId, workspaceId: identity.workspaceId },
    });
    if (!concern) throw new NotFoundException({ code: 'NOT_FOUND' });
    const updated = await this.db.screeningConcern.update({
      where: { id: concernId },
      data: { status: resolution, resolution },
    });
    return serializeConcern(updated);
  }

  async assignVerification(identity: Identity, itemId: string) {
    const item = await this.db.verificationItem.findFirst({
      where: { id: itemId, workspaceId: identity.workspaceId },
    });
    if (!item) throw new NotFoundException({ code: 'NOT_FOUND' });
    const updated = await this.db.verificationItem.update({
      where: { id: itemId },
      data: { status: 'assigned', ownerId: identity.actorId },
    });
    return serializeVerificationItem(updated);
  }

  async resolveVerification(identity: Identity, itemId: string, outcome?: string) {
    if (!['met', 'not_met'].includes(outcome || '')) {
      throw new BadRequestException({ code: 'INVALID_VERIFICATION_OUTCOME' });
    }
    const item = await this.db.verificationItem.findFirst({
      where: { id: itemId, workspaceId: identity.workspaceId },
    });
    if (!item) throw new NotFoundException({ code: 'NOT_FOUND' });
    const updated = await this.db.verificationItem.update({
      where: { id: itemId },
      data: { status: 'resolved', outcome, resolvedBy: identity.actorId, resolvedAt: new Date() },
    });
    return serializeVerificationItem(updated);
  }

  private async createEvaluation(
    identity: Identity,
    application: ApplicationInput,
    input: EvaluationInputs,
    version: number,
    purpose: string,
  ) {
    const dimensions = asDimensions(input.criteria?.dimensions);
    const requirements = asRequirements(input.criteria?.requirements);
    const hardRequirements = requirements.filter((requirement) => requirement.hard);
    const resumeText = input.material?.text || '';

    const { dimensionResults, eligibilityResults, overall, coverage, evaluatorVersion } = this.aiEvaluator.isConfigured() && resumeText
      ? await this.evaluateWithAi(input.job?.title || '', dimensions, hardRequirements, resumeText)
      : this.evaluateLocally(dimensions, hardRequirements, input.profile, buildCorpus(input.profile, resumeText));

    const eligibilityStatus = aggregateEligibility(eligibilityResults);
    const missingInformation = dimensionResults.filter((dimension) => dimension.status !== 'evaluated').map((dimension) => dimension.name);
    const strengths = dimensionResults.filter((dimension) => dimension.score != null && dimension.score >= 75).map((dimension) => dimension.name);
    const verificationDrafts = hardRequirements
      .map((requirement) => ({ requirement, result: eligibilityResults.find((item) => item.requirementId === requirement.id) }))
      .filter((item) => item.result?.status === 'unknown');
    const inputManifest = {
      candidateId: application.candidateId,
      jobId: application.jobId,
      profileVersion: input.profile?.version ?? null,
      criteriaVersion: input.criteria?.version ?? null,
      materialId: input.material?.id ?? null,
      materialReadStatus: input.material?.readStatus ?? null,
      evaluator: evaluatorVersion,
    };

    const evaluation = await this.db.$transaction(async (tx) => {
      await tx.screeningEvaluation.updateMany({
        where: { workspaceId: identity.workspaceId, applicationId: application.id, freshness: 'current' },
        data: { freshness: 'stale' },
      });
      const session = await tx.screeningSession.create({
        data: {
          workspaceId: identity.workspaceId,
          applicationId: application.id,
          purpose,
          ownerId: identity.actorId,
        },
      });
      const created = await tx.screeningEvaluation.create({
        data: {
          workspaceId: identity.workspaceId,
          applicationId: application.id,
          sessionId: session.id,
          version,
          status: 'completed',
          evaluationMode: 'manual',
          aiStatus: 'not_requested',
          inputManifest: json(inputManifest),
          eligibilityStatus,
          eligibilityResults: json(eligibilityResults),
          overallScore: overall,
          coverage,
          confidence: overall == null ? null : 0.68,
          evaluationStatus: overall == null ? 'insufficient_evidence' : 'evaluated',
          strengths: json(strengths),
          missingInformation: json(missingInformation),
          recommendation: Prisma.JsonNull,
          modelVersion: null,
          completedAt: new Date(),
        },
      });
      // Real evidenceQuotes (from the AI evaluator) get their own EvidenceItem each, so a
      // reviewer opening one dimension's evidence sees the exact quote that justified it,
      // not one generic sentence shared across every dimension. The local fallback
      // evaluator never produces real quotes, so it keeps the single generic item it
      // always used -- still better than fabricating quotes it can't back up.
      const hasRealQuotes = dimensionResults.some((d) => d.evidenceQuote) || eligibilityResults.some((r) => r.evidenceQuote);
      const dimensionEvidenceIds = new Map<string, string>();
      const allEvidenceItems: Array<{ id: string }> = [];
      let genericEvidenceId: string | null = null;
      if (!hasRealQuotes && input.material) {
        const generic = await tx.evidenceItem.create({
          data: {
            workspaceId: identity.workspaceId,
            evaluationId: created.id,
            candidateId: application.candidateId,
            materialId: input.material.id,
            kind: 'documented_fact',
            sourceLabel: input.material.name,
            statement: firstUsefulSentence(input.material.text) || 'Resume material is available for review.',
            locator: json({ type: 'text', segmentId: firstSegmentId(input.material.segments) }),
            verification: 'unverified',
            confidence: 0.62,
            availability: 'available',
          },
        });
        genericEvidenceId = generic.id;
        allEvidenceItems.push(generic);
      }
      for (const dimension of dimensionResults) {
        if (!dimension.evidenceQuote) continue;
        const item = await tx.evidenceItem.create({
          data: {
            workspaceId: identity.workspaceId,
            evaluationId: created.id,
            candidateId: application.candidateId,
            materialId: input.material?.id,
            kind: 'documented_fact',
            sourceLabel: input.material?.name || 'Resume',
            statement: dimension.evidenceQuote,
            locator: json({ type: 'text', segmentId: 'ai-quote' }),
            verification: 'unverified',
            confidence: dimension.confidence ?? 0.6,
            availability: 'available',
          },
        });
        dimensionEvidenceIds.set(dimension.id, item.id);
        allEvidenceItems.push(item);
      }
      const scores = await Promise.all(dimensionResults.map((dimension) => tx.dimensionScore.create({
        data: {
          workspaceId: identity.workspaceId,
          evaluationId: created.id,
          dimensionId: dimension.id,
          name: dimension.name,
          weight: dimension.weight,
          status: dimension.status,
          score: dimension.score,
          confidence: dimension.confidence,
          reason: dimension.reason,
          supportingRefs: json((() => {
            const specific = dimensionEvidenceIds.get(dimension.id);
            if (specific) return [specific];
            return genericEvidenceId && dimension.status === 'evaluated' ? [genericEvidenceId] : [];
          })()),
          counterRefs: json([]),
        },
      })));
      const verificationItems = await Promise.all(verificationDrafts.map(({ requirement }) => tx.verificationItem.create({
        data: {
          workspaceId: identity.workspaceId,
          applicationId: application.id,
          evaluationId: created.id,
          question: `Please confirm: ${requirement.label}`,
          method: 'candidate_question',
          targetStage: 'screening',
          priority: requirement.priority === 'must_have' ? 'high' : 'medium',
          acceptance: `A clear answer addressing: ${requirement.label}`,
        },
      })));
      const concerns = await Promise.all(verificationDrafts.map(({ requirement }) => tx.screeningConcern.create({
        data: {
          workspaceId: identity.workspaceId,
          applicationId: application.id,
          evaluationId: created.id,
          type: 'missing_information',
          title: `${requirement.label} is not confirmed`,
          severity: requirement.priority === 'must_have' ? 'high' : 'medium',
          confidence: null,
          basis: 'missing_information',
          requirementIds: json([requirement.id]),
          verificationItemIds: json([]),
        },
      })));
      if (concerns.length && verificationItems.length) {
        await Promise.all(concerns.map((concern, index) => tx.screeningConcern.update({
          where: { id: concern.id },
          data: { verificationItemIds: json([verificationItems[index].id]) },
        })));
      }
      await tx.application.update({
        where: { id: application.id },
        data: { screeningStatus: 'review_pending' },
      });
      await tx.auditRecord.create({
        data: {
          workspaceId: identity.workspaceId,
          actorId: identity.actorId,
          action: 'screening_evaluation_created',
          objectType: 'ScreeningEvaluation',
          objectId: created.id,
          payload: json({ applicationId: application.id, version, inputManifest }),
        },
      });
      return { ...created, dimensionScores: scores, evidenceItems: allEvidenceItems, verificationItems, concerns, humanAssessments: [] };
    });
    return serializeEvaluation(evaluation);
  }

  private async currentEvaluation(workspaceId: string, applicationId: string) {
    return this.db.screeningEvaluation.findFirst({
      where: { workspaceId, applicationId, freshness: 'current' },
      orderBy: { version: 'desc' },
      include: { dimensionScores: true, evidenceItems: true, concerns: true, verificationItems: true, humanAssessments: true },
    });
  }

  private async findApplication(identity: Identity, id: string) {
    const application = await this.db.application.findFirst({ where: { id, workspaceId: identity.workspaceId } });
    if (!application) throw new NotFoundException({ code: 'NOT_FOUND' });
    return application;
  }

  private async loadInputs(workspaceId: string, applicationId: string): Promise<EvaluationInputs> {
    const application = await this.db.application.findFirst({
      where: { id: applicationId, workspaceId },
      include: {
        candidate: { include: { profiles: { orderBy: { version: 'desc' }, take: 1 }, resumeVersions: { where: { isLatest: true }, take: 1, include: { material: true } } } },
        job: { include: { criteriaVersions: { where: { status: 'confirmed' }, orderBy: { version: 'desc' }, take: 1 } } },
      },
    });
    if (!application) throw new NotFoundException({ code: 'NOT_FOUND' });
    return {
      application,
      candidate: application.candidate,
      job: application.job,
      profile: application.candidate.profiles[0],
      material: application.candidate.resumeVersions[0]?.material,
      criteria: application.job.criteriaVersions[0],
    };
  }

  private serializeDetail(application: ApplicationInput, evaluation: EvaluationRecord | null, decision: unknown | null) {
    return {
      application: serializeApplication(application),
      evaluation: evaluation ? serializeEvaluation(evaluation) : null,
      concerns: evaluation?.concerns.map(serializeConcern) || [],
      verificationItems: evaluation?.verificationItems.map(serializeVerificationItem) || [],
      humanAssessments: evaluation?.humanAssessments.map(serializeHumanAssessment) || [],
      decision: decision ? serializeDecision(decision) : null,
    };
  }

  // AI is authoritative when configured -- the local fallback below scores every
  // dimension off corpus length and name-substring matches (e.g. a longer resume scores
  // higher regardless of content), which is not a real judgment. A genuine AI failure
  // must surface as an error the caller can retry, not silently degrade to that.
  private async evaluateWithAi(
    jobTitle: string,
    dimensions: DimensionInput[],
    hardRequirements: RequirementInput[],
    resumeText: string,
  ): Promise<{
    dimensionResults: NormalizedDimensionResult[];
    eligibilityResults: NormalizedRequirementResult[];
    overall: number | null;
    coverage: number;
    evaluatorVersion: string;
  }> {
    let ai: Awaited<ReturnType<AiScreeningEvaluatorService['evaluate']>>;
    try {
      ai = await this.aiEvaluator.evaluate({
        jobTitle,
        dimensions: dimensions.map((d) => ({ id: d.id, name: d.name, weight: d.weight, rubric: d.rubric })),
        hardRequirements: hardRequirements.map((r) => ({ id: r.id, label: r.label, kind: r.kind })),
        resumeText,
      });
    } catch (error) {
      const detail = error instanceof AiCallError ? error.message : 'AI_REQUEST_FAILED';
      throw new ServiceUnavailableException({ code: 'AI_EVALUATION_FAILED', message: detail });
    }
    const byId = new Map(ai.dimensionScores.map((d) => [d.dimensionId, d]));
    const dimensionResults: NormalizedDimensionResult[] = dimensions.map((dimension) => {
      const found = byId.get(dimension.id);
      if (!found || !found.evaluated) {
        return { ...dimension, status: 'unknown', score: null, confidence: null, reason: found?.reason || 'Not evaluated.', evidenceQuote: null };
      }
      return {
        ...dimension,
        status: 'evaluated',
        score: found.score,
        confidence: ai.confidence,
        reason: found.reason,
        evidenceQuote: found.evidenceQuote,
      };
    });
    const evaluatedWeight = dimensionResults.filter((d) => d.status === 'evaluated').reduce((sum, d) => sum + d.weight, 0);
    const overall = ai.coverage >= 0.7 && evaluatedWeight > 0
      ? dimensionResults.filter((d) => d.status === 'evaluated' && d.score != null).reduce((sum, d) => sum + (d.score || 0) * d.weight, 0) / evaluatedWeight
      : null;
    const findingsById = new Map(ai.hardRequirementFindings.map((f) => [f.requirementId, f]));
    const eligibilityResults: NormalizedRequirementResult[] = hardRequirements.map((requirement) => {
      const found = findingsById.get(requirement.id);
      return {
        requirementId: requirement.id,
        status: found?.status || 'unknown',
        reason: found?.reason || 'Not evaluated.',
        evidenceQuote: found?.evidenceQuote || null,
      };
    });
    return { dimensionResults, eligibilityResults, overall, coverage: ai.coverage, evaluatorVersion: 'ai-screening-evaluator-v1' };
  }

  private evaluateLocally(
    dimensions: DimensionInput[],
    hardRequirements: RequirementInput[],
    profile: unknown,
    corpus: string,
  ): {
    dimensionResults: NormalizedDimensionResult[];
    eligibilityResults: NormalizedRequirementResult[];
    overall: number | null;
    coverage: number;
    evaluatorVersion: string;
  } {
    const dimensionResults: NormalizedDimensionResult[] = dimensions.map((dimension) => ({
      ...evaluateDimension(dimension, profile, corpus),
      evidenceQuote: null,
    }));
    const evaluatedWeight = dimensionResults.filter((d) => d.status === 'evaluated').reduce((sum, d) => sum + d.weight, 0);
    const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0) || 1;
    const coverage = evaluatedWeight / totalWeight;
    const overall = coverage >= 0.7
      ? dimensionResults.filter((d) => d.status === 'evaluated' && d.score != null).reduce((sum, d) => sum + (d.score || 0) * d.weight, 0) / evaluatedWeight
      : null;
    const eligibilityResults: NormalizedRequirementResult[] = hardRequirements.map((requirement) => ({
      ...evaluateRequirement(requirement, profile, corpus),
      evidenceQuote: null,
    }));
    return { dimensionResults, eligibilityResults, overall, coverage, evaluatorVersion: 'local-rule-evaluator-v1' };
  }
}

type ApplicationInput = Awaited<ReturnType<ScreeningService['findApplication']>> & {
  candidate?: unknown;
  job?: unknown;
};
type EvaluationInputs = {
  application: ApplicationInput;
  candidate: any;
  job: any;
  profile: any;
  material: any;
  criteria: any;
};
type EvaluationRecord = any;

function evaluateDimension(dimension: DimensionInput, profile: any, corpus: string) {
  const name = dimension.name.toLowerCase();
  if (!corpus.trim()) return unknownDimension(dimension, 'No readable source material is available.');
  if (name.includes('compensation') || name.includes('location')) {
    const known = profile?.location?.status === 'known' || profile?.compensationExpectation?.status === 'known' || profile?.workAuthorization?.status === 'known';
    return known
      ? evaluatedDimension(dimension, 78, 0.72, 'Profile contains location, compensation, or work-authorization data.')
      : unknownDimension(dimension, 'Compensation and location fit are not sufficiently documented.');
  }
  if (name.includes('skill') || name.includes('technical') || name.includes('experience') || name.includes('seniority') || name.includes('ownership')) {
    const score = Math.min(92, 58 + Math.min(30, Math.round(corpus.length / 180)));
    return evaluatedDimension(dimension, score, 0.64, `Available profile and resume text provide evidence for ${dimension.name}.`);
  }
  return corpus.length > 80
    ? evaluatedDimension(dimension, 68, 0.55, `Available source text gives partial evidence for ${dimension.name}.`)
    : unknownDimension(dimension, `Available material does not contain enough evidence for ${dimension.name}.`);
}

function evaluatedDimension(dimension: DimensionInput, score: number, confidence: number, reason: string) {
  return { ...dimension, status: 'evaluated' as const, score, confidence, reason };
}

function unknownDimension(dimension: DimensionInput, reason: string) {
  return { ...dimension, status: 'unknown' as const, score: null, confidence: null, reason };
}

function evaluateRequirement(requirement: RequirementInput, profile: any, corpus: string) {
  const lower = `${requirement.label} ${corpus}`.toLowerCase();
  if (requirement.kind === 'authorization') {
    const authorization = profile?.workAuthorization;
    return {
      requirementId: requirement.id,
      status: (authorization?.status === 'known' ? 'met' : 'unknown') as 'met' | 'unknown',
      reason: authorization?.status === 'known' ? 'Work authorization is present in the candidate profile.' : 'Work authorization is not confirmed.',
    };
  }
  if (requirement.kind === 'experience' && profile?.employmentHistory?.length) {
    return { requirementId: requirement.id, status: 'met' as const, reason: 'Employment history is present in the candidate profile.' };
  }
  if (requirement.kind === 'skill' && lower.includes(requirement.label.toLowerCase().split(' ')[0])) {
    return { requirementId: requirement.id, status: 'met' as const, reason: 'The source corpus contains a matching skill term.' };
  }
  return { requirementId: requirement.id, status: 'unknown' as const, reason: 'The available material does not establish this requirement conclusively.' };
}

function aggregateEligibility(results: Array<{ status: string }>) {
  if (results.some((result) => result.status === 'not_met')) return 'not_eligible';
  if (results.some((result) => result.status === 'unknown')) return 'needs_verification';
  return 'eligible';
}

function buildCorpus(profile: any, text: string) {
  return `${text} ${JSON.stringify(profile || {})}`.toLowerCase();
}

function firstUsefulSentence(text: string) {
  return text.split(/[.!?\n]/).map((item) => item.trim()).find((item) => item.length > 20)?.slice(0, 500) || '';
}

function firstSegmentId(segments: unknown) {
  return Array.isArray(segments) && segments[0] && typeof segments[0] === 'object' && 'id' in segments[0]
    ? String((segments[0] as { id: unknown }).id)
    : 'full-text';
}

function asDimensions(value: unknown): DimensionInput[] {
  return Array.isArray(value) ? value.filter(isDimension) : [];
}

function asRequirements(value: unknown): RequirementInput[] {
  return Array.isArray(value) ? value.filter(isRequirement) : [];
}

function isDimension(value: unknown): value is DimensionInput {
  return Boolean(value && typeof value === 'object' && typeof (value as DimensionInput).id === 'string' && typeof (value as DimensionInput).name === 'string');
}

function isRequirement(value: unknown): value is RequirementInput {
  return Boolean(value && typeof value === 'object' && typeof (value as RequirementInput).id === 'string' && typeof (value as RequirementInput).label === 'string');
}

function serializeApplication(application: any) {
  return {
    id: application.id,
    candidateId: application.candidateId,
    jobId: application.jobId,
    cycleId: application.cycleId,
    status: application.status,
    screeningStatus: application.screeningStatus,
    origin: application.origin,
    linkedAt: application.linkedAt.toISOString(),
    linkedBy: application.linkedBy,
    linkReason: application.linkReason,
  };
}

function serializeEvaluation(evaluation: any) {
  return {
    id: evaluation.id,
    applicationId: evaluation.applicationId,
    version: evaluation.version,
    status: evaluation.status,
    evaluationMode: evaluation.evaluationMode,
    aiStatus: evaluation.aiStatus,
    eligibilityStatus: evaluation.eligibilityStatus,
    eligibilityResults: evaluation.eligibilityResults,
    overall: evaluation.overallScore,
    coverage: evaluation.coverage || 0,
    confidence: evaluation.confidence,
    evaluationStatus: evaluation.evaluationStatus,
    dimensionScores: (evaluation.dimensionScores || []).map((dimension: any) => ({
      id: dimension.dimensionId,
      name: dimension.name,
      weight: dimension.weight,
      status: dimension.status,
      score: dimension.score,
      confidence: dimension.confidence,
      reason: dimension.reason,
      supporting: dimension.supportingRefs,
      counter: dimension.counterRefs,
    })),
    modelVersion: evaluation.modelVersion,
    completedAt: evaluation.completedAt?.toISOString() || evaluation.createdAt.toISOString(),
    freshness: evaluation.freshness,
  };
}

function serializeConcern(concern: any) {
  return {
    id: concern.id,
    type: concern.type,
    title: concern.title,
    severity: concern.severity,
    confidence: concern.confidence,
    basis: concern.basis,
    status: concern.status,
    requirementIds: concern.requirementIds,
    verificationItemIds: concern.verificationItemIds,
    restricted: concern.restricted,
    resolution: concern.resolution,
  };
}

function serializeVerificationItem(item: any) {
  return {
    id: item.id,
    applicationId: item.applicationId,
    question: item.question,
    method: item.method,
    targetStage: item.targetStage,
    priority: item.priority,
    status: item.status,
    acceptance: item.acceptance,
    owner: item.ownerId || undefined,
    outcome: item.outcome || undefined,
    resolvedBy: item.resolvedBy || undefined,
    resolvedAt: item.resolvedAt?.toISOString(),
  };
}

function serializeHumanAssessment(assessment: any) {
  return {
    id: assessment.id,
    dimensionId: assessment.dimensionId,
    dimensionName: assessment.dimensionName,
    score: assessment.score,
    reason: assessment.reason,
    by: assessment.byActorId,
    at: assessment.createdAt.toISOString(),
  };
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
