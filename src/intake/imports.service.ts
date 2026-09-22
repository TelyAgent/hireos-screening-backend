import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { decodeOriginalFileName, MaterialsService } from './materials.service';
import { PrismaService } from '../persistence/prisma.service';
import type { Identity } from '../auth/workspace.guard';
import { CoreRecordClient } from '../core-record/core-record.client';
import type { ImportChannel } from './imports.types';
import { ProfilesService } from '../profiles/profiles.service';

type MulterFile = Express.Multer.File;

const TERMINAL_ITEM_STATUSES = new Set(['completed', 'duplicate', 'needs_review', 'failed', 'cancelled']);
const RETRYABLE_ITEM_STATUSES = new Set(['failed']);
const CANDIDATE_CREATION_JOB = 'import_candidate_creation';
const CANDIDATE_CREATION_LEASE_MS = 60_000;

type CandidateCreationJobInput = {
  operationId: string;
  batchId: string;
  itemId: string;
  channel: ImportChannel;
  actorId: string;
};

@Injectable()
export class ImportsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof globalThis.setInterval>;
  private running = false;

  constructor(
    private readonly db: PrismaService,
    private readonly materials: MaterialsService,
    private readonly profiles: ProfilesService,
    private readonly coreRecord: CoreRecordClient,
  ) {}

  onModuleInit() {
    this.timer = globalThis.setInterval(() => void this.processQueuedCandidateJobs(), 250);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) globalThis.clearInterval(this.timer);
  }

  async createBatch(
    identity: Identity,
    files: MulterFile[],
    channel: ImportChannel = 'manual_upload',
    idempotencyKey?: string,
  ) {
    if (!files?.length) throw new NotFoundException({ code: 'NO_FILES' });

    if (idempotencyKey) {
      const existing = await this.db.ingestionOperation.findFirst({
        where: { workspaceId: identity.workspaceId, idempotencyKey },
        include: { batch: true },
      });
      if (existing?.batch) return this.getBatch(identity.workspaceId, existing.batch.id);
    }

    const operation = await this.db.ingestionOperation.create({
      data: {
        workspaceId: identity.workspaceId,
        kind: 'resume_import',
        createdBy: identity.actorId,
        idempotencyKey,
        batch: { create: { workspaceId: identity.workspaceId, createdBy: identity.actorId } },
      },
      include: { batch: true },
    });
    const batch = operation.batch;
    if (!batch) throw new BadRequestException({ code: 'BATCH_CREATE_FAILED' });

    await this.recordActivity({
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      operationId: operation.id,
      importBatchId: batch.id,
      action: 'import_batch_created',
      stage: 'received',
      status: 'processing',
      metadata: { channel, fileCount: files.length },
    });

    for (const file of files) {
      const item = await this.db.importItem.create({
        data: {
          batchId: batch.id,
          workspaceId: identity.workspaceId,
          fileName: decodeOriginalFileName(file.originalname),
          sizeKB: Math.max(1, Math.round(file.size / 1024)),
          outcome: 'received',
          stage: 'received',
          status: 'processing',
          attemptCount: 1,
          lastAttemptAt: new Date(),
        },
      });
      await this.processOne(identity, operation.id, batch.id, item.id, file, channel);
    }

    return this.finalizeBatch(identity.workspaceId, identity.actorId, operation.id, batch.id);
  }

  async getBatch(workspaceId: string, id: string) {
    const batch = await this.db.importBatch.findFirst({
      where: { id, workspaceId },
      include: { items: { orderBy: { createdAt: 'asc' } }, operation: true },
    });
    if (!batch) throw new NotFoundException({ code: 'NOT_FOUND' });
    return {
      id: batch.id,
      operationId: batch.operationId ?? undefined,
      createdAt: batch.createdAt.toISOString(),
      status: batch.status,
      items: batch.items.map(serializeItem),
    };
  }

  async retryBatch(identity: Identity, id: string) {
    const batch = await this.db.importBatch.findFirst({
      where: { id, workspaceId: identity.workspaceId },
      include: { items: true },
    });
    if (!batch) throw new NotFoundException({ code: 'NOT_FOUND' });
    const retryable = batch.items.filter((item) => RETRYABLE_ITEM_STATUSES.has(item.status) && item.retryable && item.materialId);
    if (!retryable.length) throw new BadRequestException({ code: 'NO_RETRYABLE_ITEMS' });
    for (const item of retryable) await this.retryItem(identity, item.id);
    return this.finalizeBatch(identity.workspaceId, identity.actorId, batch.operationId || '', batch.id);
  }

  async retryItem(identity: Identity, id: string) {
    const item = await this.db.importItem.findFirst({
      where: { id, workspaceId: identity.workspaceId },
      include: { batch: true, material: true },
    });
    if (!item) throw new NotFoundException({ code: 'NOT_FOUND' });
    if (!RETRYABLE_ITEM_STATUSES.has(item.status) || !item.retryable || !item.material) {
      throw new BadRequestException({ code: 'ITEM_NOT_RETRYABLE', status: item.status });
    }
    const operationId = item.batch.operationId;
    if (!operationId) throw new BadRequestException({ code: 'OPERATION_NOT_FOUND' });
    await this.db.importItem.update({
      where: { id: item.id },
      data: {
        status: 'processing',
        stage: 'candidate_creation',
        outcome: 'retrying',
        errorCode: null,
        errorMessage: null,
        retryable: false,
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
        completedAt: null,
      },
    });
    await this.enqueueCandidateCreation(identity, operationId, item.batchId, item.id, item.material, 'manual_upload');
    return this.getBatch(identity.workspaceId, item.batchId);
  }

  async cancelBatch(identity: Identity, id: string) {
    const batch = await this.db.importBatch.findFirst({
      where: { id, workspaceId: identity.workspaceId },
    });
    if (!batch) throw new NotFoundException({ code: 'NOT_FOUND' });
    await this.db.$transaction([
      this.db.importItem.updateMany({
        where: { batchId: id, workspaceId: identity.workspaceId, status: 'processing' },
        data: { status: 'cancelled', outcome: 'cancelled', completedAt: new Date(), retryable: false },
      }),
      this.db.importBatch.update({ where: { id }, data: { status: 'cancelled' } }),
      ...(batch.operationId ? [
        this.db.ingestionOperation.update({
          where: { id: batch.operationId },
          data: { status: 'cancelled', completedAt: new Date() },
        }),
      ] : []),
    ]);
    await this.recordActivity({
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      operationId: batch.operationId ?? undefined,
      importBatchId: batch.id,
      action: 'import_batch_cancelled',
      stage: 'cancelled',
      status: 'cancelled',
      metadata: {},
    });
    return this.getBatch(identity.workspaceId, id);
  }

  async activity(workspaceId: string, batchId: string) {
    const batch = await this.db.importBatch.findFirst({ where: { id: batchId, workspaceId } });
    if (!batch) throw new NotFoundException({ code: 'NOT_FOUND' });
    const events = await this.db.activityEvent.findMany({
      where: { workspaceId, importBatchId: batchId },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    return events.map((event) => ({
      id: event.id,
      action: event.action,
      stage: event.stage,
      status: event.status,
      actorId: event.actorId,
      metadata: event.metadata,
      createdAt: event.createdAt.toISOString(),
    }));
  }

  async unifiedIntake(workspaceId: string) {
    const items = await this.db.importItem.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { batch: true },
    });
    const candidateIds = items.map((item) => item.candidateId).filter((id): id is string => Boolean(id));
    const candidates = await this.db.candidate.findMany({
      where: { workspaceId, id: { in: candidateIds } },
      select: { id: true, displayName: true },
    });
    const candidateNames = new Map(candidates.map((candidate) => [candidate.id, candidate.displayName]));
    return items.map((item) => ({
      at: item.createdAt.toISOString(),
      label: item.fileName,
      source: item.batch.createdBy === 'local-screening-user' ? 'Manual upload' : item.batch.createdBy,
      status: item.status === 'completed' ? 'Processed' : item.status === 'needs_review' ? 'Needs review' : 'Pending',
      stage: item.stage,
      errorCode: item.errorCode ?? undefined,
      candidateId: item.candidateId ?? undefined,
      candidateName: item.candidateId ? candidateNames.get(item.candidateId) : undefined,
    }));
  }

  private async processOne(
    identity: Identity,
    operationId: string,
    batchId: string,
    itemId: string,
    file: MulterFile,
    channel: ImportChannel,
  ) {
    try {
      await this.updateItem(identity, operationId, batchId, itemId, { stage: 'validating', outcome: 'validating' });
      const saved = await this.materials.saveUpload(identity, file, channel);
      await this.processSavedMaterial(identity, operationId, batchId, itemId, saved, channel);
    } catch (error) {
      await this.failItem(identity, operationId, batchId, itemId, error);
    }
  }

  private async enqueueCandidateCreation(
    identity: Identity,
    operationId: string,
    batchId: string,
    itemId: string,
    material: Prisma.MaterialGetPayload<{}>,
    channel: ImportChannel,
  ) {
    const input: CandidateCreationJobInput = { operationId, batchId, itemId, channel, actorId: identity.actorId };
    await this.db.processingJob.create({
      data: {
        workspaceId: identity.workspaceId,
        materialId: material.id,
        type: CANDIDATE_CREATION_JOB,
        input,
      },
    });
  }

  private async processQueuedCandidateJobs() {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const job = await this.db.processingJob.findFirst({
        where: {
          type: CANDIDATE_CREATION_JOB,
          OR: [
            { status: 'queued', nextRunAt: { lte: now } },
            // Reclaim jobs whose worker died mid-flight: the lease expired without the
            // job ever reaching a terminal status, so it is safe to run again.
            { status: 'running', leaseUntil: { lt: now } },
          ],
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!job) return;
      const leaseToken = randomUUID();
      const claimed = await this.db.processingJob.updateMany({
        where: { id: job.id, status: job.status },
        data: {
          status: 'running',
          attempt: { increment: 1 },
          leaseToken,
          leaseUntil: new Date(Date.now() + CANDIDATE_CREATION_LEASE_MS),
        },
      });
      if (claimed.count !== 1) return;
      await this.processClaimedCandidateJob(job.id, leaseToken);
    } finally {
      this.running = false;
    }
  }

  private async processClaimedCandidateJob(jobId: string, leaseToken: string) {
    const job = await this.db.processingJob.findFirst({ where: { id: jobId, leaseToken } });
    if (!job || !job.materialId) return;
    const input = job.input as unknown as CandidateCreationJobInput;

    // The batch or item may have been cancelled while this job sat in the queue. Honor
    // that instead of resurrecting a cancelled item by writing a candidate into it.
    const currentItem = await this.db.importItem.findUnique({ where: { id: input.itemId }, select: { status: true } });
    if (!currentItem || currentItem.status === 'cancelled') {
      await this.db.processingJob.update({
        where: { id: job.id },
        data: { status: 'cancelled', leaseToken: null, leaseUntil: null },
      });
      return;
    }

    const identity: Identity = { workspaceId: job.workspaceId, actorId: input.actorId, roles: [] };
    const attempt = await this.db.ingestionAttempt.create({
      data: {
        operationId: input.operationId,
        importItemId: input.itemId,
        workspaceId: job.workspaceId,
        stage: 'candidate_creation',
        status: 'running',
        attempt: job.attempt,
      },
    });
    try {
      const material = await this.db.material.findUniqueOrThrow({ where: { id: job.materialId } });
      const candidate = await this.createCandidateFromMaterial(identity, material.id, material.name, input.channel);
      await this.profiles.enqueue(job.workspaceId, candidate.id, candidate.resumeVersionId, material.id);
      await this.updateItem(identity, input.operationId, input.batchId, input.itemId, {
        stage: 'profile_processing',
        status: 'completed',
        outcome: 'new_candidate',
        candidateId: candidate.id,
        businessConsumeStatus: 'completed',
        completedAt: new Date(),
      });
      await this.db.processingJob.update({
        where: { id: job.id },
        data: { status: 'succeeded', result: { candidateId: candidate.id }, leaseToken: null, leaseUntil: null },
      });
      await this.db.ingestionAttempt.update({ where: { id: attempt.id }, data: { status: 'succeeded', finishedAt: new Date() } });
    } catch (error) {
      const { code, message, retryable } = errorDetails(error);
      await this.updateItem(identity, input.operationId, input.batchId, input.itemId, {
        stage: 'failed',
        status: 'failed',
        outcome: code,
        errorCode: code,
        errorMessage: message,
        retryable,
        businessConsumeStatus: 'failed',
        completedAt: new Date(),
      });
      await this.db.processingJob.update({
        where: { id: job.id },
        data: { status: 'failed', errorCode: code, leaseToken: null, leaseUntil: null },
      });
      await this.db.ingestionAttempt.update({ where: { id: attempt.id }, data: { status: 'failed', errorCode: code, finishedAt: new Date() } });
    }
    await this.finalizeBatch(job.workspaceId, input.actorId, input.operationId, input.batchId);
  }

  private async processSavedMaterial(
    identity: Identity,
    operationId: string,
    batchId: string,
    itemId: string,
    saved: Awaited<ReturnType<MaterialsService['saveUpload']>>,
    channel: ImportChannel,
  ) {
    if (saved.kind === 'exact_file') {
      await this.db.candidateSource.create({
        data: { workspaceId: identity.workspaceId, materialId: saved.material.id, channel, receivedAt: new Date() },
      });
      await this.updateItem(identity, operationId, batchId, itemId, {
        materialId: saved.material.id,
        duplicateOfMaterialId: saved.material.id,
        stage: 'duplicate',
        status: 'duplicate',
        outcome: 'exact_file',
        businessConsumeStatus: 'skipped',
        completedAt: new Date(),
      });
      return;
    }

    const material = saved.material;
    if (material.securityStatus === 'quarantined') {
      await this.updateItem(identity, operationId, batchId, itemId, {
        materialId: material.id,
        stage: 'quarantined',
        status: 'failed',
        outcome: 'quarantined',
        errorCode: material.errorCode || 'SECURITY_QUARANTINED',
        retryable: false,
        businessConsumeStatus: 'failed',
        completedAt: new Date(),
      });
      return;
    }
    if (material.readStatus !== 'available') {
      await this.updateItem(identity, operationId, batchId, itemId, {
        materialId: material.id,
        stage: 'extracting',
        status: 'failed',
        outcome: 'parse_failed',
        errorCode: material.errorCode || 'SOURCE_MATERIAL_NOT_READY',
        retryable: false,
        businessConsumeStatus: 'failed',
        completedAt: new Date(),
      });
      return;
    }

    const signals = this.profiles.extractIdentitySignals(material.id, material.segments, displayNameFromFileName(material.name));
    const match = await this.findPossibleDuplicate(identity.workspaceId, material, signals);
    if (match) {
      const duplicate = await this.db.$transaction(async (tx) => {
        const check = await tx.duplicateCheck.create({
          data: {
            workspaceId: identity.workspaceId,
            materialId: material.id,
            kind: 'possible_same_person',
            existingCandidateId: match.candidate.id,
            confidence: match.confidence,
            basis: match.basis,
          },
        });
        await tx.candidateSource.create({
          data: { workspaceId: identity.workspaceId, materialId: material.id, channel, receivedAt: new Date() },
        });
        await tx.humanTask.create({
          data: {
            workspaceId: identity.workspaceId,
            sourceModule: 'Resume Library',
            taskType: 'duplicate_review',
            title: `Review possible duplicate: ${signals.displayName}`,
            subjectLabel: 'Confirm candidate identity before importing this resume.',
            requiredAction: 'Choose same person, different person, reuse file, or defer.',
            completionRule: { requiredResultType: 'duplicate_resolution' },
            candidateId: match.candidate.id,
            materialId: material.id,
            duplicateReviewId: check.id,
            // Single-operator dev setup: whoever uploaded the file is the only person who
            // could review it, so hand it straight to them instead of parking it in an
            // unclaimed queue nobody else will ever pick up. Once real multi-user accounts
            // exist, this should go back to an unassigned queue for the right reviewer.
            assigneeId: identity.actorId,
            queue: null,
            // Confidence drives urgency: a strong signal (matched email/phone/identical
            // text) is worth a human's attention sooner than a weak name-only guess.
            priority: match.confidence >= 0.8 ? 'high' : 'normal',
            linkRoute: `/duplicates/${check.id}`,
          },
        });
        return check;
      });
      await this.updateItem(identity, operationId, batchId, itemId, {
        materialId: material.id,
        stage: 'needs_identity_review',
        status: 'needs_review',
        outcome: 'possible_same_person',
        duplicateReviewId: duplicate.id,
        businessConsumeStatus: 'pending',
        completedAt: new Date(),
      });
      return;
    }

    // Candidate creation makes a network call to the Core Record service. That call must
    // not block the upload request, and a transient failure there must not strand the
    // item -- so this step hands off to the durable job queue (same lease/retry pattern
    // ProfilesService uses for resume parsing) instead of running inline.
    await this.updateItem(identity, operationId, batchId, itemId, {
      materialId: material.id,
      stage: 'candidate_creation',
      status: 'processing',
      outcome: 'creating_candidate',
      businessConsumeStatus: 'pending',
    });
    await this.enqueueCandidateCreation(identity, operationId, batchId, itemId, material, channel);
  }

  private async updateItem(
    identity: Identity,
    operationId: string,
    batchId: string,
    itemId: string,
    data: Prisma.ImportItemUncheckedUpdateInput,
  ) {
    const item = await this.db.importItem.update({ where: { id: itemId }, data });
    await this.recordActivity({
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      operationId,
      importBatchId: batchId,
      importItemId: itemId,
      materialId: item.materialId ?? undefined,
      candidateId: item.candidateId ?? undefined,
      action: 'import_item_updated',
      stage: item.stage,
      status: item.status,
      metadata: { outcome: item.outcome, errorCode: item.errorCode },
    });
    return item;
  }

  private async failItem(identity: Identity, operationId: string, batchId: string, itemId: string, error: unknown) {
    const { code, message, retryable } = errorDetails(error);
    await this.updateItem(identity, operationId, batchId, itemId, {
      stage: 'failed',
      status: 'failed',
      outcome: code,
      errorCode: code,
      errorMessage: message,
      retryable,
      businessConsumeStatus: 'failed',
      completedAt: new Date(),
    });
  }

  // Public on purpose: anything that changes an ImportItem's status outside this service's
  // own flow (e.g. a duplicate review being resolved) must re-run this so the batch's
  // rolled-up status doesn't go stale.
  async finalizeBatch(workspaceId: string, actorId: string, operationId: string, batchId: string) {
    const items = await this.db.importItem.findMany({ where: { batchId, workspaceId } });
    const hasProcessing = items.some((item) => !TERMINAL_ITEM_STATUSES.has(item.status));
    const hasFailure = items.some((item) => item.status === 'failed');
    const hasReview = items.some((item) => item.status === 'needs_review');
    const status = hasProcessing ? 'processing' : hasFailure || hasReview ? 'partial' : 'completed';
    await this.db.importBatch.update({ where: { id: batchId }, data: { status } });
    if (operationId) {
      await this.db.ingestionOperation.update({
        where: { id: operationId },
        data: { status, ...(status !== 'processing' ? { completedAt: new Date() } : {}) },
      });
    }
    await this.recordActivity({
      workspaceId,
      actorId,
      operationId: operationId || undefined,
      importBatchId: batchId,
      action: 'import_batch_updated',
      stage: status === 'processing' ? 'processing' : 'completed',
      status,
      metadata: { itemCount: items.length },
    });
    return this.getBatch(workspaceId, batchId);
  }

  private async recordActivity(input: {
    workspaceId: string;
    actorId: string;
    operationId?: string;
    importBatchId?: string;
    importItemId?: string;
    materialId?: string;
    candidateId?: string;
    action: string;
    stage?: string;
    status?: string;
    metadata: Prisma.InputJsonValue;
  }) {
    await this.db.activityEvent.create({ data: input });
  }

  private async createCandidateFromMaterial(identity: Identity, materialId: string, fileName: string, channel: ImportChannel) {
    const displayName = displayNameFromFileName(fileName);
    const coreCandidate = await this.coreRecord.createCandidate(
      identity,
      { displayName, source: channel },
      `screening:candidate:material:${identity.workspaceId}:${materialId}`,
    );
    return this.db.$transaction(async (tx) => {
      const candidate = await tx.candidate.create({
        data: { ...(coreCandidate?.id ? { id: coreCandidate.id } : {}), workspaceId: identity.workspaceId, displayName, ownerId: identity.actorId },
      });
      await tx.libraryEntry.create({ data: { workspaceId: identity.workspaceId, candidateId: candidate.id, ownerId: identity.actorId } });
      const resumeVersion = await tx.resumeVersion.create({
        data: { workspaceId: identity.workspaceId, candidateId: candidate.id, materialId, version: 1, source: channel, parseStatus: 'pending' },
      });
      await tx.candidateSource.create({
        data: { workspaceId: identity.workspaceId, candidateId: candidate.id, materialId, channel, receivedAt: new Date() },
      });
      await tx.auditRecord.create({
        data: {
          workspaceId: identity.workspaceId,
          actorId: identity.actorId,
          action: 'candidate_imported',
          objectType: 'Candidate',
          objectId: candidate.id,
          payload: { materialId, channel },
        },
      });
      return { id: candidate.id, resumeVersionId: resumeVersion.id };
    });
  }

  // Layered identity matching, strongest signal first. Every branch still only produces a
  // DuplicateCheck + HumanTask for a human to confirm -- nothing here ever merges a
  // candidate on its own, per the "name alone can't auto-merge" rule.
  private async findPossibleDuplicate(
    workspaceId: string,
    material: { id: string; name: string; normalizedTextHash: string | null },
    signals: { displayName: string; email: string | null; phone: string | null },
  ): Promise<{ candidate: { id: string; displayName: string }; confidence: number; basis: string[] } | null> {
    if (material.normalizedTextHash) {
      const textMatch = await this.db.material.findFirst({
        where: { workspaceId, normalizedTextHash: material.normalizedTextHash, id: { not: material.id } },
        orderBy: { createdAt: 'desc' },
        include: { resumeVersion: { include: { candidate: { select: { id: true, displayName: true } } } } },
      });
      const candidate = textMatch?.resumeVersion?.candidate;
      if (candidate) {
        return {
          candidate,
          confidence: 0.97,
          basis: [`Extracted text is identical to a file already on record for ${candidate.displayName} (different file format or bytes).`],
        };
      }
    }

    if (signals.email) {
      const candidate = await this.db.candidate.findFirst({
        where: { workspaceId, email: signals.email },
        select: { id: true, displayName: true },
      });
      if (candidate) {
        return { candidate, confidence: 0.9, basis: [`Email on the resume matches an existing candidate's email: ${signals.email}`] };
      }
    }

    if (signals.phone) {
      const phoneDigits = onlyDigits(signals.phone);
      if (phoneDigits.length >= 7) {
        const candidates = await this.db.candidate.findMany({
          where: { workspaceId, phone: { not: null } },
          select: { id: true, displayName: true, phone: true },
        });
        const match = candidates.find((candidate) => onlyDigits(candidate.phone || '') === phoneDigits);
        if (match) {
          return { candidate: match, confidence: 0.8, basis: [`Phone number on the resume matches an existing candidate's phone: ${signals.phone}`] };
        }
      }
    }

    const nameMatch = await this.findByNormalizedName(workspaceId, material.name, signals.displayName);
    if (nameMatch) {
      return {
        candidate: nameMatch,
        confidence: 0.35,
        basis: [`Name "${signals.displayName}" resembles existing candidate "${nameMatch.displayName}" -- filename/name similarity only, no email or phone confirmation.`],
      };
    }
    return null;
  }

  private async findByNormalizedName(workspaceId: string, fileName: string, parsedDisplayName: string) {
    const normalized = normalizeName(fileName) || normalizeName(parsedDisplayName);
    if (!normalized) return null;
    const candidates = await this.db.candidate.findMany({ where: { workspaceId }, select: { id: true, displayName: true } });
    return candidates.find((candidate) => {
      const current = normalizeName(candidate.displayName);
      return current === normalized || current.includes(normalized) || normalized.includes(current);
    }) ?? null;
  }
}

