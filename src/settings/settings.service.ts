/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../persistence/prisma.service';
import type { Identity } from '../auth/workspace.guard';
import { MailService, MailApiError, type MailInboxMessage, type MailAttachmentMessage, type MailboxCredentials } from './mail.service';
import { ImportsService } from '../intake/imports.service';

const corporateMailboxSchema = z.object({
  name: z.string().trim().max(200).optional(),
  provider: z.enum(['gmail', 'outlook', 'qq', '163', '126', 'custom']),
  email: z.string().trim().email().max(320),
  password: z.string().trim().max(500).optional(),
  imapHost: z.string().trim().min(1).max(255),
  imapPort: z.number().int().min(1).max(65535),
  imapTls: z.boolean(),
  smtpHost: z.string().trim().min(1).max(255),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
  mailbox: z.string().trim().min(1).max(200).default('INBOX'),
  purposes: z.object({ inbound: z.boolean(), outbound: z.boolean() }),
}).strict();

const testCorporateMailboxSchema = corporateMailboxSchema.extend({
  password: z.string().trim().max(500).optional(),
});

const DEFAULT_WORKSPACE = 'local-screening-workspace';

// Google/163/QQ etc. all display app passwords grouped in 4s ("ytlh hkrc alwo
// ivne") for readability -- a straight copy-paste carries those spaces along,
// and IMAP/SMTP auth fails on the literal string. Strip all whitespace, not
// just leading/trailing (zod's .trim() only handles the edges).
function normalizePassword(value: string | undefined): string | undefined {
  const stripped = value?.replace(/\s+/g, '');
  return stripped || undefined;
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly db: PrismaService,
    private readonly mail: MailService,
    private readonly imports: ImportsService,
  ) {}

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

  // The password (app password / auth code) is write-only by design -- never
  // returned once saved. This is the single place that reads the raw payload,
  // and it always strips it before returning; consumers only ever learn
  // *whether* a password is set, never its value. Each mailbox is its own
  // WorkspaceSetting row (kind='corporate_mailbox', key=<mailbox id>) -- the
  // generic settings table already supports any number of rows per kind, so
  // "one workspace, many mailboxes" needed no schema change.
  async listCorporateMailboxes(identity: Identity) {
    const rows = await this.db.workspaceSetting.findMany({
      where: { workspaceId: identity.workspaceId, kind: 'corporate_mailbox' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => serializeMailbox(row.key, row.payload as any));
  }

  async getCorporateMailbox(identity: Identity, id: string) {
    const row = await this.getMailboxSetting(identity.workspaceId, id);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND' });
    return serializeMailbox(row.key, row.payload as any);
  }

  // Runs IMAP/SMTP checks against the *submitted* form values without saving --
  // the drawer's "测试连通性" button calls this so a bad host/port/password is
  // caught before the user commits to it. Works for both a brand-new account
  // (no id yet) and an existing one (id supplied, so a blank password falls
  // back to what's already stored).
  async testCorporateMailbox(identity: Identity, raw: unknown, id?: string) {
    const parsed = testCorporateMailboxSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_INPUT', fieldErrors: parsed.error.flatten() });
    const input = parsed.data;
    const existing = id ? await this.getMailboxSetting(identity.workspaceId, id) : null;
    const prev = existing ? (existing.payload as any) : null;
    const password = normalizePassword(input.password) || prev?.password;
    if (!password) throw new BadRequestException({ code: 'CREDENTIALS_REQUIRED', message: 'An authorization code / password is required.' });
    const creds: MailboxCredentials = { email: input.email, password, imapHost: input.imapHost, imapPort: input.imapPort, imapTls: input.imapTls, smtpHost: input.smtpHost, smtpPort: input.smtpPort, smtpSecure: input.smtpSecure };
    const checks: { code: 'imap' | 'smtp'; level: 'pass' | 'fail'; message: string }[] = [];
    if (input.purposes.inbound) {
      try {
        const result = await this.mail.testImap(creds);
        checks.push({ code: 'imap', level: 'pass', message: `连接成功，收件箱共 ${result.messagesExist} 封邮件。` });
      } catch (error) {
        checks.push({ code: 'imap', level: 'fail', message: error instanceof MailApiError ? error.message : '无法连接 IMAP 服务器。' });
      }
    }
    if (input.purposes.outbound) {
      try {
        await this.mail.testSmtp(creds);
        checks.push({ code: 'smtp', level: 'pass', message: 'SMTP 认证成功，可以发信。' });
      } catch (error) {
        checks.push({ code: 'smtp', level: 'fail', message: error instanceof MailApiError ? error.message : '无法连接 SMTP 服务器。' });
      }
    }
    return { verdict: checks.every((c) => c.level === 'pass') && checks.length > 0 ? 'pass' : 'fail', checks };
  }

  async createCorporateMailbox(identity: Identity, raw: unknown) {
    return this.persistCorporateMailbox(identity, null, raw);
  }

  async updateCorporateMailbox(identity: Identity, id: string, raw: unknown) {
    const existing = await this.getMailboxSetting(identity.workspaceId, id);
    if (!existing) throw new NotFoundException({ code: 'NOT_FOUND' });
    return this.persistCorporateMailbox(identity, existing, raw);
  }

  async deleteCorporateMailbox(identity: Identity, id: string) {
    const existing = await this.getMailboxSetting(identity.workspaceId, id);
    if (!existing) throw new NotFoundException({ code: 'NOT_FOUND' });
    await this.db.workspaceSetting.delete({ where: { id: existing.id } });
    await this.audit(identity, 'corporate_mailbox_removed', 'WorkspaceSetting', existing.id, { email: (existing.payload as any).email });
  }

  private async persistCorporateMailbox(identity: Identity, existing: { id: string; key: string; version: number; payload: unknown } | null, raw: unknown) {
    const parsed = corporateMailboxSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_INPUT', fieldErrors: parsed.error.flatten() });
    const input = parsed.data;
    const prev = existing ? (existing.payload as any) : null;
    const password = normalizePassword(input.password) || prev?.password;
    if (!password) {
      throw new BadRequestException({ code: 'CREDENTIALS_REQUIRED', message: 'An authorization code / password is required for the first connection.' });
    }
    const creds: MailboxCredentials = { email: input.email, password, imapHost: input.imapHost, imapPort: input.imapPort, imapTls: input.imapTls, smtpHost: input.smtpHost, smtpPort: input.smtpPort, smtpSecure: input.smtpSecure };
    // "Save and verify" actually verifies: a bad host/port/password is rejected
    // here instead of being silently stored and failing at sync time.
    if (input.purposes.inbound) {
      try {
        await this.mail.testImap(creds);
      } catch (error) {
        const message = error instanceof MailApiError ? error.message : '无法通过 IMAP 验证这个邮箱。';
        throw new BadRequestException({ code: 'MAILBOX_VERIFICATION_FAILED', message });
      }
    }
    if (input.purposes.outbound) {
      try {
        await this.mail.testSmtp(creds);
      } catch (error) {
        const message = error instanceof MailApiError ? error.message : '无法通过 SMTP 验证这个邮箱。';
        throw new BadRequestException({ code: 'MAILBOX_VERIFICATION_FAILED', message });
      }
    }
    const payload = {
      name: input.name || input.email,
      provider: input.provider,
      email: input.email,
      password,
      imapHost: input.imapHost,
      imapPort: input.imapPort,
      imapTls: input.imapTls,
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpSecure: input.smtpSecure,
      mailbox: input.mailbox,
      purposes: input.purposes,
      enabled: prev?.enabled ?? true,
      status: 'active',
      connectedAt: prev?.connectedAt || new Date().toISOString(),
      lastSyncedAt: prev?.lastSyncedAt || null,
    };
    const key = existing?.key || randomUUID();
    const saved = existing
      ? await this.db.workspaceSetting.update({ where: { id: existing.id }, data: { version: existing.version + 1, payload: payload as Prisma.InputJsonValue, updatedBy: identity.actorId } })
      : await this.db.workspaceSetting.create({
          data: { workspaceId: identity.workspaceId, kind: 'corporate_mailbox', key, version: 1, payload: payload as Prisma.InputJsonValue, updatedBy: identity.actorId },
        });
    await this.audit(identity, 'corporate_mailbox_configured', 'WorkspaceSetting', saved.id, { email: input.email, provider: input.provider });
    return serializeMailbox(key, payload);
  }

  async setCorporateMailboxEnabled(identity: Identity, id: string, enabled: boolean) {
    const existing = await this.getMailboxSetting(identity.workspaceId, id);
    if (!existing) throw new NotFoundException({ code: 'NOT_FOUND' });
    const payload = { ...(existing.payload as any), enabled };
    const updated = await this.db.workspaceSetting.update({
      where: { id: existing.id },
      data: { payload: payload as Prisma.InputJsonValue, version: existing.version + 1, updatedBy: identity.actorId },
    });
    await this.audit(identity, enabled ? 'corporate_mailbox_enabled' : 'corporate_mailbox_disabled', 'WorkspaceSetting', updated.id, {});
    return serializeMailbox(id, payload);
  }

  async syncCorporateMailbox(identity: Identity, id: string) {
    const existing = await this.getMailboxSetting(identity.workspaceId, id);
    if (!existing) throw new NotFoundException({ code: 'NOT_CONFIGURED' });
    const prev = existing.payload as any;
    let recentMessages: MailInboxMessage[] = [];
    if (prev.purposes?.inbound) {
      const creds: MailboxCredentials = { email: prev.email, password: prev.password, imapHost: prev.imapHost, imapPort: prev.imapPort, imapTls: prev.imapTls, smtpHost: prev.smtpHost, smtpPort: prev.smtpPort, smtpSecure: prev.smtpSecure };
      try {
        recentMessages = await this.mail.listRecentInbox(creds, 10);
      } catch (error) {
        const message = error instanceof MailApiError ? error.message : '无法连接邮箱进行同步。';
        throw new BadRequestException({ code: 'MAILBOX_SYNC_FAILED', message });
      }
    }
    const payload = { ...prev, lastSyncedAt: new Date().toISOString(), lastSyncMessageCount: recentMessages.length };
    const updated = await this.db.workspaceSetting.update({
      where: { id: existing.id },
      data: { payload: payload as Prisma.InputJsonValue, version: existing.version + 1, updatedBy: identity.actorId },
    });
    await this.audit(identity, 'corporate_mailbox_synced', 'WorkspaceSetting', updated.id, { messageCount: recentMessages.length });
    return { ...serializeMailbox(id, payload), recentMessages };
  }

  // Pulls resume-looking attachments out of unseen mail and feeds them into the
  // same intake pipeline a browser upload uses (Material -> ImportItem ->
  // candidate creation), so "Import from email" is real ingestion, not just a
  // status display. IMAP's own \Seen flag is the only dedupe state kept -- a
  // message this already imported from never comes back on the next click.
  async importFromMailbox(identity: Identity, id: string) {
    const existing = await this.getMailboxSetting(identity.workspaceId, id);
    if (!existing) throw new NotFoundException({ code: 'NOT_FOUND' });
    const payload = existing.payload as any;
    if (!payload.purposes?.inbound) {
      throw new BadRequestException({ code: 'INBOUND_NOT_ENABLED', message: '请先为该邮箱启用"用于收件 / Recruiting Inbox"。' });
    }
    const creds: MailboxCredentials = { email: payload.email, password: payload.password, imapHost: payload.imapHost, imapPort: payload.imapPort, imapTls: payload.imapTls, smtpHost: payload.smtpHost, smtpPort: payload.smtpPort, smtpSecure: payload.smtpSecure };
    let messages: MailAttachmentMessage[];
    try {
      messages = await this.mail.listUnseenResumeAttachments(creds, 20);
    } catch (error) {
      const message = error instanceof MailApiError ? error.message : '无法连接邮箱读取新邮件。';
      throw new BadRequestException({ code: 'MAILBOX_IMPORT_FAILED', message });
    }
    // createBatch()/saveUpload() always run originalname through decodeOriginalFileName()
    // (Buffer.from(name,'latin1').toString('utf8')), because that's the fix for how
    // Node's multipart parser mangles real HTTP uploads. imapflow already hands back a
    // correctly-decoded Unicode filename (it resolves MIME encoded-words itself), so
    // running it through that same fix a second time would mangle it again -- e.g. a
    // Chinese filename can come out containing an embedded NUL byte, which Postgres
    // rejects outright. Pre-encoding into the same raw latin1 representation here keeps
    // the single decode step consistent for every caller instead of special-casing channels.
    const files = messages.flatMap((m) =>
      m.attachments.map(
        (a) =>
          ({
            originalname: Buffer.from(a.filename, 'utf8').toString('latin1'),
            mimetype: a.mimetype,
            size: a.buffer.length,
            buffer: a.buffer,
          }) as unknown as Express.Multer.File,
      ),
    );
    let batchId: string | undefined;
    if (files.length) {
      const batch = await this.imports.createBatch(identity, files, 'email');
      batchId = batch.id;
      await this.mail.markSeen(creds, messages.map((m) => m.uid)).catch(() => undefined);
    }
    const updatedPayload = { ...payload, lastSyncedAt: new Date().toISOString(), lastSyncMessageCount: messages.length };
    await this.db.workspaceSetting.update({
      where: { id: existing.id },
      data: { payload: updatedPayload as Prisma.InputJsonValue, version: existing.version + 1, updatedBy: identity.actorId },
    });
    await this.audit(identity, 'corporate_mailbox_email_import', 'WorkspaceSetting', existing.id, { messagesScanned: messages.length, attachmentsImported: files.length });
    return { mailbox: serializeMailbox(id, updatedPayload), messagesScanned: messages.length, attachmentsImported: files.length, batchId };
  }

  private getMailboxSetting(workspaceId: string, id: string) {
    return this.db.workspaceSetting.findUnique({ where: { workspaceId_kind_key: { workspaceId, kind: 'corporate_mailbox', key: id } } });
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

function serializeMailbox(id: string, payload: any) {
  return {
    id,
    configured: true,
    enabled: payload.enabled !== false,
    name: payload.name,
    email: payload.email,
    provider: payload.provider,
    hasPassword: Boolean(payload.password),
    imapHost: payload.imapHost,
    imapPort: payload.imapPort,
    imapTls: payload.imapTls,
    smtpHost: payload.smtpHost,
    smtpPort: payload.smtpPort,
    smtpSecure: payload.smtpSecure,
    mailbox: payload.mailbox || 'INBOX',
    purposes: payload.purposes || { inbound: false, outbound: false },
    status: payload.status || 'active',
    connectedAt: payload.connectedAt,
    lastSyncedAt: payload.lastSyncedAt || null,
    lastSyncMessageCount: typeof payload.lastSyncMessageCount === 'number' ? payload.lastSyncMessageCount : null,
  };
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
