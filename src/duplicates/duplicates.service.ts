import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service';
import { displayNameFromFileName, ImportsService } from '../intake/imports.service';
import type { Identity } from '../auth/workspace.guard';
import type { DuplicateResolutionOutcome } from './duplicates.types';
import { ProfilesService } from '../profiles/profiles.service';

@Injectable()
export class DuplicatesService {
  constructor(
    private readonly db: PrismaService,
    private readonly profiles: ProfilesService,
    private readonly imports: ImportsService,
  ) {}

  async get(identity: Identity, id: string) {
    const check = await this.db.duplicateCheck.findFirst({
      where: { id, workspaceId: identity.workspaceId },
      include: {
        material: { select: { id: true, name: true, segments: true, createdAt: true, readStatus: true, errorCode: true } },
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
    // The uploaded side has no Candidate yet (that's the whole question this review is
    // answering), so its email/phone/location can only come from re-reading the material.
    const uploadedSignals = check.material.readStatus === 'available'
      ? this.profiles.extractIdentitySignals(check.material.id, check.material.segments, displayNameFromFileName(check.material.name))
      : null;
    return {
      id: check.id,
      kind: check.kind,
      status: check.status,
      confidence: check.confidence ?? undefined,
      uploaded: {
        fileName: check.material.name,
        uploadedAt: check.material.createdAt.toISOString(),
        source: 'Manual upload',
        uploadedBy: 'emma',
        name: uploadedSignals?.displayName || displayNameFromFileName(check.material.name),
        email: uploadedSignals?.email || undefined,
        phone: uploadedSignals?.phone || undefined,
        location: uploadedSignals?.location || undefined,
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

    if (outcome === 'defer' || outcome === 'needs_more_information') {
      // A compare-and-set claim, same idiom the import job queue uses for its lease
      // claims: only a check that is still "open" can be touched, so a decision that
      // already landed (from this call or a concurrent one) can never be silently undone.
      const claim = await this.db.duplicateCheck.updateMany({
        where: { id, workspaceId: identity.workspaceId, status: { not: 'resolved' } },
        data: {
          status: 'open',
          resolutionOutcome: outcome,
          resolutionNote: note || (outcome === 'needs_more_information'
            ? 'Reviewer needs more information before deciding.'
            : 'Deferred for more information.'),
        },
      });
      if (claim.count !== 1) throw new BadRequestException({ code: 'ALREADY_RESOLVED' });
      return this.get(identity, id);
    }

    const { resolvedCandidateId, closedBatch } = await this.db.$transaction(async (tx) => {
      let resolvedCandidateId: string | null = null;
      let closedBatch: { batchId: string; operationId: string | null } | null = null;
      const claim = await tx.duplicateCheck.updateMany({
        where: { id, workspaceId: identity.workspaceId, status: { not: 'resolved' } },
        data: { status: 'resolved', resolutionOutcome: outcome, resolvedBy: identity.actorId, resolvedAt: new Date() },
      });
      if (claim.count !== 1) throw new BadRequestException({ code: 'ALREADY_RESOLVED' });

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
        resolvedCandidateId = check.existingCandidateId;
        await tx.auditRecord.create({
          data: {
            workspaceId: identity.workspaceId,
            actorId: identity.actorId,
            action: 'duplicate_resolved_same_person',
            objectType: 'Candidate',
            objectId: check.existingCandidateId,
            payload: { duplicateCheckId: id, materialId: check.materialId, note: note || null },
          },
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
        resolvedCandidateId = candidate.id;
        await tx.auditRecord.create({
          data: {
            workspaceId: identity.workspaceId,
            actorId: identity.actorId,
            action: 'duplicate_resolved_different_person',
            objectType: 'Candidate',
            objectId: candidate.id,
            payload: { duplicateCheckId: id, materialId: check.materialId, previouslySuspectedCandidateId: check.existingCandidateId, note: note || null },
          },
        });
      } else if (outcome === 'reuse_file') {
        if (!check.existingCandidateId) throw new BadRequestException({ code: 'CANDIDATE_NOT_READY' });
        // No new resume version: the reviewer confirmed this content is already covered
        // by the existing candidate's file. Only re-point provenance so the newly
        // uploaded material's source is attributed correctly.
        await tx.candidateSource.updateMany({
          where: { materialId: check.materialId },
          data: { candidateId: check.existingCandidateId },
        });
        resolvedCandidateId = check.existingCandidateId;
        await tx.auditRecord.create({
          data: {
            workspaceId: identity.workspaceId,
            actorId: identity.actorId,
            action: 'duplicate_resolved_reuse_file',
            objectType: 'Candidate',
            objectId: check.existingCandidateId,
            payload: { duplicateCheckId: id, materialId: check.materialId, note: note || null },
          },
        });
      }

      await tx.duplicateCheck.update({
        where: { id },
        data: { resolutionNote: note || defaultResolutionNote(outcome) },
      });

      // Close the loop: the ImportItem that raised this review has been parked in
      // needs_review since upload, and the HumanTask that asked for a decision is still
      // open. Both would otherwise stay stuck forever -- nothing else in the system ever
      // revisits them once a duplicate review is created.
      const item = await tx.importItem.findFirst({
        where: { duplicateReviewId: id, workspaceId: identity.workspaceId },
        include: { batch: true },
      });
      if (item) {
        await tx.importItem.update({
          where: { id: item.id },
          data: {
            stage: 'profile_processing',
            status: 'completed',
            outcome: `duplicate_resolved_${outcome}`,
            candidateId: resolvedCandidateId,
            businessConsumeStatus: 'completed',
            completedAt: new Date(),
          },
        });
        closedBatch = { batchId: item.batchId, operationId: item.batch.operationId };
      }
      await tx.humanTask.updateMany({
        where: { duplicateReviewId: id, workspaceId: identity.workspaceId, status: { notIn: ['completed', 'cancelled'] } },
        data: { status: 'completed', completedAt: new Date(), completionRef: id },
      });
      return { resolvedCandidateId, closedBatch };
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
    if (closedBatch) {
      // The batch's rolled-up status was computed while this item was still
      // "needs_review"; refresh it now that the review has a real outcome, otherwise the
      // batch view keeps showing "partial"/"processing" after everything is actually done.
      await this.imports.finalizeBatch(identity.workspaceId, identity.actorId, closedBatch.operationId || '', closedBatch.batchId);
    }
    return this.get(identity, id);
  }
}

function defaultResolutionNote(outcome: Exclude<DuplicateResolutionOutcome, 'defer' | 'needs_more_information'>) {
  if (outcome === 'reuse_file') return 'Existing file content was reused; this source remains in import history.';
  if (outcome === 'same_person_new_version') return 'Saved as a new resume version for the existing candidate.';
  return 'Created a separate candidate. No identities were merged.';
}
