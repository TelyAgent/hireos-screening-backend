import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Identity } from '../auth/workspace.guard';

type CoreRecordMode = 'mock' | 'remote';

export type CoreCandidate = {
  id: string;
  workspaceId: string;
  displayName: string;
  email?: string;
  phone?: string;
  ownerId: string;
  version: number;
};

export type CoreJob = {
  id: string;
  workspaceId: string;
  title: string;
  team?: string;
  location?: string;
  employmentType?: string;
  seniority?: string;
  status: string;
  openings: number;
  version: number;
};

export type CoreApplication = {
  id: string;
  workspaceId: string;
  candidateId: string;
  jobId: string;
  cycleId: string;
  status: string;
  origin: string;
  linkReason: string;
  linkedBy: string;
  version: number;
};

@Injectable()
export class CoreRecordClient {
  private readonly mode: CoreRecordMode;
  private readonly baseUrl: string;
  private readonly serviceName: string;

  constructor(private readonly config: ConfigService) {
    const configuredMode = this.config.get<string>('CORE_RECORD_MODE', 'mock');
    this.mode = configuredMode === 'remote' ? 'remote' : 'mock';
    this.baseUrl = this.config.get<string>('CORE_RECORD_BASE_URL', 'http://127.0.0.1:3004/api/v1').replace(/\/$/, '');
    this.serviceName = this.config.get<string>('CORE_RECORD_SERVICE_NAME', 'screening');
  }

  getStatus() {
    return { mode: this.mode, baseUrl: this.baseUrl, serviceName: this.serviceName };
  }

  async createCandidate(
    identity: Identity,
    input: { displayName: string; email?: string; phone?: string; source?: string },
    idempotencyKey: string = randomUUID(),
  ): Promise<CoreCandidate | null> {
    if (this.mode === 'mock') return null;
    return this.request<CoreCandidate>('/candidates', identity, {
      method: 'POST',
      idempotencyKey,
      body: input,
    });
  }

  async createJob(
    identity: Identity,
    input: { title: string; team?: string; location?: string; employmentType?: string; seniority?: string; openings?: number; status?: string },
    idempotencyKey: string = randomUUID(),
  ): Promise<CoreJob | null> {
    if (this.mode === 'mock') return null;
    return this.request<CoreJob>('/jobs', identity, {
      method: 'POST',
      idempotencyKey,
      body: input,
    });
  }

  async createApplication(
    identity: Identity,
    input: { candidateId: string; jobId: string; cycleId?: string; origin?: string; linkReason: string },
    idempotencyKey: string = randomUUID(),
  ): Promise<CoreApplication | null> {
    if (this.mode === 'mock') return null;
    return this.request<CoreApplication>('/applications', identity, {
      method: 'POST',
      idempotencyKey,
      body: input,
    });
  }

  private async request<T>(
    path: string,
    identity: Identity,
    input: { method: 'GET' | 'POST'; idempotencyKey?: string; body?: unknown },
  ): Promise<T> {
    const response = await globalThis.fetch(`${this.baseUrl}${path}`, {
      method: input.method,
      headers: {
        'content-type': 'application/json',
        'x-request-id': randomUUID(),
        'x-correlation-id': `${this.serviceName}:${randomUUID()}`,
        'x-source-service': this.serviceName,
        'x-workspace-id': identity.workspaceId,
        ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    });
    const body = await parseBody(response);
    if (!response.ok) {
      const error = body as { code?: string; message?: string };
      if (response.status === 409) {
        throw new ConflictException({ code: error.code || 'CORE_RECORD_CONFLICT', message: error.message || 'Core Record rejected the request.' });
      }
      throw new ServiceUnavailableException({
        code: error.code || 'CORE_RECORD_UNAVAILABLE',
        message: error.message || `Core Record returned HTTP ${response.status}.`,
      });
    }
    return body as T;
  }
}

async function parseBody(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}
