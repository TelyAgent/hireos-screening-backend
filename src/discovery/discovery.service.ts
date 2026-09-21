import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../persistence/prisma.service';
import type { Identity } from '../auth/workspace.guard';
import { AiMatcherService, AiMatchError, type JobDimensionInput, type JobRequirementInput } from './ai-matcher.service';

const AUTO_MATCH_JOB = 'job_discovery_match';
const AUTO_MATCH_LEASE_MS = 120_000;
const RECOMMENDATION_THRESHOLD = 35;

type JsonRecord = Record<string, unknown>;
type ProfileForMatch = {
  version: number;
  skills: unknown;
  workAuthorization: unknown;
  location: unknown;
  employmentHistory: unknown;
  education: unknown;
};
type CandidateForMatch = {
  id: string;
  displayName: string;
  profiles: ProfileForMatch[];
  resumeVersions: { material: { text: string } }[];
};
type CriteriaForMatch = { version: number; requirements: unknown; dimensions: unknown };
type JobForMatch = { id: string; title: string; team: string; seniority: string; location: string; criteriaVersions: CriteriaForMatch[] };

const CANDIDATE_MATCH_INCLUDE = {
  profiles: { orderBy: { version: 'desc' as const }, take: 1 },
  resumeVersions: {
    where: { isLatest: true },
    take: 1,
    include: { material: { select: { text: true } } },
  },
};

