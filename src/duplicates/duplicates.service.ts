import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service';
import { displayNameFromFileName } from '../intake/imports.service';
import type { Identity } from '../auth/workspace.guard';
import type { DuplicateResolutionOutcome } from './duplicates.types';
import { ProfilesService } from '../profiles/profiles.service';

@Injectable()
export class DuplicatesService {
  constructor(
    private readonly db: PrismaService,
    private readonly profiles: ProfilesService,
  ) {}

  async get(identity: Identity, id: string) {
    const check = await this.db.duplicateCheck.findFirst({
      where: { id, workspaceId: identity.workspaceId },
      include: {
        material: { select: { id: true, name: true, createdAt: true, readStatus: true, errorCode: true } },
        existingCandidate: {
          select: {
            id: true, displayName: true, email: true, phone: true, createdAt: true,
            resumeVersions: {
              where: { isLatest: true },
              take: 1,
              include: { material: { select: { name: true, createdAt: true } } },
            },
          },
        },
      },
    });
    if (!check) throw new NotFoundException({ code: 'NOT_FOUND' });
    const existingVersion = check.existingCandidate?.resumeVersions[0];
    return {
      id: check.id,
      kind: check.kind,
      status: check.status,
      uploaded: {
        fileName: check.material.name,
        uploadedAt: check.material.createdAt.toISOString(),
        source: 'Manual upload',
        uploadedBy: 'emma',
        name: displayNameFromFileName(check.material.name),
      },
      existing: check.existingCandidate
        ? {
            candidateId: check.existingCandidate.id,
            name: check.existingCandidate.displayName,
            email: check.existingCandidate.email || undefined,
            phone: check.existingCandidate.phone || undefined,
            fileName: existingVersion?.material.name || 'No resume version',
            uploadedAt: (existingVersion?.material.createdAt || check.existingCandidate.createdAt).toISOString(),
            source: existingVersion?.source || 'Resume Library',
          }
        : {
            candidateId: '',
            fileName: 'No existing candidate',
            uploadedAt: check.material.createdAt.toISOString(),
            source: 'Resume Library',
          },
      basis: Array.isArray(check.basis) ? check.basis as string[] : [],
      resolutionOutcome: check.resolutionOutcome || undefined,
      resolutionNote: check.resolutionNote || undefined,
      resolutionBy: check.resolvedBy || undefined,
      resolutionAt: check.resolvedAt?.toISOString(),
    };
  }

  async resolve(identity: Identity, id: string, outcome: DuplicateResolutionOutcome, note?: string) {
    const check = await this.db.duplicateCheck.findFirst({
      where: { id, workspaceId: identity.workspaceId },
      include: { material: true },
    });
    if (!check) throw new NotFoundException({ code: 'NOT_FOUND' });
    if (outcome === 'defer') {
      await this.db.duplicateCheck.update({
        where: { id },
        data: { status: 'open', resolutionOutcome: outcome, resolutionNote: note || 'Deferred for more information.' },
      });
      return this.get(identity, id);
    }

    await this.db.$transaction(async (tx) => {
      if (outcome === 'same_person_new_version') {
        if (!check.existingCandidateId || check.material.readStatus !== 'available') {
          throw new BadRequestException({ code: 'CANDIDATE_OR_MATERIAL_NOT_READY' });
        }
        const latest = await tx.resumeVersion.findFirst({
          where: { candidateId: check.existingCandidateId },
          orderBy: { version: 'desc' },
        });
        await tx.resumeVersion.updateMany({
          where: { candidateId: check.existingCandidateId },
          data: { isLatest: false },
        });
        await tx.resumeVersion.create({
          data: {
            workspaceId: identity.workspaceId,
            candidateId: check.existingCandidateId,
            materialId: check.materialId,
            version: (latest?.version || 0) + 1,
            source: 'manual_upload',
            parseStatus: 'pending',
          },
        });
        await tx.candidateSource.updateMany({
          where: { materialId: check.materialId },
          data: { candidateId: check.existingCandidateId },
        });
      } else if (outcome === 'different_person') {
        const candidate = await tx.candidate.create({
          data: {
            workspaceId: identity.workspaceId,
            displayName: displayNameFromFileName(check.material.name),
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
        await tx.resumeVersion.create({
          data: {
            workspaceId: identity.workspaceId,
            candidateId: candidate.id,
            materialId: check.materialId,
            version: 1,
            source: 'manual_upload',
            parseStatus: 'pending',
          },
        });
        await tx.candidateSource.updateMany({
          where: { materialId: check.materialId },
          data: { candidateId: candidate.id },
        });
      }
      await tx.duplicateCheck.update({
        where: { id },
        data: {
          status: 'resolved',
          resolutionOutcome: outcome,
          resolutionNote: note || defaultResolutionNote(outcome),
          resolvedBy: identity.actorId,
          resolvedAt: new Date(),
        },
      });
    });
    if (outcome === 'same_person_new_version' || outcome === 'different_person') {
      const version = await this.db.resumeVersion.findUnique({
        where: { materialId: check.materialId },
        select: { id: true, candidateId: true },
      });
      if (version) {
        await this.profiles.enqueue(identity.workspaceId, version.candidateId, version.id, check.materialId);
      }
    }
    return this.get(identity, id);
  }
}

function defaultResolutionNote(outcome: Exclude<DuplicateResolutionOutcome, 'defer'>) {
  if (outcome === 'reuse_file') return 'Existing file content was reused; this source remains in import history.';
  if (outcome === 'same_person_new_version') return 'Saved as a new resume version for the existing candidate.';
  return 'Created a separate candidate. No identities were merged.';
}
