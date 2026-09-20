/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../persistence/prisma.service';
import type { Identity } from '../auth/workspace.guard';

@Injectable()
export class ComparisonsService {
  constructor(private readonly db: PrismaService) {}

  async create(identity: Identity, raw: { jobId?: string; purpose?: string; applicationIds?: string[] }) {
    if (!raw.jobId || !raw.purpose?.trim()) throw new BadRequestException({ code: 'INVALID_COMPARISON' });
    const applications = await this.loadApplications(identity, raw.applicationIds || []);
    if (!applications.length || applications.some((application) => application.jobId !== raw.jobId)) {
      throw new ConflictException({ code: 'APPLICATIONS_MUST_SHARE_JOB' });
    }
    const job = await this.db.job.findFirst({ where: { id: raw.jobId, workspaceId: identity.workspaceId } });
    if (!job) throw new NotFoundException({ code: 'NOT_FOUND' });
    const comparison = await this.db.comparisonSet.create({
      data: {
        workspaceId: identity.workspaceId,
        jobId: raw.jobId,
        purpose: raw.purpose.trim(),
        ownerId: identity.actorId,
        collaborators: json([]),
        members: { create: applications.map((application) => ({ workspaceId: identity.workspaceId, applicationId: application.id })) },
      },
    });
    return this.get(identity, comparison.id);
  }

