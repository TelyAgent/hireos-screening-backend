import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import type { Identity } from '../auth/workspace.guard';
import type { CriteriaInput } from './contracts';

export type RoleDraftInput = CriteriaInput & {
  roleSummary?: string;
  responsibilities?: string[];
  hiringContext?: Record<string, unknown>;
  successCriteria?: Array<Record<string, unknown>>;
  internalCompensation?: Record<string, unknown> | null;
  publicCompensation?: Record<string, unknown> | null;
  sourceRefs?: Array<Record<string, unknown>>;
  origin?: 'jd_module' | 'foundation_confirmed' | 'external_import';
};

export type RemoteCriteriaProjection = {
  requirements: CriteriaInput['requirements'];
  dimensions: CriteriaInput['dimensions'];
  roleSummary?: string;
  responsibilities: string[];
  hiringContext?: Record<string, unknown>;
  internalCompensation?: Record<string, unknown> | null;
  publicCompensation?: Record<string, unknown> | null;
  status: 'draft' | 'confirmed';
  versionNo: number;
  confirmedBy?: string;
  confirmedAt?: string;
};

@Injectable()
export class JobCriteriaFacade {
  private readonly remote: boolean;
  private readonly baseUrl: string;
  private readonly serviceName: string;

  constructor(private readonly config: ConfigService) {
    this.remote = config.get<string>('CORE_RECORD_MODE', 'mock') === 'remote';
    this.baseUrl = config.get<string>('JD_BASE_URL', 'http://127.0.0.1:3005/api').replace(/\/$/, '');
    this.serviceName = config.get<string>('CORE_RECORD_SERVICE_NAME', 'screening');
  }

  isRemote() {
    return this.remote;
  }

  async get(identity: Identity, jobId: string): Promise<RemoteCriteriaProjection | null> {
    if (!this.remote) return null;
    const response = await this.request(`/jobs/${jobId}/drafts/current`, identity, 'GET');
    if (response.status === 404) return null;
    const body = await parseBody(response);
    if (!response.ok) throw this.toException(response.status, body);
    return mapProjection(body);
  }

  async update(identity: Identity, jobId: string, input: RoleDraftInput): Promise<RemoteCriteriaProjection> {
    const response = await this.request(
      `/jobs/${jobId}/drafts/current`,
      identity,
      'PATCH',
      input,
      `screening:criteria:update:${identity.workspaceId}:${jobId}:${hash(input)}`,
    );
    const body = await parseBody(response);
    if (!response.ok) throw this.toException(response.status, body);
    return mapProjection(body);
  }

  async confirm(identity: Identity, jobId: string, input: RoleDraftInput): Promise<RemoteCriteriaProjection> {
    const current = await this.get(identity, jobId);
    if (!current) await this.update(identity, jobId, input);
    const response = await this.request(
      `/jobs/${jobId}/drafts/current/confirm`,
      identity,
      'POST',
      {},
      `screening:criteria:confirm:${identity.workspaceId}:${jobId}`,
    );
    const body = await parseBody(response);
    if (!response.ok) throw this.toException(response.status, body);
    return mapProjection(body);
  }

  async reopen(identity: Identity, jobId: string): Promise<RemoteCriteriaProjection> {
    const response = await this.request(
      `/jobs/${jobId}/drafts/current/reopen`,
      identity,
      'POST',
      {},
      `screening:criteria:reopen:${identity.workspaceId}:${jobId}`,
    );
    const body = await parseBody(response);
    if (!response.ok) throw this.toException(response.status, body);
    return mapProjection(body);
  }

  private async request(
    path: string,
    identity: Identity,
    method: 'GET' | 'PATCH' | 'POST',
    body?: unknown,
    idempotencyKey?: string,
  ) {
    try {
      return await globalThis.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-request-id': randomUUID(),
          'x-correlation-id': `${this.serviceName}:${randomUUID()}`,
          'x-source-service': this.serviceName,
          'x-workspace-id': identity.workspaceId,
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new ServiceUnavailableException({
        code: 'JD_BACKEND_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'JD backend is unavailable.',
      });
    }
  }

  private toException(status: number, body: unknown) {
    const error = body as { code?: string; message?: string };
    if (status === 409) return new ConflictException({ code: error.code || 'JD_CONFLICT', message: error.message });
    return new ServiceUnavailableException({ code: error.code || 'JD_BACKEND_ERROR', message: error.message || `JD backend returned HTTP ${status}.` });
  }
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function parseBody(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}

function mapProjection(body: unknown): RemoteCriteriaProjection {
  const value = body as {
    requirements?: unknown;
    dimensions?: unknown;
    roleSummary?: unknown;
    responsibilities?: unknown;
    hiringContext?: unknown;
    internalCompensation?: unknown;
    publicCompensation?: unknown;
    roleVersionStatus?: string;
    roleVersionNo?: number;
    roleConfirmedBy?: string;
    roleConfirmedAt?: string;
  };
  return {
    requirements: Array.isArray(value.requirements) ? value.requirements as CriteriaInput['requirements'] : [],
    dimensions: Array.isArray(value.dimensions) ? value.dimensions as CriteriaInput['dimensions'] : [],
    roleSummary: typeof value.roleSummary === 'string' ? value.roleSummary : undefined,
    responsibilities: Array.isArray(value.responsibilities) ? value.responsibilities.map(String) : [],
    hiringContext: asRecord(value.hiringContext),
    internalCompensation: asRecordOrNull(value.internalCompensation),
    publicCompensation: asRecordOrNull(value.publicCompensation),
    status: value.roleVersionStatus === 'confirmed' ? 'confirmed' : 'draft',
    versionNo: value.roleVersionNo || 0,
    confirmedBy: value.roleConfirmedBy,
    confirmedAt: value.roleConfirmedAt,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  return asRecord(value);
}
