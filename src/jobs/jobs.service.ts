import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service';
import type { Identity } from '../auth/workspace.guard';
import { createJobSchema, criteriaSchema, validate, type CriteriaInput } from './contracts';
import { CoreRecordClient } from '../core-record/core-record.client';

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
    return toFrontendJob(job);
  }

  async create(identity: Identity, raw: unknown) {
    const input = validate(createJobSchema, raw);
    const requirements: never[] = [];
    const dimensions = DEFAULT_DIMENSIONS;
    const coreJob = await this.coreRecord.createJob(identity, {
      title: input.title,
      team: input.team,
      location: 'Remote (US)',
      employmentType: 'Full-time',
      seniority: 'Unspecified',
      openings: 1,
      status: 'open',
    }, `screening:job:create:${identity.workspaceId}:${input.title}:${input.team || ''}`);
    const job = await this.db.$transaction(async (tx) => {
      const created = coreJob?.id
        ? await tx.job.upsert({
            where: { id: coreJob.id },
            update: {
              title: input.title,
              team: input.team || 'Unassigned',
              jdText: input.jdText || null,
              assessmentRequired: input.assessmentRequired ?? false,
            },
            create: {
              id: coreJob.id,
              workspaceId: identity.workspaceId,
              title: input.title,
              team: input.team || 'Unassigned',
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
          requirements,
          dimensions,
        },
      });
      return created;
    });
    return this.get(identity, job.id);
  }

  async updateCriteria(identity: Identity, id: string, raw: unknown) {
    const input = validate(criteriaSchema, raw);
    const job = await this.find(identity.workspaceId, id);
    if (job.criteriaStatus === 'confirmed') {
      throw new BadRequestException({ code: 'CRITERIA_CONFIRMED', message: 'Reopen criteria before editing.' });
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
    const confirmedAt = new Date();
    const confirmedVersion = draft.version === 0 ? 1 : draft.version;
    await this.db.$transaction([
      this.db.jobCriteriaVersion.update({
        where: { id: draft.id },
        data: { version: confirmedVersion, status: 'confirmed', confirmedBy: actorId, confirmedAt },
      }),
      this.db.job.update({
        where: { id: job.id },
        data: { criteriaStatus: 'confirmed', criteriaVersion: confirmedVersion, confirmedBy: actorId, confirmedAt },
      }),
    ]);
    return this.get(identity, id);
  }

  async reopenCriteria(identity: Identity, id: string) {
    const job = await this.find(identity.workspaceId, id);
    if (job.criteriaStatus !== 'confirmed') return this.get(identity, id);
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
}) {
  const criteria = job.criteriaVersions[0];
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
    criteriaStatus: job.criteriaStatus === 'confirmed' ? 'confirmed' : 'draft',
    criteriaVersion: job.criteriaVersion,
    confirmedBy: job.confirmedBy || undefined,
    confirmedAt: job.confirmedAt?.toISOString(),
    compRange: { min: null, max: null, currency: 'USD', period: 'year', basis: 'unknown' },
    responsibilities: [],
    requirements: asArray(criteria?.requirements),
    dimensions: asArray(criteria?.dimensions),
    workflowPolicy: { assessmentDisposition: 'optional', decisionApprovalsRequired: 1, exceptionApprovalRoles: ['emma', 'daniel'] },
    openings: job.openings,
    applicantCount: job.applicantCount,
    assessmentRequired: job.assessmentRequired,
  };
}
