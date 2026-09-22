import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service';
import type { Identity } from '../auth/workspace.guard';
import { createJobSchema, criteriaSchema, importJobSchema, validate, type CriteriaInput } from './contracts';
import { CoreRecordClient } from '../core-record/core-record.client';
import { JobCriteriaFacade, type RemoteCriteriaProjection, type RoleDraftInput } from './job-criteria.facade';
import { parseJobDefinition } from './job-definition.parser';
import { createHash } from 'node:crypto';

const DEFAULT_DIMENSIONS = [
  { id: 'dim-skills', name: 'Skills', weight: 0.25, rubric: 'How closely the candidate skills match the role.' },
  { id: 'dim-relexp', name: 'Relevant Experience', weight: 0.25, rubric: 'How closely prior work maps to the role.' },
  { id: 'dim-seniority', name: 'Seniority', weight: 0.25, rubric: 'Whether the candidate level matches the role.' },
  { id: 'dim-complocation', name: 'Compensation & Location Fit', weight: 0.25, rubric: 'Whether location and authorization fit the role.' },
];

@Injectable()
export class JobsService {
  constructor(
    private readonly db: PrismaService,
    private readonly coreRecord: CoreRecordClient,
    private readonly criteriaFacade: JobCriteriaFacade,
  ) {}