@Injectable()
export class DiscoveryService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof globalThis.setInterval>;
  private running = false;

  constructor(
    private readonly db: PrismaService,
    private readonly aiMatcher: AiMatcherService,
  ) {}

  onModuleInit() {
    this.timer = globalThis.setInterval(() => void this.processQueuedMatchJobs(), 250);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) globalThis.clearInterval(this.timer);
  }

  // Called right after a resume finishes parsing (PRD: matching is automatic, not a
  // button the recruiter has to remember to click). Runs through the same durable job
  // queue every other async step in this service uses, so a slow or failing AI call
  // never blocks the resume-parse worker that triggered it.
  async enqueueAutoMatch(workspaceId: string, candidateId: string) {
    await this.db.processingJob.create({
      data: { workspaceId, candidateId, type: AUTO_MATCH_JOB, input: { candidateId } },
    });
  }

  async matchCandidate(identity: Identity, candidateId: string) {
    const activeJob = await this.db.processingJob.findFirst({
      where: { workspaceId: identity.workspaceId, candidateId, type: AUTO_MATCH_JOB, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    if (activeJob) {
      throw new ConflictException({ code: 'MATCH_IN_PROGRESS', message: 'A matching run is already in progress for this candidate.' });
    }
    const candidate = await this.db.candidate.findFirst({
      where: { id: candidateId, workspaceId: identity.workspaceId },
      include: CANDIDATE_MATCH_INCLUDE,
    });
    if (!candidate) throw new NotFoundException({ code: 'NOT_FOUND' });
    return serializeRun(await this.runMatchForCandidate(identity.workspaceId, candidate));
  }

  // Single source of truth for "is a match already in flight for this candidate" --
  // covers both the queued-but-unclaimed window and the actively-running window, so
  // callers (candidate detail, library list) can disable manual re-match controls
  // instead of racing the background auto-match queue.
  async getMatchingStatuses(workspaceId: string, candidateIds: string[]) {
    type LastRun = { status: string; jobsScanned: number; reason: unknown; lastRunAt: string; completedAt: string | null };
    const result = new Map<string, { isMatching: boolean; lastRun: LastRun | null }>();
    if (!candidateIds.length) return result;
    const [activeJobs, lastRuns] = await Promise.all([
      this.db.processingJob.findMany({
        where: { workspaceId, type: AUTO_MATCH_JOB, candidateId: { in: candidateIds }, status: { in: ['queued', 'running'] } },
        select: { candidateId: true },
      }),
      this.db.jobDiscoveryRun.findMany({
        where: { workspaceId, candidateId: { in: candidateIds } },
        orderBy: { createdAt: 'desc' },
        distinct: ['candidateId'],
        select: { candidateId: true, status: true, jobsScanned: true, reason: true, createdAt: true, completedAt: true },
      }),
    ]);
    const activeSet = new Set(activeJobs.map((j) => j.candidateId).filter((id): id is string => Boolean(id)));
    const lastRunMap = new Map(lastRuns.map((r) => [r.candidateId, r]));
    for (const id of candidateIds) {
      const run = lastRunMap.get(id);
      result.set(id, {
        isMatching: activeSet.has(id),
        lastRun: run
          ? {
              status: run.status,
              jobsScanned: run.jobsScanned,
              reason: run.reason,
              lastRunAt: run.createdAt.toISOString(),
              completedAt: run.completedAt?.toISOString() ?? null,
            }
          : null,
      });
    }
    return result;
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
      include: CANDIDATE_MATCH_INCLUDE,
    });
    const summaries = [];
    for (const candidate of candidates) {
      const run = await this.db.jobDiscoveryRun.create({
        data: { workspaceId: identity.workspaceId, candidateId: candidate.id, jobId: job.id, status: 'running' },
      });
      const result = await this.matchCandidateForJob(identity.workspaceId, candidate, job, run.id);
      const completed = await this.db.jobDiscoveryRun.update({
        where: { id: run.id },
        data: {
          status: result.status,
          jobsScanned: 1,
          completedAt: new Date(),
          reason: reasonFor(result.status),
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

  async listJobRecommendations(identity: Identity, jobId: string) {
    const job = await this.db.job.findFirst({ where: { id: jobId, workspaceId: identity.workspaceId }, select: { id: true } });
    if (!job) throw new NotFoundException({ code: 'NOT_FOUND' });
    const recommendations = await this.db.candidateJobRecommendation.findMany({
      where: { workspaceId: identity.workspaceId, jobId, status: 'proposed' },
      orderBy: { createdAt: 'desc' },
      include: { candidate: { select: { displayName: true } } },
    });
    return recommendations.map((r) => ({ ...toFrontendRecommendation(r), candidateName: r.candidate.displayName }));
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

  private async processQueuedMatchJobs() {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const job = await this.db.processingJob.findFirst({
        where: {
          type: AUTO_MATCH_JOB,
          OR: [
            { status: 'queued', nextRunAt: { lte: now } },
            { status: 'running', leaseUntil: { lt: now } },
          ],
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!job) return;
      const leaseToken = randomUUID();
      const claimed = await this.db.processingJob.updateMany({
        where: { id: job.id, status: job.status },
        data: { status: 'running', attempt: { increment: 1 }, leaseToken, leaseUntil: new Date(Date.now() + AUTO_MATCH_LEASE_MS) },
      });
      if (claimed.count !== 1) return;
      await this.processClaimedMatchJob(job.id, leaseToken);
    } finally {
      this.running = false;
    }
  }

  private async processClaimedMatchJob(jobId: string, leaseToken: string) {
    const job = await this.db.processingJob.findFirst({ where: { id: jobId, leaseToken } });
    if (!job || !job.candidateId) return;
    try {
      const candidate = await this.db.candidate.findFirst({
        where: { id: job.candidateId, workspaceId: job.workspaceId },
        include: CANDIDATE_MATCH_INCLUDE,
      });
      if (!candidate) throw new Error('CANDIDATE_NOT_FOUND');
      await this.runMatchForCandidate(job.workspaceId, candidate);
      await this.db.processingJob.update({ where: { id: job.id }, data: { status: 'succeeded', leaseToken: null, leaseUntil: null } });
    } catch (error) {
      await this.db.processingJob.update({
        where: { id: job.id },
        data: { status: 'failed', errorCode: error instanceof Error ? error.message.slice(0, 100) : 'MATCH_FAILED', leaseToken: null, leaseUntil: null },
      });
    }
  }

  private async runMatchForCandidate(workspaceId: string, candidate: CandidateForMatch) {
    const openJobs = await this.db.job.findMany({
      where: { workspaceId, status: 'open' },
      include: { criteriaVersions: { where: { status: 'confirmed' }, orderBy: { version: 'desc' }, take: 1 } },
    });
    const run = await this.db.jobDiscoveryRun.create({
      data: {
        workspaceId,
        candidateId: candidate.id,
        status: openJobs.length ? 'running' : 'no_open_jobs',
        jobsScanned: 0,
        reason: openJobs.length ? undefined : { code: 'NO_OPEN_JOBS', message: 'No open jobs are available.' },
        completedAt: openJobs.length ? undefined : new Date(),
      },
    });
    if (!openJobs.length) {
      await this.db.candidate.update({ where: { id: candidate.id }, data: { lastMatchedAt: new Date() } });
      return run;
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
      return failed;
    }
    const result = await this.evaluateCandidateAgainstJobs(workspaceId, candidate, openJobs, run.id);
    await this.db.candidate.update({ where: { id: candidate.id }, data: { lastMatchedAt: new Date() } });
    return result.run;
  }

  private async evaluateCandidateAgainstJobs(workspaceId: string, candidate: CandidateForMatch, jobs: JobForMatch[], runId: string) {
    let recommendationsCreated = 0;
    let anyFailed = false;
    for (const job of jobs) {
      const result = await this.matchCandidateForJob(workspaceId, candidate, job, runId);
      recommendationsCreated += result.recommendationsCreated;
      if (result.status === 'failed') anyFailed = true;
    }
    // A run-level AI failure must stay visibly distinct from "no open role fit" -- folding
    // it into no_match would tell a recruiter "we checked, nothing matched" when the truth
    // is "we couldn't check at all". Only report failed once nothing else redeems the run.
    const status = recommendationsCreated
      ? 'recommendations_ready'
      : anyFailed ? 'failed' : 'no_match';
    const run = await this.db.jobDiscoveryRun.update({
      where: { id: runId },
      data: { status, jobsScanned: jobs.length, reason: reasonFor(status), completedAt: new Date() },
    });
    return { run, recommendationsCreated };
  }

  private async matchCandidateForJob(
    workspaceId: string,
    candidate: CandidateForMatch,
    job: JobForMatch,
    runId?: string,
  ): Promise<{ status: string; recommendationsCreated: number }> {
    const profile = candidate.profiles?.[0];
    const criteria = job.criteriaVersions?.[0];
    if (!criteria || !profile) return { status: 'insufficient_data', recommendationsCreated: 0 };

    const requirements = asArray(criteria.requirements) as unknown as JobRequirementInput[];
    const dimensions = asArray(criteria.dimensions) as unknown as JobDimensionInput[];
    const resumeText = buildResumeText(candidate, profile);

    let evaluation: {
      overallScore: number;
      coverage: number;
      confidence: number;
      rationale: string;
      gaps: string[];
      evidence: Prisma.InputJsonValue;
      proposalSource: string;
    };

    if (this.aiMatcher.isConfigured() && resumeText) {
      try {
        const ai = await this.aiMatcher.evaluate({
          jobTitle: job.title,
          jobTeam: job.team,
          jobSeniority: job.seniority,
          jobLocation: job.location,
          requirements,
          dimensions,
          resumeText,
        });
        evaluation = {
          overallScore: ai.overallScore,
          coverage: ai.coverage,
          confidence: ai.confidence,
          rationale: ai.rationale,
          gaps: ai.gaps,
          evidence: ai.requirementFindings
            .filter((f) => f.met)
            .map((f) => ({ requirementId: f.requirementId, evidence: f.evidence })),
          proposalSource: 'ai',
        };
      } catch (error) {
        const detail = error instanceof AiMatchError ? error.message : 'AI_REQUEST_FAILED';
        console.error(`[DiscoveryService] AI match failed for candidate ${candidate.id} / job ${job.id}: ${detail}`);
        return { status: 'failed', recommendationsCreated: 0 };
      }
    } else {
      evaluation = localRuleMatch(requirements, dimensions, profile);
    }

    const status = evaluation.overallScore >= RECOMMENDATION_THRESHOLD ? 'recommendations_ready' : 'no_match';
    if (runId && status === 'recommendations_ready') {
      await this.db.candidateJobRecommendation.updateMany({
        where: { workspaceId, candidateId: candidate.id, jobId: job.id, status: 'proposed' },
        data: { status: 'stale', staleReason: 'Replaced by a newer discovery run.' },
      });
      const persistedEvaluation = await this.db.preLinkMatchEvaluation.create({
        data: {
          workspaceId,
          candidateId: candidate.id,
          jobId: job.id,
          discoveryRunId: runId,
          profileVersion: profile.version,
          criteriaVersion: criteria.version,
          status: 'completed',
          overallScore: evaluation.overallScore,
          coverage: evaluation.coverage,
          rationale: evaluation.rationale,
          gaps: evaluation.gaps,
          evidence: evaluation.evidence,
        },
      });
      await this.db.candidateJobRecommendation.create({
        data: {
          workspaceId,
          candidateId: candidate.id,
          jobId: job.id,
          prelinkEvaluationId: persistedEvaluation.id,
          discoveryRunId: runId,
          confidence: Math.round(evaluation.confidence * 100) / 100,
          rationale: evaluation.rationale,
          gaps: evaluation.gaps,
          proposalSource: evaluation.proposalSource,
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

// Used only when no AI provider is configured, so the feature still works (at reduced
// quality) in environments without an API key -- e.g. this repo checked out fresh.
function localRuleMatch(requirements: JobRequirementInput[], dimensions: JobDimensionInput[], profile: ProfileForMatch) {
  const corpus = profileCorpus(profile);
  const matched = requirements.filter((requirement) => requirementMatches(requirement, corpus));
  const gaps = requirements.filter((requirement) => !requirementMatches(requirement, corpus)).map((r) => r.label || 'Unknown requirement');
  const coverage = dimensions.length ? Math.min(1, 0.5 + matched.length / Math.max(requirements.length, 1) / 2) : 0;
  const overallScore = requirements.length ? Math.round((matched.length / requirements.length) * 100) : 50;
  return {
    overallScore,
    coverage,
    confidence: 0.4,
    rationale: `Local keyword matcher found ${matched.length} of ${requirements.length || 0} listed requirements.`,
    gaps,
    evidence: matched.map((item) => ({ requirementId: String(item.id || ''), label: String(item.label || '') })),
    proposalSource: 'local_rule',
  };
}

function reasonFor(status: string): Prisma.InputJsonValue | undefined {
  if (status === 'no_match') return { code: 'NO_MATCH', message: 'No current open role met the matching threshold.' };
  if (status === 'failed') return { code: 'AI_MATCH_FAILED', message: 'The AI matcher could not complete this run. Retry matching.' };
  return undefined;
}

function asArray(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function asAnyArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function skillNames(skills: unknown): string[] {
  return asAnyArray(skills)
    .map((item) => (item && typeof item === 'object' && 'name' in item ? String((item as JsonRecord).name || '') : String(item)))
    .filter(Boolean);
}

function profileCorpus(profile: ProfileForMatch) {
  const skills = skillNames(profile.skills).map((s) => s.toLowerCase());
  const workAuth = String(asRecord(profile.workAuthorization)?.value || '').toLowerCase();
  const location = String(asRecord(profile.location)?.value || '').toLowerCase();
  const employmentText = employmentHistoryText(profile.employmentHistory).toLowerCase();
  return `${skills.join(' ')} ${workAuth} ${location} ${employmentText}`.toLowerCase();
}

function employmentHistoryText(employmentHistory: unknown): string {
  return asAnyArray(employmentHistory)
    .map((entry) => {
      const record = asRecord(entry);
      if (!record) return '';
      const achievements = asAnyArray(record.achievements).map(String).join(' ');
      return [record.company, record.title, achievements].filter(Boolean).join(' ');
    })
    .filter(Boolean)
    .join(' ');
}

/**
 * Manually pasted candidates have no uploaded resume material — the closest thing
 * to resume text is the free-form background notes captured as employment history.
 * Without this fallback the AI matcher never runs for them (resumeText gate below).
 */
function buildResumeText(candidate: CandidateForMatch, profile?: ProfileForMatch): string {
  const materialText = candidate.resumeVersions[0]?.material.text || '';
  if (materialText.trim()) return materialText;
  if (!profile) return '';
  const skills = skillNames(profile.skills);
  const education = asAnyArray(profile.education).map((item) => String(asRecord(item)?.statement || '')).filter(Boolean);
  const employment = employmentHistoryText(profile.employmentHistory);
  const parts = [
    `候选人：${candidate.displayName}`,
    skills.length ? `技能：${skills.join('、')}` : '',
    employment ? `工作背景：${employment}` : '',
    education.length ? `教育经历：${education.join('；')}` : '',
  ].filter(Boolean);
  return parts.join('\n');
}

function requirementMatches(requirement: JobRequirementInput, corpus: string) {
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
