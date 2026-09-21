import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../persistence/prisma.service';
import type { Identity } from '../auth/workspace.guard';
import { ProfileParserService } from './profile-parser.service';
import { AiProfileParserService } from './ai-profile-parser.service';
import { DiscoveryService } from '../discovery/discovery.service';

@Injectable()
export class ProfilesService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof globalThis.setInterval>;
  private running = false;

  constructor(
    private readonly db: PrismaService,
    private readonly parser: ProfileParserService,
    private readonly aiParser: AiProfileParserService,
    private readonly discovery: DiscoveryService,
  ) {}

  onModuleInit() {
    this.timer = globalThis.setInterval(() => void this.processQueued(), 250);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) globalThis.clearInterval(this.timer);
  }

  async enqueue(workspaceId: string, candidateId: string, resumeVersionId: string, materialId: string) {
    return this.db.processingJob.create({
      data: {
        workspaceId,
        candidateId,
        resumeVersionId,
        materialId,
        type: 'resume_parse',
        input: { candidateId, resumeVersionId, materialId, parserVersion: 'local-resume-parser-v1' },
      },
    });
  }

  // Cheap, synchronous, local-only extraction of just the fields identity/duplicate
  // matching needs. This intentionally stays separate from the full async profile parse
  // (which also writes CandidateProfile/ResumeVersion state) so intake can consult it
  // before a Candidate even exists yet.
  extractIdentitySignals(materialId: string, segments: unknown, fallbackName: string) {
    const parsed = this.parser.parse(materialId, asSegments(segments), fallbackName);
    return { displayName: parsed.displayName, email: parsed.email, phone: parsed.phone, location: parsed.location?.value || null };
  }

  async getLatest(identity: Identity, candidateId: string) {
    const candidate = await this.db.candidate.findFirst({
      where: { id: candidateId, workspaceId: identity.workspaceId },
      select: { id: true },
    });
    if (!candidate) throw new NotFoundException({ code: 'NOT_FOUND' });
    return this.db.candidateProfile.findFirst({
      where: { candidateId, workspaceId: identity.workspaceId },
      orderBy: { version: 'desc' },
    });
  }

  async correct(identity: Identity, candidateId: string, raw: unknown) {
    const input = z.object({
      location: z.string().trim().max(200).optional(),
      compensationMin: z.number().finite().optional(),
      compensationMax: z.number().finite().optional(),
      reason: z.string().trim().min(1).max(1000),
    }).strict().safeParse(raw);
    if (!input.success) throw new BadRequestException({ code: 'INVALID_INPUT' });
    const candidate = await this.db.candidate.findFirst({
      where: { id: candidateId, workspaceId: identity.workspaceId },
      include: { profiles: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!candidate) throw new NotFoundException({ code: 'NOT_FOUND' });
    const current = candidate.profiles[0];
    if (!current) throw new BadRequestException({ code: 'PROFILE_NOT_READY' });
    const nextLocation = input.data.location
      ? { value: input.data.location, status: 'known', evidence: { source: 'human_correction', actorId: identity.actorId } }
      : current.location;
    const nextCompensation = input.data.compensationMin != null && input.data.compensationMax != null
      ? { min: input.data.compensationMin, max: input.data.compensationMax, currency: 'USD', period: 'year', basis: 'gross', status: 'known' }
      : current.compensationExpectation;
    const corrections = [
      ...asArray(current.corrections),
      {
        fieldPath: input.data.location ? 'location' : 'compensation_expectation',
        reason: input.data.reason,
        correctedBy: identity.actorId,
        correctedAt: new Date().toISOString(),
      },
    ];
    const profile = await this.db.$transaction(async (tx) => {
      const created = await tx.candidateProfile.create({
        data: {
          workspaceId: identity.workspaceId,
          candidateId,
          resumeVersionId: current.resumeVersionId,
          version: current.version + 1,
          parseStatus: 'succeeded',
          dataStatus: current.dataStatus,
          parserVersion: current.parserVersion,
          displayName: current.displayName,
          sourceEntries: toJson(current.sourceEntries),
          resumeVersionRefs: toJson(current.resumeVersionRefs),
          employmentHistory: toJson(current.employmentHistory),
          skills: toJson(current.skills),
          education: toJson(current.education),
          certifications: toJson(current.certifications),
          projects: toJson(current.projects),
          location: toJson(nextLocation),
          workAuthorization: toJson(current.workAuthorization),
          languages: toJson(current.languages),
          ...(nextCompensation ? { compensationExpectation: toJson(nextCompensation) } : {}),
          missingFields: toJson(asArray(current.missingFields).filter((field) => (
            field !== (input.data.location ? 'location' : 'compensation_expectation')
          ))),
          corrections: toJson(corrections),
        },
      });
      await tx.auditRecord.create({
        data: {
          workspaceId: identity.workspaceId,
          actorId: identity.actorId,
          action: 'candidate_profile_corrected',
          objectType: 'CandidateProfile',
          objectId: created.id,
          payload: { candidateId, reason: input.data.reason },
        },
      });
      return created;
    });
    return profile;
  }

  async getJob(identity: Identity, jobId: string) {
    const job = await this.db.processingJob.findFirst({
      where: { id: jobId, workspaceId: identity.workspaceId },
    });
    if (!job) throw new NotFoundException({ code: 'NOT_FOUND' });
    return serializeJob(job);
  }

  async retry(identity: Identity, jobId: string) {
    const job = await this.db.processingJob.findFirst({
      where: { id: jobId, workspaceId: identity.workspaceId },
    });
    if (!job) throw new NotFoundException({ code: 'NOT_FOUND' });
    if (job.status !== 'failed') {
      throw new BadRequestException({ code: 'JOB_NOT_RETRYABLE', status: job.status });
    }
    const retried = await this.db.processingJob.update({
      where: { id: job.id },
      data: { status: 'queued', nextRunAt: new Date(), errorCode: null, leaseToken: null, leaseUntil: null },
    });
    return serializeJob(retried);
  }

  private async processQueued() {
    if (this.running) return;
    this.running = true;
    try {
      const job = await this.db.processingJob.findFirst({
        where: {
          type: 'resume_parse',
          status: 'queued',
          nextRunAt: { lte: new Date() },
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!job) return;
      const leaseToken = randomUUID();
      const claimed = await this.db.processingJob.updateMany({
        where: { id: job.id, status: 'queued' },
        data: { status: 'running', attempt: { increment: 1 }, leaseToken, leaseUntil: new Date(Date.now() + 60_000) },
      });
      if (claimed.count !== 1) return;
      await this.processClaimed(job.id, leaseToken);
    } finally {
      this.running = false;
    }
  }

  private async processClaimed(jobId: string, leaseToken: string) {
    const job = await this.db.processingJob.findFirst({
      where: { id: jobId, leaseToken },
    });
    const materialId = job?.materialId;
    const candidateId = job?.candidateId;
    const resumeVersionId = job?.resumeVersionId;
    if (!materialId || !candidateId || !resumeVersionId) return;
    try {
      const material = await this.db.material.findUnique({ where: { id: materialId } });
      const candidate = await this.db.candidate.findUnique({ where: { id: candidateId } });
      if (!material || !candidate || material.readStatus !== 'available') {
        throw new Error('SOURCE_MATERIAL_NOT_READY');
      }
      // AI is authoritative when configured -- the local parser is a fixed English tech
      // keyword list that returns near-empty profiles for Chinese or non-engineering
      // resumes even though parseStatus says "succeeded". A genuine AI failure must
      // surface as a failed job (retryable), not silently fall back to that weak parser
      // and look successful while extracting almost nothing.
      const parsed = this.aiParser.isConfigured()
        ? await this.parseWithAi(material, candidate.displayName)
        : this.parseLocally(material, candidate.displayName);
      const profile = await this.db.$transaction(async (tx) => {
        const latest = await tx.candidateProfile.findFirst({
          where: { candidateId: candidate.id },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const created = await tx.candidateProfile.create({
          data: {
            workspaceId: job.workspaceId,
            candidateId: candidate.id,
            resumeVersionId,
            version: (latest?.version || 0) + 1,
            parseStatus: 'succeeded',
            dataStatus: parsed.missingFields.length ? 'partial' : 'complete',
            parserVersion: parsed.parserVersion,
            displayName: parsed.displayName,
            sourceEntries: parsed.sourceEntries,
            resumeVersionRefs: [job.resumeVersionId],
            employmentHistory: parsed.employmentHistory,
            skills: parsed.skills,
            education: parsed.education,
            certifications: parsed.certifications,
            projects: parsed.projects,
            location: parsed.location || { value: '', status: 'unknown' },
            workAuthorization: parsed.workAuthorization || { value: '', status: 'unknown' },
            languages: parsed.languages,
            ...(parsed.compensationExpectation ? { compensationExpectation: parsed.compensationExpectation } : {}),
            missingFields: parsed.missingFields,
            corrections: [],
          },
        });
        await tx.resumeVersion.update({
          where: { id: resumeVersionId },
          data: { parseStatus: 'succeeded' },
        });
        await tx.candidate.update({
          where: { id: candidate.id },
          data: {
            email: candidate.email || parsed.email,
            phone: candidate.phone || parsed.phone,
          },
        });
        await tx.processingJob.update({
          where: { id: job.id },
          data: {
            status: 'succeeded',
            result: { profileId: created.id, parserVersion: parsed.parserVersion, dataStatus: created.dataStatus },
            leaseToken: null,
            leaseUntil: null,
          },
        });
        return created;
      });
      // PRD: matching runs automatically once a profile exists, not on a manual button
      // press. Enqueued after commit so a slow/failing match run can never roll back or
      // block the profile that triggered it.
      await this.discovery.enqueueAutoMatch(job.workspaceId, candidate.id);
      return profile;
    } catch (error) {
      await this.db.processingJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          errorCode: error instanceof Error ? error.message : 'PROFILE_PARSE_FAILED',
          leaseToken: null,
          leaseUntil: null,
        },
      });
      await this.db.resumeVersion.updateMany({
        where: { id: resumeVersionId },
        data: { parseStatus: 'failed' },
      });
    }
  }

  private parseLocally(material: { id: string; segments: unknown }, fallbackName: string) {
    const parsed = this.parser.parse(material.id, asSegments(material.segments), fallbackName);
    return { ...parsed, parserVersion: 'local-resume-parser-v1' as const };
  }

  private async parseWithAi(material: { id: string; text: string }, fallbackName: string) {
    const ai = await this.aiParser.parse(material.text, fallbackName);
    const missingFields = [
      ...(ai.location.status === 'unknown' ? ['location'] : []),
      ...(ai.workAuthorization.status === 'unknown' ? ['work_authorization'] : []),
      ...(ai.employmentHistory.length ? [] : ['employment_history']),
      ...(ai.education.length ? [] : ['education']),
      ...(ai.compensationExpectation ? [] : ['compensation_expectation']),
    ];
    return {
      displayName: ai.displayName || fallbackName,
      email: ai.email,
      phone: ai.phone,
      location: ai.location,
      workAuthorization: ai.workAuthorization,
      skills: ai.skills,
      languages: ai.languages,
      employmentHistory: ai.employmentHistory,
      education: ai.education,
      certifications: ai.certifications,
      projects: ai.projects,
      compensationExpectation: ai.compensationExpectation ? { ...ai.compensationExpectation, status: 'known' as const } : null,
      missingFields,
      // Full-document evidence rather than the local parser's per-field line quotes -- the
      // model reads the whole resume at once instead of matching individual lines.
      sourceEntries: [{ sourceMaterialId: material.id, segmentId: 'ai-parsed', quote: material.text.slice(0, 500) }],
      parserVersion: 'ai-resume-parser-v1' as const,
    };
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value === null || value === undefined ? {} : value as Prisma.InputJsonValue;
}

function asSegments(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { id: string; text: string; page?: number } => (
    Boolean(item)
    && typeof item === 'object'
    && typeof (item as { id?: unknown }).id === 'string'
    && typeof (item as { text?: unknown }).text === 'string'
  ));
}

function serializeJob(job: {
  id: string;
  type: string;
  status: string;
  attempt: number;
  errorCode: string | null;
  result: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempt: job.attempt,
    errorCode: job.errorCode || undefined,
    result: job.result,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
