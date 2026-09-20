/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../persistence/prisma.service';
import type { Identity } from '../auth/workspace.guard';

const DEFAULT_WORKSPACE = 'local-screening-workspace';

@Injectable()
export class SettingsService {
  constructor(private readonly db: PrismaService) {}

  async listConnections(identity: Identity) {
    await this.ensureConnections(identity.workspaceId);
    const rows = await this.db.sourceConnection.findMany({
      where: { workspaceId: identity.workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(serializeConnection);
  }

  async readConnection(identity: Identity, id: string) {
    const connection = await this.getConnection(identity.workspaceId, id);
    if (connection.status === 'authorization_required') {
      throw new ConflictException({ code: 'AUTH_REQUIRED', message: 'Authorization required' });
    }
    const updated = await this.db.sourceConnection.update({
      where: { id },
      data: { lastReadAt: new Date(), status: connection.kind === 'folder' ? 'watching' : 'connected' },
    });
    await this.audit(identity, 'connection_read', 'SourceConnection', id, { status: 'succeeded' });
    return serializeConnection(updated);
  }

  async reconnectConnection(identity: Identity, id: string) {
    const connection = await this.getConnection(identity.workspaceId, id);
    const updated = await this.db.sourceConnection.update({
      where: { id },
      data: { lastReadAt: new Date(), status: connection.kind === 'folder' ? 'watching' : 'connected' },
    });
    await this.audit(identity, 'connection_reconnected', 'SourceConnection', id, { status: 'succeeded' });
    return serializeConnection(updated);
  }

  async pauseConnection(identity: Identity, id: string) {
    await this.getConnection(identity.workspaceId, id);
    const updated = await this.db.sourceConnection.update({
      where: { id },
      data: { status: 'paused' },
    });
    await this.audit(identity, 'connection_paused', 'SourceConnection', id, { status: 'succeeded' });
    return serializeConnection(updated);
  }

  async listActivity(identity: Identity) {
    const rows = await this.db.auditRecord.findMany({
      where: { workspaceId: identity.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((row) => {
      const payload = row.payload as Record<string, unknown>;
      return {
        id: row.id,
        op: row.action,
        actor: row.actorId,
        target: `${row.objectType}:${row.objectId}`,
        status: payload.status === 'failed' ? 'failed' : payload.status === 'partial' ? 'partial' : 'succeeded',
        detail: typeof payload.detail === 'string' ? payload.detail : undefined,
        at: row.createdAt.toISOString(),
      };
    });
  }

  async getPreferences(identity: Identity) {
    const setting = await this.ensureSetting(identity.workspaceId, 'preferences', defaultPreferences());
    return setting.payload;
  }

  async activateProposal(identity: Identity, proposalId: string) {
    const setting = await this.ensureSetting(identity.workspaceId, 'preferences', defaultPreferences());
    const payload = clone(setting.payload) as any;
    const proposal = payload.proposed.find((item: any) => item.id === proposalId);
    if (!proposal) throw new NotFoundException({ code: 'NOT_FOUND' });
    payload.proposed = payload.proposed.filter((item: any) => item.id !== proposalId);
    payload.versions.unshift({
      id: `v-${setting.version + 1}`,
      label: `v${setting.version + 1} (current)`,
      activatedAt: new Date().toISOString(),
      activatedBy: identity.actorId,
    });
    const updated = await this.updateSetting(setting.id, setting.version + 1, payload, identity.actorId);
    await this.audit(identity, 'preference_profile_activated', 'WorkspaceSetting', setting.id, { proposalId });
    return updated.payload;
  }

  async rejectProposal(identity: Identity, proposalId: string) {
    const setting = await this.ensureSetting(identity.workspaceId, 'preferences', defaultPreferences());
    const payload = clone(setting.payload) as any;
    if (!payload.proposed.some((item: any) => item.id === proposalId)) {
      throw new NotFoundException({ code: 'NOT_FOUND' });
    }
    payload.proposed = payload.proposed.filter((item: any) => item.id !== proposalId);
    const updated = await this.updateSetting(setting.id, setting.version + 1, payload, identity.actorId);
    await this.audit(identity, 'preference_proposal_rejected', 'WorkspaceSetting', setting.id, { proposalId });
    return updated.payload;
  }

  async rollbackPreference(identity: Identity, versionId: string) {
    const setting = await this.ensureSetting(identity.workspaceId, 'preferences', defaultPreferences());
    const payload = clone(setting.payload) as any;
    const version = payload.versions.find((item: any) => item.id === versionId);
    if (!version) throw new NotFoundException({ code: 'NOT_FOUND' });
    payload.versions.unshift({
      id: `v-${setting.version + 1}`,
      label: `v${setting.version + 1} (current, rolled back to ${version.label})`,
      activatedAt: new Date().toISOString(),
      activatedBy: identity.actorId,
    });
    const updated = await this.updateSetting(setting.id, setting.version + 1, payload, identity.actorId);
    await this.audit(identity, 'preference_profile_rolled_back', 'WorkspaceSetting', setting.id, { versionId });
    return updated.payload;
  }

  async getAiModels(identity: Identity) {
    const setting = await this.ensureSetting(identity.workspaceId, 'ai_models', defaultAiModels());
    return setting.payload;
  }

  async getAiModelActivity(identity: Identity) {
    const setting = await this.ensureSetting(identity.workspaceId, 'ai_models', defaultAiModels());
    return (setting.payload as any).events || [];
  }

  private async ensureConnections(workspaceId: string) {
    if (workspaceId !== DEFAULT_WORKSPACE) return;
    const count = await this.db.sourceConnection.count({ where: { workspaceId } });
    if (count > 0) return;
    const now = new Date();
    await this.db.sourceConnection.createMany({
      data: [
        { id: 'conn-1', workspaceId, kind: 'email', name: 'Recruiting intake mailbox', account: 'recruiting-intake@hireos.demo', status: 'connected', lastReadAt: hoursAgo(now, 3), scope: 'Inbox, last 30 days + new mail' },
        { id: 'conn-2', workspaceId, kind: 'email', name: 'Hiring manager referrals mailbox', account: 'referrals@hireos.demo', status: 'authorization_required', lastReadAt: daysAgo(now, 6), scope: 'Inbox, new mail only' },
        { id: 'conn-3', workspaceId, kind: 'folder', name: 'Shared Drive - Recruiting/Resumes', account: '/Shared Drives/Recruiting/Resumes', status: 'watching', lastReadAt: hoursAgo(now, 1), scope: 'Includes subfolders' },
        { id: 'conn-4', workspaceId, kind: 'api', name: 'Demo ingestion endpoint', account: 'API token ****-8841', status: 'connected', lastReadAt: daysAgo(now, 2), scope: 'candidate.import events' },
      ],
    });
  }

  private async getConnection(workspaceId: string, id: string) {
    const row = await this.db.sourceConnection.findFirst({ where: { workspaceId, id } });
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND' });
    return row;
  }

  private async ensureSetting(workspaceId: string, kind: string, payload: Record<string, unknown>) {
    const existing = await this.db.workspaceSetting.findUnique({ where: { workspaceId_kind_key: { workspaceId, kind, key: 'default' } } });
    if (existing) return existing;
    return this.db.workspaceSetting.create({
      data: { workspaceId, kind, key: 'default', version: 1, payload: payload as Prisma.InputJsonValue, updatedBy: 'system' },
    });
  }

  private async updateSetting(id: string, version: number, payload: Record<string, unknown>, actorId: string) {
    return this.db.workspaceSetting.update({
      where: { id },
      data: { version, payload: payload as Prisma.InputJsonValue, updatedBy: actorId },
    });
  }

  private async audit(identity: Identity, action: string, objectType: string, objectId: string, payload: Record<string, unknown>) {
    await this.db.auditRecord.create({
      data: {
        workspaceId: identity.workspaceId,
        actorId: identity.actorId,
        action,
        objectType,
        objectId,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }
}

function serializeConnection(row: any) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    account: row.account,
    status: row.status,
    lastRead: row.lastReadAt?.toISOString() || new Date(0).toISOString(),
    scope: row.scope,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hoursAgo(now: Date, hours: number) {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

function daysAgo(now: Date, days: number) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function defaultPreferences() {
  return {
    organization: { scope: 'Organization', status: 'active', owner: 'People Ops', rules: [{ feature: 'Prohibited: name, photo, school prestige, employment gaps as standalone signals', locked: true }] },
    team: { scope: 'Team - Platform Engineering', status: 'active', owner: 'daniel', rules: [{ feature: 'Slight emphasis on distributed-systems depth for backend roles', weightAdjustment: '+0.03 to Technical Depth' }] },
    role: { scope: 'Role - Senior Backend Engineer (confirmed rubric)', status: 'active', pointerOnly: true },
    user: { scope: 'User - Local Screening User (personal view only)', status: 'active', rules: [{ feature: 'Personal sort: boost Ownership & 0 to 1 in my own candidate list view', weightAdjustment: '+0.05 (view-only, does not change team scoring)' }] },
    proposed: [{ id: 'prop-1', scope: 'team', title: 'Proposed: increase Communication weight for customer-facing backend roles', sampleSize: 34, window: 'Last 60 days', basis: 'Derived from 34 eligible feedback events.', status: 'proposed', createdAt: daysAgo(new Date(), 4).toISOString() }],
    signals: [
      { id: 'sig-1', feature: 'Ownership & 0 to 1 evidence', direction: 'increase', strength: 0.6, source: '34 shortlist/advance actions, last 60 days', eligibility: 'eligible' },
      { id: 'sig-2', feature: 'Communication clarity', direction: 'increase', strength: 0.4, source: '21 advance actions citing communication strength', eligibility: 'eligible' },
      { id: 'sig-3', feature: 'Company prestige / brand name', direction: 'increase', strength: 0.2, source: 'Pattern detected in 9 advance actions', eligibility: 'prohibited' },
    ],
    versions: [
      { id: 'v-3', label: 'v3 (current)', activatedAt: daysAgo(new Date(), 21).toISOString(), activatedBy: 'morgan' },
      { id: 'v-2', label: 'v2', activatedAt: daysAgo(new Date(), 80).toISOString(), activatedBy: 'morgan' },
      { id: 'v-1', label: 'v1 (initial)', activatedAt: daysAgo(new Date(), 150).toISOString(), activatedBy: 'morgan' },
    ],
  };
}

function defaultAiModels() {
  return {
    catalog: [
      { id: 'm-1', provider: 'Anthropic (sample)', model: 'Claude Sonnet - Screening Evaluate', status: 'active', region: 'us', dataClass: 'standard' },
      { id: 'm-2', provider: 'OpenAI (sample)', model: 'GPT-4o mini - Resume Parse', status: 'active', region: 'us', dataClass: 'standard' },
      { id: 'm-3', provider: 'Cohere (sample)', model: 'Embed v3 - Duplicate Similarity', status: 'active', region: 'us', dataClass: 'standard' },
      { id: 'm-4', provider: 'Anthropic (sample)', model: 'Claude Haiku - Fallback / Evidence Extract', status: 'active', region: 'us', dataClass: 'standard' },
      { id: 'm-5', provider: 'Regional Partner (sample)', model: 'Local-EU Parse Model', status: 'not_evaluated', region: 'eu', dataClass: 'restricted' },
    ],
    taskPolicies: [
      { taskType: 'resume_parse', primary: 'm-2', fallback: 'm-4', budgetMonthly: 400, qualityGate: 'passed' },
      { taskType: 'profile_normalize', primary: 'm-2', fallback: 'm-4', budgetMonthly: 150, qualityGate: 'passed' },
      { taskType: 'duplicate_similarity', primary: 'm-3', fallback: null, budgetMonthly: 120, qualityGate: 'passed' },
      { taskType: 'job_discovery / prelink_match', primary: 'm-1', fallback: 'm-4', budgetMonthly: 600, qualityGate: 'passed' },
      { taskType: 'screening_evaluate / evidence_extract', primary: 'm-1', fallback: 'm-4', budgetMonthly: 900, qualityGate: 'passed' },
      { taskType: 'candidate_compare', primary: 'm-1', fallback: 'm-4', budgetMonthly: 200, qualityGate: 'needs_review' },
      { taskType: 'preference_signal_extract', primary: 'm-4', fallback: null, budgetMonthly: 80, qualityGate: 'passed' },
    ],
    usage: [
      { taskType: 'screening_evaluate', calls30d: 214, p95LatencyMs: 4200, costUsd: 38.52 },
      { taskType: 'resume_parse', calls30d: 96, p95LatencyMs: 1800, costUsd: 6.1 },
      { taskType: 'job_discovery', calls30d: 88, p95LatencyMs: 3300, costUsd: 11.4 },
      { taskType: 'candidate_compare', calls30d: 12, p95LatencyMs: 5100, costUsd: 4.85 },
    ],
    events: [
      { id: 'aie-1', type: 'fallback', detail: 'screening_evaluate: primary model timeout on 1 request - routed to Claude Haiku (fallback).', at: daysAgo(new Date(), 1).toISOString() },
      { id: 'aie-2', type: 'budget', detail: 'candidate_compare: 92% of monthly budget used - approaching cap.', at: hoursAgo(new Date(), 6).toISOString() },
      { id: 'aie-3', type: 'region_blocked', detail: 'Local-EU Parse Model excluded from routing for this workspace: data residency policy requires US region.', at: daysAgo(new Date(), 5).toISOString() },
      { id: 'aie-4', type: 'quality', detail: 'candidate_compare quality gate flagged for re-review after last evaluation run.', at: daysAgo(new Date(), 3).toISOString() },
    ],
  };
}
