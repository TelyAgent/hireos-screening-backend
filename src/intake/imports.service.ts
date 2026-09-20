import { Injectable, NotFoundException } from '@nestjs/common';
import { MaterialsService } from './materials.service';
import { PrismaService } from '../persistence/prisma.service';
import type { Identity } from '../auth/workspace.guard';
import { CoreRecordClient } from '../core-record/core-record.client';
import type { ImportChannel } from './imports.types';
import { ProfilesService } from '../profiles/profiles.service';

type MulterFile = Express.Multer.File;

@Injectable()
export class ImportsService {
  constructor(
    private readonly db: PrismaService,
    private readonly materials: MaterialsService,
    private readonly profiles: ProfilesService,
    private readonly coreRecord: CoreRecordClient,
  ) {}

  async createBatch(identity: Identity, files: MulterFile[], channel: ImportChannel = 'manual_upload') {
    if (!files?.length) {
      throw new NotFoundException({ code: 'NO_FILES' });
    }
    const batch = await this.db.importBatch.create({
      data: {
        workspaceId: identity.workspaceId,
        createdBy: identity.actorId,
      },
    });

    const items = [];
    for (const file of files) {
      items.push(await this.processOne(identity, batch.id, file, channel));
    }
    const hasFailure = items.some((item) => ['quarantined', 'parse_failed', 'too_large', 'unsupported_type'].includes(item.outcome));
    await this.db.importBatch.update({
      where: { id: batch.id },
      data: { status: hasFailure ? 'partial' : 'completed' },
    });
    return this.getBatch(identity.workspaceId, batch.id);
  }

  async getBatch(workspaceId: string, id: string) {
    const batch = await this.db.importBatch.findFirst({
      where: { id, workspaceId },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    if (!batch) throw new NotFoundException({ code: 'NOT_FOUND' });
    return {
      id: batch.id,
      createdAt: batch.createdAt.toISOString(),
      status: batch.status,
      items: batch.items.map((item) => ({
        id: item.id,
        fileName: item.fileName,
        sizeKB: item.sizeKB,
        outcome: item.outcome,
        candidateId: item.candidateId ?? undefined,
        duplicateReviewId: item.duplicateReviewId ?? undefined,
      })),
    };
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
      status: ['new_candidate', 'exact_file'].includes(item.outcome) ? 'Processed' : 'Pending duplicate review',
      candidateId: item.candidateId ?? undefined,
      candidateName: item.candidateId ? candidateNames.get(item.candidateId) : undefined,
    }));
  }

  private async processOne(identity: Identity, batchId: string, file: MulterFile, channel: ImportChannel) {
    const sizeKB = Math.max(1, Math.round(file.size / 1024));
    let saved;
    try {
      saved = await this.materials.saveUpload(identity.workspaceId, file);
    } catch (error) {
      const outcome = this.errorToOutcome(error);
      return this.db.importItem.create({
        data: {
          batchId,
          workspaceId: identity.workspaceId,
          fileName: file.originalname,
          sizeKB,
          outcome,
        },
      });
    }

    if (saved.kind === 'exact_file') {
      await this.db.candidateSource.create({
        data: {
          workspaceId: identity.workspaceId,
          materialId: saved.material.id,
          channel,
          receivedAt: new Date(),
        },
      });
      return this.db.importItem.create({
        data: {
          batchId,
          workspaceId: identity.workspaceId,
          materialId: saved.material.id,
          fileName: file.originalname,
          sizeKB,
          outcome: 'exact_file',
        },
      });
    }

    const material = saved.material;
    if (material.readStatus !== 'available') {
      return this.db.importItem.create({
        data: {
          batchId,
          workspaceId: identity.workspaceId,
          materialId: material.id,
          fileName: material.name,
          sizeKB,
          outcome: 'parse_failed',
        },
      });
    }

    const existing = await this.findPossibleCandidate(identity.workspaceId, material.name);
    if (existing) {
      const duplicate = await this.db.$transaction(async (tx) => {
        const check = await tx.duplicateCheck.create({
          data: {
            workspaceId: identity.workspaceId,
            materialId: material.id,
            kind: 'possible_same_person',
            existingCandidateId: existing.id,
            basis: ['Similar candidate name from filename', 'Identity not automatically merged'],
          },
        });
        await tx.candidateSource.create({
          data: {
            workspaceId: identity.workspaceId,
            materialId: material.id,
            channel,
            receivedAt: new Date(),
          },
        });
        return check;
      });
      return this.db.importItem.create({
        data: {
          batchId,
          workspaceId: identity.workspaceId,
          materialId: material.id,
          fileName: material.name,
          sizeKB,
          outcome: 'possible_same_person',
          duplicateReviewId: duplicate.id,
        },
      });
    }

    const candidate = await this.createCandidateFromMaterial(identity, material.id, material.name, channel);
    await this.profiles.enqueue(identity.workspaceId, candidate.id, candidate.resumeVersionId, material.id);
    return this.db.importItem.create({
      data: {
        batchId,
        workspaceId: identity.workspaceId,
        materialId: material.id,
        fileName: material.name,
        sizeKB,
        outcome: 'new_candidate',
      candidateId: candidate.id,
      },
    });
  }

  private async createCandidateFromMaterial(identity: Identity, materialId: string, fileName: string, channel: ImportChannel) {
    const displayName = displayNameFromFileName(fileName);
    const coreCandidate = await this.coreRecord.createCandidate(identity, {
      displayName,
      source: channel,
    }, `screening:candidate:material:${identity.workspaceId}:${materialId}`);
    return this.db.$transaction(async (tx) => {
      const candidate = await tx.candidate.create({
        data: {
          ...(coreCandidate?.id ? { id: coreCandidate.id } : {}),
          workspaceId: identity.workspaceId,
          displayName,
          ownerId: identity.actorId,
        },
      });
      await tx.libraryEntry.create({
        data: {
          workspaceId: identity.workspaceId,
          candidateId: candidate.id,
          ownerId: identity.actorId,
        },
      });
      const resumeVersion = await tx.resumeVersion.create({
        data: {
          workspaceId: identity.workspaceId,
          candidateId: candidate.id,
          materialId,
          version: 1,
          source: channel,
          parseStatus: 'pending',
        },
      });
      await tx.candidateSource.create({
        data: {
          workspaceId: identity.workspaceId,
          candidateId: candidate.id,
          materialId,
          channel,
          receivedAt: new Date(),
        },
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

  private async findPossibleCandidate(workspaceId: string, fileName: string) {
    const normalized = normalizeName(fileName);
    if (!normalized) return null;
    const candidates = await this.db.candidate.findMany({
      where: { workspaceId },
      select: { id: true, displayName: true },
    });
    return candidates.find((candidate) => {
      const current = normalizeName(candidate.displayName);
      return current === normalized || current.includes(normalized) || normalized.includes(current);
    }) ?? null;
  }

  private errorToOutcome(error: unknown) {
    const response = error && typeof error === 'object' && 'response' in error
      ? (error as { response?: { code?: string } }).response
      : undefined;
    const code = String(response?.code || '');
    if (code === 'FILE_TOO_LARGE') return 'too_large';
    if (code === 'UNSUPPORTED_FILE_TYPE') return 'unsupported_type';
    return 'parse_failed';
  }
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