  async list(identity: Identity) {
    const jobs = await this.db.job.findMany({
      where: { workspaceId: identity.workspaceId },
      orderBy: { createdAt: 'desc' },
      include: { criteriaVersions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    return jobs.map((job) => toFrontendJob(job));
  }

  async get(identity: Identity, id: string) {
    const job = await this.db.job.findFirst({
      where: { id, workspaceId: identity.workspaceId },
      include: { criteriaVersions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!job) throw new NotFoundException({ code: 'NOT_FOUND' });
    const remoteCriteria = await this.criteriaFacade.get(identity, id);
    return toFrontendJob(job, remoteCriteria || undefined);
  }

  async create(identity: Identity, raw: unknown) {
    const input = validate(createJobSchema, raw);
    if (input.jdText?.trim()) {
      return this.importFromSource(identity, {
        sourceText: input.jdText,
        title: input.title,
        team: input.team,
        assessmentRequired: input.assessmentRequired,
      });
    }
    const coreJob = await this.coreRecord.createJob(identity, {
      title: input.title,
      team: input.team,
      location: 'Remote (US)',
      employmentType: 'Full-time',
      seniority: 'Unspecified',
      openings: 1,
      status: 'draft',
    }, `screening:job:create:${identity.workspaceId}:${input.title}:${input.team || ''}`);
    const job = await this.db.$transaction(async (tx) => {
      const created = coreJob?.id
        ? await tx.job.upsert({
            where: { id: coreJob.id },
            update: {
              title: input.title,
              team: input.team || 'Unassigned',
              status: coreJob.status || 'draft',
              jdText: input.jdText || null,
              assessmentRequired: input.assessmentRequired ?? false,
            },
            create: {
              id: coreJob.id,
              workspaceId: identity.workspaceId,
              title: input.title,
              team: input.team || 'Unassigned',
              status: coreJob.status || 'draft',
              location: 'Remote (US)',
              employmentType: 'Full-time',
              seniority: 'Unspecified',
              jdText: input.jdText || null,
              assessmentRequired: input.assessmentRequired ?? false,
            },
          })
        : await tx.job.create({
            data: {
              workspaceId: identity.workspaceId,
              title: input.title,
              team: input.team || 'Unassigned',
              location: 'Remote (US)',
              employmentType: 'Full-time',
              seniority: 'Unspecified',
              jdText: input.jdText || null,
              assessmentRequired: input.assessmentRequired ?? false,
            },
          });
      const existingCriteria = await tx.jobCriteriaVersion.findFirst({
        where: { jobId: created.id },
        orderBy: { version: 'desc' },
      });
      if (existingCriteria) return created;
      await tx.jobCriteriaVersion.create({
        data: {
          workspaceId: identity.workspaceId,
          jobId: created.id,
          version: 0,
          requirements: [],
          dimensions: DEFAULT_DIMENSIONS,
        },
      });
      return created;
    });
    return this.get(identity, job.id);
  }

  async importFromSource(identity: Identity, raw: unknown) {
    const input = validate(importJobSchema, raw);
    const existing = await this.db.job.findFirst({
      where: { workspaceId: identity.workspaceId, jdText: input.sourceText },
      select: { id: true },
    });
    if (existing) return this.get(identity, existing.id);
    const parsed = parseJobDefinition(input.sourceText);
    const title = input.title || parsed.title;
    const team = input.team || parsed.team;
    const sourceRef = {
      type: 'source_text',
      fileName: input.sourceFileName,
      contentHash: `sha256:${createHash('sha256').update(input.sourceText).digest('hex')}`,
      parser: 'screening.job-definition.parser.v1',
    };
    const roleInput: RoleDraftInput = {
      roleSummary: parsed.roleSummary,
      responsibilities: parsed.responsibilities,
      requirements: parsed.requirements,
      dimensions: parsed.dimensions,
      hiringContext: parsed.hiringContext,
      successCriteria: parsed.successCriteria,
      sourceRefs: [sourceRef],
      origin: 'external_import',
    };
    const coreJob = await this.coreRecord.createJob(identity, {
      title,
      team,
      location: parsed.location,
      employmentType: parsed.employmentType,
      seniority: parsed.seniority,
      openings: 1,
      status: 'draft',
    }, `screening:job:import:${identity.workspaceId}:${sourceRef.contentHash}`);
    const job = await this.db.$transaction(async (tx) => {
      const created = coreJob?.id
        ? await tx.job.upsert({
            where: { id: coreJob.id },
            update: {
              title,
              team,
              location: parsed.location,
              employmentType: parsed.employmentType,
              seniority: parsed.seniority,
              status: coreJob.status || 'draft',
              jdText: input.sourceText,
              assessmentRequired: input.assessmentRequired ?? false,
            },
            create: {
              id: coreJob.id,
              workspaceId: identity.workspaceId,
              title,
              team,
              location: parsed.location,
              employmentType: parsed.employmentType,
              seniority: parsed.seniority,
              status: coreJob?.status || 'draft',
              jdText: input.sourceText,
              assessmentRequired: input.assessmentRequired ?? false,
            },
          })
        : await tx.job.create({
            data: {
              workspaceId: identity.workspaceId,
              title,
              team,
              location: parsed.location,
              employmentType: parsed.employmentType,
              seniority: parsed.seniority,
              jdText: input.sourceText,
              assessmentRequired: input.assessmentRequired ?? false,
            },
          });
      await tx.jobCriteriaVersion.upsert({
        where: { jobId_version: { jobId: created.id, version: 0 } },
        update: { requirements: parsed.requirements, dimensions: parsed.dimensions },
        create: {
          workspaceId: identity.workspaceId,
          jobId: created.id,
          version: 0,
          requirements: parsed.requirements,
          dimensions: parsed.dimensions,
        },
      });
      return created;
    });
    if (this.criteriaFacade.isRemote()) {
      const remote = await this.criteriaFacade.update(identity, job.id, roleInput);
      await this.syncRemoteCriteria(identity.workspaceId, job.id, remote);
    }
    return this.get(identity, job.id);
  }

  async updateCriteria(identity: Identity, id: string, raw: unknown) {
    const input = validate(criteriaSchema, raw);
    const job = await this.find(identity.workspaceId, id);
    if (job.criteriaStatus === 'confirmed') {
      throw new BadRequestException({ code: 'CRITERIA_CONFIRMED', message: 'Reopen criteria before editing.' });
    }
    if (this.criteriaFacade.isRemote()) {
      const remote = await this.criteriaFacade.update(identity, id, input);
      await this.syncRemoteCriteria(identity.workspaceId, id, remote);
      return this.get(identity, id);
    }
    await this.db.jobCriteriaVersion.update({
      where: { id: job.criteriaVersions[0].id },
      data: { requirements: input.requirements, dimensions: input.dimensions },
    });
    return this.get(identity, id);
  }

  async confirmCriteria(identity: Identity, id: string, actorId: string) {
    const job = await this.find(identity.workspaceId, id);
    const draft = job.criteriaVersions[0];
    const input = criteriaSchema.parse({
      requirements: asArray(draft.requirements),
      dimensions: asArray(draft.dimensions),
    }) as CriteriaInput;
    const weightSum = input.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
    if (Math.abs(weightSum - 1) > 0.001) {
      throw new BadRequestException({ code: 'WEIGHTS_NOT_100' });
    }
    if (this.criteriaFacade.isRemote()) {
      const remote = await this.criteriaFacade.confirm(identity, id, input);
      await this.syncRemoteCriteria(identity.workspaceId, id, remote);
      return this.get(identity, id);
    }
    const confirmedAt = new Date();
    const confirmedVersion = draft.version === 0 ? 1 : draft.version;
    await this.db.$transaction([
      this.db.jobCriteriaVersion.update({
        where: { id: draft.id },
        data: { version: confirmedVersion, status: 'confirmed', confirmedBy: actorId, confirmedAt },
      }),
      this.db.job.update({
        where: { id: job.id },
        data: { criteriaStatus: 'confirmed', criteriaVersion: confirmedVersion, confirmedBy: actorId, confirmedAt, status: 'open' },
      }),
    ]);
    return this.get(identity, id);
  }

  async reopenCriteria(identity: Identity, id: string) {
    const job = await this.find(identity.workspaceId, id);
    if (job.criteriaStatus !== 'confirmed') return this.get(identity, id);
    if (this.criteriaFacade.isRemote()) {
      const remote = await this.criteriaFacade.reopen(identity, id);
      await this.syncRemoteCriteria(identity.workspaceId, id, remote);
      return this.get(identity, id);
    }
    const current = job.criteriaVersions[0];
    await this.db.$transaction([
      this.db.jobCriteriaVersion.create({
        data: {
          workspaceId: identity.workspaceId,
          jobId: job.id,
          version: job.criteriaVersion + 1,
          status: 'draft',
          requirements: asArray(current.requirements),
          dimensions: asArray(current.dimensions),
        },
      }),
      this.db.job.update({
        where: { id: job.id },
        data: { criteriaStatus: 'draft' },
      }),
    ]);
    return this.get(identity, id);
  }

  private async syncRemoteCriteria(workspaceId: string, jobId: string, projection: RemoteCriteriaProjection) {
    const job = await this.db.job.findFirst({
      where: { id: jobId, workspaceId },
      select: { criteriaVersion: true },
    });
    if (!job) throw new NotFoundException({ code: 'NOT_FOUND' });

    await this.db.$transaction(async (tx) => {
      const draft = await tx.jobCriteriaVersion.findFirst({
        where: { workspaceId, jobId, status: 'draft' },
        orderBy: { version: 'desc' },
      });
      const confirmedVersion = projection.versionNo || Math.max(1, job.criteriaVersion + 1);
      const confirmedAt = projection.confirmedAt ? new Date(projection.confirmedAt) : new Date();

      if (projection.status === 'confirmed') {
        if (draft) {
          await tx.jobCriteriaVersion.update({
            where: { id: draft.id },
            data: {
              version: confirmedVersion,
              status: 'confirmed',
              requirements: projection.requirements,
              dimensions: projection.dimensions,
              confirmedBy: projection.confirmedBy,
              confirmedAt,
            },
          });
        } else {
          await tx.jobCriteriaVersion.upsert({
            where: { jobId_version: { jobId, version: confirmedVersion } },
            update: {
              status: 'confirmed',
              requirements: projection.requirements,
              dimensions: projection.dimensions,
              confirmedBy: projection.confirmedBy,
              confirmedAt,
            },
            create: {
              workspaceId,
              jobId,
              version: confirmedVersion,
              status: 'confirmed',
              requirements: projection.requirements,
              dimensions: projection.dimensions,
              confirmedBy: projection.confirmedBy,
              confirmedAt,
            },
          });
        }
        await tx.job.update({
          where: { id: jobId },
          data: {
            criteriaStatus: 'confirmed',
            criteriaVersion: confirmedVersion,
            confirmedBy: projection.confirmedBy,
            confirmedAt,
            // Confirming criteria is the only gate the product has for "is this job real
            // enough to match against" -- there is no separate publish/open action
            // anywhere in the UI or API, so a job must become open here or it can never
            // become open at all, and discovery matching would silently find nothing.
            status: 'open',
          },
        });
        return;
      }

      const draftVersion = draft?.version ?? (job.criteriaVersion > 0 ? job.criteriaVersion + 1 : 0);
      if (draft) {
        await tx.jobCriteriaVersion.update({
          where: { id: draft.id },
          data: { requirements: projection.requirements, dimensions: projection.dimensions },
        });
      } else {
        await tx.jobCriteriaVersion.create({
          data: {
            workspaceId,
            jobId,
            version: draftVersion,
            status: 'draft',
            requirements: projection.requirements,
            dimensions: projection.dimensions,
          },
        });
      }
      await tx.job.update({ where: { id: jobId }, data: { criteriaStatus: 'draft' } });
    });
  }

  private async find(workspaceId: string, id: string) {
    const job = await this.db.job.findFirst({
      where: { id, workspaceId },
      include: { criteriaVersions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!job || !job.criteriaVersions[0]) throw new NotFoundException({ code: 'NOT_FOUND' });
    return job;
  }
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

// Single source of truth for "does this job require a completed Assessment before
// Interview" -- used both to gate DecisionsService.record's move_to_interview path and
// to tell the frontend (via toFrontendJob's workflowPolicy) whether to show the
// exception-request UI. Deliberately NOT based on seniority: a Senior job doesn't imply
// an assessment is required -- recruiters should be free to choose "Send Assessment" or
// "Move to Interview" for any job unless it (or an explicit title marker) opts in.
export function jobRequiresAssessment(job: { assessmentRequired: boolean; title: string }): boolean {
  return job.assessmentRequired || job.title.toLowerCase().includes('assessment-required');
}

function toFrontendJob(job: {
  id: string;
  title: string;
  team: string;
  location: string;
  employmentType: string;
  seniority: string;
  status: string;
  criteriaStatus: string;
  criteriaVersion: number;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  openings: number;
  applicantCount: number;
  assessmentRequired: boolean;
  criteriaVersions: Array<{ requirements: unknown; dimensions: unknown }>;
}, remoteCriteria?: RemoteCriteriaProjection) {
  const criteria = remoteCriteria || job.criteriaVersions[0];
  return {
    id: job.id,
    title: job.title,
    team: job.team,
    location: job.location,
    employmentType: job.employmentType,
    seniority: job.seniority,
    status: job.status,
    hiringManager: 'daniel',
    recruiter: 'emma',
    criteriaStatus: remoteCriteria ? remoteCriteria.status : job.criteriaStatus === 'confirmed' ? 'confirmed' : 'draft',
    criteriaVersion: remoteCriteria?.status === 'confirmed' ? remoteCriteria.versionNo : job.criteriaVersion,
    confirmedBy: remoteCriteria?.confirmedBy || job.confirmedBy || undefined,
    confirmedAt: remoteCriteria?.confirmedAt || job.confirmedAt?.toISOString(),
    compRange: { min: null, max: null, currency: 'USD', period: 'year', basis: 'unknown' },
    responsibilities: remoteCriteria?.responsibilities || [],
    requirements: asArray(criteria?.requirements),
    dimensions: asArray(criteria?.dimensions),
    workflowPolicy: { assessmentDisposition: jobRequiresAssessment(job) ? 'required' : 'optional', decisionApprovalsRequired: 1, exceptionApprovalRoles: ['emma', 'daniel'] },
    openings: job.openings,
    applicantCount: job.applicantCount,
    assessmentRequired: job.assessmentRequired,
  };
}
