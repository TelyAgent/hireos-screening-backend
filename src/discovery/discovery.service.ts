import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service';
import type { Identity } from '../auth/workspace.guard';

type JsonRecord = Record<string, unknown>;
type ProfileForMatch = {
  version: number;
  skills: unknown;
  workAuthorization: unknown;
  location: unknown;
};
type CandidateForMatch = { id: string; profiles: ProfileForMatch[] };
type CriteriaForMatch = { version: number; requirements: unknown; dimensions: unknown };
type JobForMatch = { id: string; criteriaVersions: CriteriaForMatch[] };

@Injectable()
export class DiscoveryService {
  constructor(private readonly db: PrismaService) {}

  async matchCandidate(identity: Identity, candidateId: string) {
    const candidate = await this.db.candidate.findFirst({
      where: { id: candidateId, workspaceId: identity.workspaceId },
      include: { profiles: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!candidate) throw new NotFoundException({ code: 'NOT_FOUND' });
    const openJobs = await this.db.job.findMany({
      where: { workspaceId: identity.workspaceId, status: 'open' },
      include: { criteriaVersions: { where: { status: 'confirmed' }, orderBy: { version: 'desc' }, take: 1 } },
    });
    const run = await this.db.jobDiscoveryRun.create({
      data: {
        workspaceId: identity.workspaceId,
        candidateId,
        status: openJobs.length ? 'running' : 'no_open_jobs',
        jobsScanned: 0,
        reason: openJobs.length ? undefined : { code: 'NO_OPEN_JOBS', message: 'No open jobs are available.' },
        completedAt: openJobs.length ? undefined : new Date(),
      },
    });
    if (!openJobs.length) {
      await this.db.candidate.update({ where: { id: candidateId }, data: { lastMatchedAt: new Date() } });
      return serializeRun(run);
    }
    if (!candidate.profiles[0]) {
      const failed = await this.db.jobDiscoveryRun.update({
        where: { id: run.id },
        data: {
          status: 'insufficient_data',
          jobsScanned: 0,
          reason: { code: 'PROFILE_NOT_READY', message: 'Candidate profile parsing has not completed.' },
          completedAt: new Date(),
        },
      });
      return serializeRun(failed);
    }
    const result = await this.evaluateCandidateAgainstJobs(identity, candidate, openJobs, run.id);
    await this.db.candidate.update({ where: { id: candidateId }, data: { lastMatchedAt: new Date() } });
    return serializeRun(result.run);
  }

  async matchJob(identity: Identity, jobId: string) {
    const job = await this.db.job.findFirst({
      where: { id: jobId, workspaceId: identity.workspaceId, status: 'open' },
      include: { criteriaVersions: { where: { status: 'confirmed' }, orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!job) throw new NotFoundException({ code: 'NOT_FOUND' });
    if (!job.criteriaVersions[0]) throw new BadRequestException({ code: 'CRITERIA_NOT_CONFIRMED' });
    const candidates = await this.db.candidate.findMany({
      where: { workspaceId: identity.workspaceId, libraryStatus: 'available' },
      include: { profiles: { orderBy: { version: 'desc' }, take: 1 } },
    });
    const summaries = [];
    for (const candidate of candidates) {
      const run = await this.db.jobDiscoveryRun.create({
        data: {
          workspaceId: identity.workspaceId,
          candidateId: candidate.id,
          jobId: job.id,
          status: 'running',
        },
      });
      const result = await this.matchCandidateForJob(identity, candidate, job, run.id);
      const completed = await this.db.jobDiscoveryRun.update({
        where: { id: run.id },
        data: {
          status: result.status,
          jobsScanned: 1,
          completedAt: new Date(),
          reason: result.status === 'no_match' ? { code: 'NO_MATCH', message: 'No current match for this role.' } : undefined,
        },
      });
      summaries.push({ ...result, run: completed });
    }
    return {
      jobId,
      status: summaries.some((item) => item.status === 'recommendations_ready') ? 'recommendations_ready' : 'no_match',
      candidatesScanned: candidates.length,
      recommendationsCreated: summaries.reduce((sum, item) => sum + item.recommendationsCreated, 0),
    };
  }

  async listCandidateRecommendations(identity: Identity, candidateId: string) {
    const candidate = await this.db.candidate.findFirst({ where: { id: candidateId, workspaceId: identity.workspaceId }, select: { id: true } });
    if (!candidate) throw new NotFoundException({ code: 'NOT_FOUND' });
    const recommendations = await this.db.candidateJobRecommendation.findMany({
      where: { workspaceId: identity.workspaceId, candidateId },
      orderBy: { createdAt: 'desc' },
    });
    return recommendations.map(toFrontendRecommendation);
  }

  async dismiss(identity: Identity, id: string) {
    return this.updateRecommendation(identity, id, 'dismissed');
  }

  async defer(identity: Identity, id: string) {
    return this.updateRecommendation(identity, id, 'deferred');
  }

  async createManual(identity: Identity, candidateId: string, jobId: string) {
    const [candidate, job] = await Promise.all([
      this.db.candidate.findFirst({ where: { id: candidateId, workspaceId: identity.workspaceId }, select: { id: true } }),
      this.db.job.findFirst({ where: { id: jobId, workspaceId: identity.workspaceId }, select: { id: true, status: true } }),
    ]);
    if (!candidate || !job) throw new NotFoundException({ code: 'NOT_FOUND' });
    if (job.status !== 'open') throw new BadRequestException({ code: 'JOB_NOT_OPEN' });
    const evaluation = await this.db.preLinkMatchEvaluation.create({
      data: {
        workspaceId: identity.workspaceId,
        candidateId,
        jobId,
        criteriaVersion: 0,
        status: 'manual',
        coverage: 0,
        overallScore: null,
        rationale: 'Added manually by a recruiter or hiring manager.',
        gaps: [],
        evidence: [],
      },
    });
    const recommendation = await this.db.candidateJobRecommendation.create({
      data: {
        workspaceId: identity.workspaceId,
        candidateId,
        jobId,
        prelinkEvaluationId: evaluation.id,
        confidence: 0.5,
        rationale: evaluation.rationale,
        gaps: [],
        proposalSource: 'manual',
      },
    });
    return toFrontendRecommendation(recommendation);
  }

  private async evaluateCandidateAgainstJobs(identity: Identity, candidate: CandidateForMatch, jobs: JobForMatch[], runId: string) {
    let recommendationsCreated = 0;
    for (const job of jobs) {
      const result = await this.matchCandidateForJob(identity, candidate, job, runId);
      recommendationsCreated += result.recommendationsCreated;
    }
    const recommendations = await this.db.candidateJobRecommendation.count({ where: { discoveryRunId: runId } });
    const run = await this.db.jobDiscoveryRun.update({
      where: { id: runId },
      data: {
        status: recommendations ? 'recommendations_ready' : 'no_match',
        jobsScanned: jobs.length,
        reason: recommendations ? undefined : { code: 'NO_MATCH', message: 'No current open role met the local matching threshold.' },
        completedAt: new Date(),
      },
    });
    return { run, recommendationsCreated };
  }

  private async matchCandidateForJob(identity: Identity, candidate: CandidateForMatch, job: JobForMatch, runId?: string) {
    const profile = candidate.profiles?.[0];
    const criteria = job.criteriaVersions?.[0];
    if (!criteria || !profile) return { status: 'insufficient_data', recommendationsCreated: 0 };
    const requirements = asArray(criteria.requirements);
    const dimensions = asArray(criteria.dimensions);
    const corpus = profileCorpus(profile);
    const matched = requirements.filter((requirement) => requirementMatches(requirement, corpus));
    const gaps = requirements
      .filter((requirement) => !requirementMatches(requirement, corpus))
      .map((requirement) => String(requirement.label || 'Unknown requirement'));
    const coverage = dimensions.length ? Math.min(1, 0.5 + matched.length / Math.max(requirements.length, 1) / 2) : 0;
    const overallScore = requirements.length ? Math.round((matched.length / requirements.length) * 100) : 50;
    const status = overallScore >= 35 ? 'recommendations_ready' : 'no_match';
    if (runId && status === 'recommendations_ready') {
      await this.db.candidateJobRecommendation.updateMany({
        where: { workspaceId: identity.workspaceId, candidateId: candidate.id, jobId: job.id, status: 'proposed' },
        data: { status: 'stale', staleReason: 'Replaced by a newer discovery run.' },
      });
      const evaluation = await this.db.preLinkMatchEvaluation.create({
        data: {
          workspaceId: identity.workspaceId,
          candidateId: candidate.id,
          jobId: job.id,
          discoveryRunId: runId,
          profileVersion: profile.version,
          criteriaVersion: criteria.version,
          status: 'completed',
          overallScore,
          coverage,
          rationale: `Local evidence matcher found ${matched.length} of ${requirements.length || 0} listed requirements.`,
          gaps,
          evidence: matched.map((item) => ({ requirementId: String(item.id || ''), label: String(item.label || '') })),
        },
      });
      await this.db.candidateJobRecommendation.create({
        data: {
          workspaceId: identity.workspaceId,
          candidateId: candidate.id,
          jobId: job.id,
          prelinkEvaluationId: evaluation.id,
          discoveryRunId: runId,
          confidence: Math.round((overallScore / 100) * 100) / 100,
          rationale: evaluation.rationale,
          gaps,
          proposalSource: 'local_rule',
        },
      });
    }
    return { status, recommendationsCreated: runId && status === 'recommendations_ready' ? 1 : 0 };
  }

  private async updateRecommendation(identity: Identity, id: string, status: 'dismissed' | 'deferred') {
    const recommendation = await this.db.candidateJobRecommendation.findFirst({ where: { id, workspaceId: identity.workspaceId } });
    if (!recommendation) throw new NotFoundException({ code: 'NOT_FOUND' });
    return toFrontendRecommendation(await this.db.candidateJobRecommendation.update({ where: { id }, data: { status } }));
  }
}

function asArray(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function profileCorpus(profile: ProfileForMatch) {
  const skills = asArray(profile.skills).map((item) => String(item.name || '').toLowerCase());
  const workAuth = String(asRecord(profile.workAuthorization)?.value || '').toLowerCase();
  const location = String(asRecord(profile.location)?.value || '').toLowerCase();
  return `${skills.join(' ')} ${workAuth} ${location}`.toLowerCase();
}

function requirementMatches(requirement: JsonRecord, corpus: string) {
  const tokens = String(requirement.label || '')
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((token) => token.length > 3 && !['with', 'experience', 'years', 'professional', 'authorized', 'work'].includes(token));
  if (!tokens.length) return false;
  return tokens.some((token) => corpus.includes(token));
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function toFrontendRecommendation(recommendation: {
  id: string;
  candidateId: string;
  jobId: string;
  status: string;
  createdAt: Date;
  confidence: number;
  rationale: string;
  gaps: unknown;
  staleReason: string | null;
  proposalSource: string;
  applicationRef: string | null;
}) {
  return {
    id: recommendation.id,
    candidateId: recommendation.candidateId,
    jobId: recommendation.jobId,
    status: recommendation.status,
    createdAt: recommendation.createdAt.toISOString(),
    confidence: recommendation.confidence,
    rationale: recommendation.rationale,
    gaps: asArray(recommendation.gaps).map(String),
    staleReason: recommendation.staleReason || undefined,
    proposalSource: recommendation.proposalSource,
    applicationRef: recommendation.applicationRef || undefined,
  };
}

function serializeRun(run: {
  id: string;
  status: string;
  jobsScanned: number;
  reason: unknown;
  createdAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: run.id,
    status: run.status,
    jobsScanned: run.jobsScanned,
    reason: typeof run.reason === 'object' && run.reason && 'message' in run.reason
      ? String((run.reason as { message?: unknown }).message || '')
      : typeof run.reason === 'string' ? run.reason : undefined,
    lastRunAt: (run.completedAt || run.createdAt).toISOString(),
  };
}