  async get(identity: Identity, id: string) {
    const comparison = await this.db.comparisonSet.findFirst({
      where: { id, workspaceId: identity.workspaceId },
      include: {
        members: { orderBy: { addedAt: 'asc' } },
        snapshots: { orderBy: { version: 'asc' }, include: { rankingSnapshot: true } },
        annotations: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!comparison) throw new NotFoundException({ code: 'NOT_FOUND' });
    return serializeComparison(comparison);
  }

  async addMember(identity: Identity, comparisonId: string, applicationId?: string) {
    if (!applicationId) throw new BadRequestException({ code: 'APPLICATION_REQUIRED' });
    const comparison = await this.findComparison(identity.workspaceId, comparisonId);
    const application = await this.db.application.findFirst({
      where: { id: applicationId, workspaceId: identity.workspaceId },
    });
    if (!application) throw new NotFoundException({ code: 'NOT_FOUND' });
    if (application.jobId !== comparison.jobId) throw new ConflictException({ code: 'APPLICATIONS_MUST_SHARE_JOB' });
    await this.db.comparisonMember.upsert({
      where: { comparisonSetId_applicationId: { comparisonSetId: comparisonId, applicationId } },
      create: { workspaceId: identity.workspaceId, comparisonSetId: comparisonId, applicationId },
      update: {},
    });
    return this.get(identity, comparisonId);
  }

  async refresh(identity: Identity, comparisonId: string) {
    const comparison = await this.findComparison(identity.workspaceId, comparisonId);
    const members = await this.db.comparisonMember.findMany({
      where: { comparisonSetId: comparisonId, workspaceId: identity.workspaceId },
      include: {
        application: {
          include: {
            candidate: { select: { id: true, displayName: true } },
            job: { select: { id: true, title: true, criteriaVersion: true } },
          },
        },
      },
    });
    if (members.length < 2) throw new ConflictException({ code: 'COMPARISON_NEEDS_TWO_MEMBERS' });
    const evaluationIds = members.map((member) => member.applicationId);
    const evaluations = await this.db.screeningEvaluation.findMany({
      where: {
        workspaceId: identity.workspaceId,
        applicationId: { in: evaluationIds },
        freshness: 'current',
      },
      orderBy: { version: 'desc' },
      include: { dimensionScores: true },
    });
    const currentByApplication = new Map<string, any>();
    for (const evaluation of evaluations) {
      if (!currentByApplication.has(evaluation.applicationId)) currentByApplication.set(evaluation.applicationId, evaluation);
    }
    const criteriaVersions = new Set(
      Array.from(currentByApplication.values())
        .map((evaluation) => readCriteriaVersion(evaluation.inputManifest))
        .filter((version): version is number => version != null),
    );
    if (criteriaVersions.size > 1 || (criteriaVersions.size === 1 && !criteriaVersions.has(comparison.jobId ? members[0].application.job.criteriaVersion : 0))) {
      throw new ConflictException({ code: 'BASELINE_MISMATCH', reason: 'All evaluations must use the same confirmed criteria version.' });
    }
    const criteriaVersion = criteriaVersions.values().next().value ?? members[0].application.job.criteriaVersion;
    const entries = members.map((member) => buildEntry(member.application, currentByApplication.get(member.applicationId)));
    const ranked = entries
      .filter((entry) => entry.overall != null)
      .sort((a, b) => (b.overall as number) - (a.overall as number));
    const rankByApplication = new Map(ranked.map((entry, index) => [entry.applicationId, index + 1]));
    const rankedEntries = entries.map((entry) => ({ ...entry, rank: entry.overall == null ? null : rankByApplication.get(entry.applicationId) || null }));
    const previous = await this.db.comparisonSnapshot.findFirst({
      where: { comparisonSetId: comparisonId },
      orderBy: { version: 'desc' },
      include: { rankingSnapshot: true },
    });
    const changes = calculateChanges(previous?.rankingSnapshot?.entries, rankedEntries);
    const version = (previous?.version || 0) + 1;
    const snapshot = await this.db.$transaction(async (tx) => {
      await tx.comparisonSnapshot.updateMany({
        where: { comparisonSetId: comparisonId, freshness: 'current' },
        data: { freshness: 'stale' },
      });
      const created = await tx.comparisonSnapshot.create({
        data: {
          workspaceId: identity.workspaceId,
          comparisonSetId: comparisonId,
          version,
          mode: 'current_summary',
          freshness: 'current',
          note: 'Generated from the current screening evaluation baseline.',
          changesSinceLast: json(changes),
        },
      });
      await tx.rankingSnapshot.create({
        data: {
          workspaceId: identity.workspaceId,
          jobId: comparison.jobId,
          comparisonSetId: comparisonId,
          comparisonSnapshotId: created.id,
          criteriaVersion,
          baselineKey: `${comparison.jobId}:criteria:${criteriaVersion}`,
          entries: json(rankedEntries),
        },
      });
      await tx.auditRecord.create({
        data: {
          workspaceId: identity.workspaceId,
          actorId: identity.actorId,
          action: 'comparison_snapshot_created',
          objectType: 'ComparisonSnapshot',
          objectId: created.id,
          payload: json({ comparisonId, version, criteriaVersion }),
        },
      });
      return created;
    });
    return serializeSnapshot({ ...snapshot, rankingSnapshot: { entries: rankedEntries } });
  }

  async annotate(identity: Identity, comparisonId: string, raw: { targetId?: string; body?: string }) {
    await this.findComparison(identity.workspaceId, comparisonId);
    if (!raw.body?.trim()) throw new BadRequestException({ code: 'ANNOTATION_REQUIRED' });
    const annotation = await this.db.comparisonAnnotation.create({
      data: {
        workspaceId: identity.workspaceId,
        comparisonSetId: comparisonId,
        targetId: raw.targetId || '',
        body: raw.body.trim(),
        authorId: identity.actorId,
      },
    });
    return serializeAnnotation(annotation);
  }

  async export(identity: Identity, comparisonId: string, raw: { format?: 'png' | 'pdf'; applicationIds?: string[] }) {
    if (!['png', 'pdf'].includes(raw.format || '')) throw new BadRequestException({ code: 'INVALID_EXPORT_FORMAT' });
    await this.findComparison(identity.workspaceId, comparisonId);
    const members = await this.db.comparisonMember.findMany({
      where: {
        comparisonSetId: comparisonId,
        ...(raw.format === 'png' && raw.applicationIds?.length ? { applicationId: { in: raw.applicationIds } } : {}),
      },
      include: { application: { select: { id: true, candidateId: true } } },
    });
    const current = await this.db.comparisonSnapshot.findFirst({
      where: { comparisonSetId: comparisonId, freshness: 'current' },
      orderBy: { version: 'desc' },
      include: { rankingSnapshot: true },
    });
    if (!current?.rankingSnapshot) throw new ConflictException({ code: 'COMPARISON_NOT_REFRESHED' });
    const entries = Array.isArray(current.rankingSnapshot.entries) ? current.rankingSnapshot.entries : [];
    const allowedApplicationIds = new Set(members.map((member) => member.application.id));
    const sanitizedEntries = entries
      .filter((entry: any) => allowedApplicationIds.has(entry.applicationId))
      .map((entry: any) => ({
        ...entry,
        evidence: Array.isArray(entry.evidence)
          ? entry.evidence.filter((item: any) => item.availability !== 'restricted')
          : [],
      }));
    const job = await this.db.processingJob.create({
      data: {
        workspaceId: identity.workspaceId,
        type: 'comparison_export',
        status: 'queued',
        input: json({
          comparisonId,
          format: raw.format,
          snapshotId: current.id,
          applicationIds: Array.from(allowedApplicationIds),
          payload: sanitizedEntries,
          renderer: 'local-structured-export-v1',
        }),
      },
    });
    return {
      exportJobId: job.id,
      status: job.status,
      format: raw.format,
      exportedCount: sanitizedEntries.length,
      renderer: 'local-structured-export-v1',
    };
  }

  private async findComparison(workspaceId: string, id: string) {
    const comparison = await this.db.comparisonSet.findFirst({ where: { id, workspaceId } });
    if (!comparison) throw new NotFoundException({ code: 'NOT_FOUND' });
    return comparison;
  }

  private async loadApplications(identity: Identity, ids: string[]) {
    if (!ids.length) return [];
    return this.db.application.findMany({ where: { workspaceId: identity.workspaceId, id: { in: ids } } });
  }
}

function buildEntry(application: any, evaluation: any) {
  const inputManifest = evaluation?.inputManifest;
  const dimensions = (evaluation?.dimensionScores || []).map((dimension: any) => ({
    id: dimension.dimensionId,
    name: dimension.name,
    score: dimension.score,
    status: dimension.status,
    confidence: dimension.confidence,
    supporting: dimension.supportingRefs,
    counter: dimension.counterRefs,
  }));
  return {
    applicationId: application.id,
    candidateId: application.candidateId,
    candidateName: application.candidate.displayName,
    overall: evaluation?.overallScore ?? null,
    coverage: evaluation?.coverage ?? 0,
    eligibilityStatus: evaluation?.eligibilityStatus ?? 'needs_verification',
    evaluationStatus: evaluation?.evaluationStatus ?? 'insufficient_evidence',
    criteriaVersion: readCriteriaVersion(inputManifest),
    dimensions,
    evidence: [],
  };
}

function calculateChanges(previous: any, current: any[]) {
  if (!Array.isArray(previous)) return [];
  const priorById = new Map(previous.map((entry: any) => [entry.applicationId, entry]));
  return current
    .map((entry) => {
      const prior = priorById.get(entry.applicationId);
      if (!prior) return `${entry.candidateName} added to the comparison.`;
      if (prior.overall !== entry.overall) return `${entry.candidateName}: overall changed from ${prior.overall ?? 'unknown'} to ${entry.overall ?? 'unknown'}.`;
      if (prior.rank !== entry.rank) return `${entry.candidateName}: rank changed from ${prior.rank ?? 'unranked'} to ${entry.rank ?? 'unranked'}.`;
      return null;
    })
    .filter((change): change is string => Boolean(change));
}

function readCriteriaVersion(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const version = (value as { criteriaVersion?: unknown }).criteriaVersion;
  return typeof version === 'number' ? version : null;
}

function serializeComparison(comparison: any) {
  return {
    id: comparison.id,
    jobId: comparison.jobId,
    purpose: comparison.purpose,
    memberIds: comparison.members.map((member: any) => member.applicationId),
    owner: comparison.ownerId,
    collaborators: Array.isArray(comparison.collaborators) ? comparison.collaborators : [],
    snapshots: comparison.snapshots.map(serializeSnapshot),
    annotations: comparison.annotations.map(serializeAnnotation),
  };
}

function serializeSnapshot(snapshot: any) {
  return {
    id: snapshot.id,
    version: snapshot.version,
    generatedAt: snapshot.generatedAt.toISOString(),
    mode: snapshot.mode,
    freshness: snapshot.freshness,
    note: snapshot.note,
    changesSinceLast: snapshot.changesSinceLast,
  };
}

function serializeAnnotation(annotation: any) {
  return {
    id: annotation.id,
    author: annotation.authorId,
    targetId: annotation.targetId,
    body: annotation.body,
    createdAt: annotation.createdAt.toISOString(),
  };
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