function onlyDigits(value: string) {
  return value.replace(/\D+/g, '');
}

function serializeItem(item: {
  id: string;
  fileName: string;
  sizeKB: number;
  outcome: string;
  stage: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  attemptCount: number;
  completedAt: Date | null;
  materialId: string | null;
  duplicateOfMaterialId: string | null;
  candidateId: string | null;
  duplicateReviewId: string | null;
  businessConsumeStatus: string;
}) {
  return {
    id: item.id,
    fileName: item.fileName,
    sizeKB: item.sizeKB,
    outcome: item.outcome,
    stage: item.stage,
    status: item.status,
    errorCode: item.errorCode ?? undefined,
    errorMessage: item.errorMessage ?? undefined,
    retryable: item.retryable,
    attemptCount: item.attemptCount,
    completedAt: item.completedAt?.toISOString(),
    materialId: item.materialId ?? undefined,
    duplicateOfMaterialId: item.duplicateOfMaterialId ?? undefined,
    candidateId: item.candidateId ?? undefined,
    duplicateReviewId: item.duplicateReviewId ?? undefined,
    businessConsumeStatus: item.businessConsumeStatus,
  };
}

// Codes below describe the file itself (wrong type, too large, empty). Re-running the
// same upload can never succeed, so these must never be marked retryable; the user has
// to supply a different file instead. Anything else is treated as a transient/operational
// failure (DB hiccup, downstream service timeout, etc.) and is safe to retry.
const NON_RETRYABLE_ERROR_CODES = new Set(['EMPTY_FILE', 'FILE_TOO_LARGE', 'UNSUPPORTED_FILE_TYPE']);

export function errorDetails(error: unknown) {
  const response = error && typeof error === 'object' && 'response' in error
    ? (error as { response?: { code?: string; message?: string } }).response
    : undefined;
  const code = String(response?.code || (error instanceof Error ? error.message : 'IMPORT_FAILED'));
  const message = String(response?.message || (error instanceof Error ? error.message : 'Import failed.'));
  return {
    code: code.slice(0, 100),
    message: message.slice(0, 500),
    retryable: !NON_RETRYABLE_ERROR_CODES.has(code),
  };
}

export function normalizeName(fileName: string) {
  return fileName
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\bresume\b|\bcv\b|v\d+/gi, '')
    .trim()
    .toLowerCase();
}

export function displayNameFromFileName(fileName: string) {
  const normalized = normalizeName(fileName);
  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase()).slice(0, 200) || 'Unnamed candidate';
}
