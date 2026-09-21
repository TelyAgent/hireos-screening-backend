import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service';
import type { Identity } from '../auth/workspace.guard';

@Injectable()
export class TasksService {
  constructor(private readonly db: PrismaService) {}

  async list(identity: Identity, scope?: 'mine' | 'queue', applicationId?: string) {
    const where = {
      workspaceId: identity.workspaceId,
      ...(scope === 'mine' ? { assigneeId: identity.actorId } : {}),
      ...(scope === 'queue' ? { assigneeId: null } : {}),
      ...(applicationId ? { applicationId } : {}),
    };
    const tasks = await this.db.humanTask.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return tasks.map(toFrontendTask);
  }

  async claim(identity: Identity, id: string) {
    const task = await this.find(identity.workspaceId, id);
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new BadRequestException({ code: 'TASK_NOT_CLAIMABLE', status: task.status });
    }
    const claimed = await this.db.humanTask.update({
      where: { id },
      data: { assigneeId: identity.actorId, status: task.status === 'waiting' ? 'waiting' : 'in_progress', queue: null, startedAt: task.startedAt || new Date() },
    });
    return toFrontendTask(claimed);
  }

  async defer(identity: Identity, id: string, reason: string, resumeInDays = 1) {
    await this.find(identity.workspaceId, id);
    if (!reason?.trim()) throw new BadRequestException({ code: 'REASON_REQUIRED' });
    const deferred = await this.db.humanTask.update({
      where: { id },
      data: {
        status: 'waiting',
        waitingReason: reason.trim(),
        resumeAt: new Date(Date.now() + Math.max(1, resumeInDays) * 86_400_000),
      },
    });
    return toFrontendTask(deferred);
  }

  async complete(identity: Identity, id: string, completionRef?: string) {
    const task = await this.find(identity.workspaceId, id);
    if (task.status === 'cancelled') throw new BadRequestException({ code: 'TASK_CANCELLED' });
    const requiredResultType = (task.completionRule as { requiredResultType?: string } | null)?.requiredResultType;
    if (requiredResultType === 'duplicate_resolution') {
      // A duplicate-review task can only be closed by actually recording a decision
      // (same person / different person / reuse file) through the duplicates endpoint --
      // that path records the outcome, the audit trail, and the Candidate relationship.
      // Completing it here directly would mark the review "done" with no decision made.
      throw new BadRequestException({ code: 'RESOLVE_VIA_DUPLICATE_REVIEW', duplicateReviewId: task.duplicateReviewId });
    }
    const completed = await this.db.humanTask.update({
      where: { id },
      data: { status: 'completed', completedAt: new Date(), completionRef: completionRef || task.applicationId || undefined },
    });
    return toFrontendTask(completed);
  }

  private async find(workspaceId: string, id: string) {
    const task = await this.db.humanTask.findFirst({ where: { id, workspaceId } });
    if (!task) throw new NotFoundException({ code: 'NOT_FOUND' });
    return task;
  }
}

function toFrontendTask(task: {
  id: string;
  taskType: string;
  title: string;
  subjectLabel: string;
  sourceModule: string;
  assigneeId: string | null;
  queue: string | null;
  priority: string;
  status: string;
  createdAt: Date;
  dueAt: Date | null;
  completedAt: Date | null;
  waitingReason: string | null;
  resumeAt: Date | null;
  needsRefresh: boolean;
  linkRoute: string;
  candidateId: string | null;
  jobId: string | null;
  applicationId: string | null;
}) {
  return {
    id: task.id,
    type: task.taskType,
    title: task.title,
    subjectLabel: task.subjectLabel,
    module: task.sourceModule,
    assignee: task.assigneeId || null,
    queue: task.queue || undefined,
    priority: task.priority,
    status: task.status,
    createdAt: task.createdAt.toISOString(),
    dueAt: task.dueAt?.toISOString(),
    completedAt: task.completedAt?.toISOString(),
    waitingReason: task.waitingReason || undefined,
    resumeAt: task.resumeAt?.toISOString(),
    needsRefresh: task.needsRefresh,
    linkRoute: task.linkRoute,
    candidateId: task.candidateId || undefined,
    jobId: task.jobId || undefined,
    applicationId: task.applicationId || undefined,
  };
}
