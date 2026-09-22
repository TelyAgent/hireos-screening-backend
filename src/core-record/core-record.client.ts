import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
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

export type CoreMaterial = {
  id: string;
  name: string;
  mime: string;
  size: number;
  hash: string;
  readStatus: string;
  securityStatus: string;
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

  /**
   * Registers a file with Core Record's shared Material master (see
   * docs/HireOS-Database-Architecture-Decision.md §4.1) -- mirrors createCandidate/
   * createJob/createApplication's mock/remote split: in 'mock' mode this returns null
   * and MaterialsService.saveUpload falls back to its old local-only behavior (local
   * hash dedup, local disk write) exactly like it did before this migration.
   */
  async uploadMaterial(identity: Identity, file: { buffer: Buffer; originalname: string; mimetype: string }): Promise<CoreMaterial | null> {
    if (this.mode === 'mock') return null;
    const form = new FormData();
    // Buffer's underlying ArrayBufferLike can theoretically be a SharedArrayBuffer, which
    // BlobPart's type doesn't accept -- Uint8Array.from copies into a plain, freshly
    // allocated ArrayBuffer to satisfy that.
    form.append('file', new Blob([Uint8Array.from(file.buffer)], { type: file.mimetype }), file.originalname);
    const response = await globalThis.fetch(`${this.baseUrl}/materials`, {
      method: 'POST',
      headers: {
        'x-request-id': randomUUID(),
        'x-correlation-id': `${this.serviceName}:${randomUUID()}`,
        'x-source-service': this.serviceName,
        'x-workspace-id': identity.workspaceId,
        'idempotency-key': randomUUID(),
      },
      body: form,
    });
    const body = await parseBody(response);
    if (!response.ok) {
      const error = body as { code?: string; message?: string };
      throw new ServiceUnavailableException({
        code: error.code || 'CORE_RECORD_UNAVAILABLE',
        message: error.message || `Core Record returned HTTP ${response.status}.`,
      });
    }
    return body as CoreMaterial;
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
        ...(input.idempotencyKey ? { 'idempotency-key': hashIdempotencyKey(input.idempotencyKey) } : {}),
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

function hashIdempotencyKey(raw: string): string {
  // Idempotency keys often embed free-text (candidate names, job titles) which
  // may contain non-Latin1 characters; HTTP header values must be ByteStrings,
  // so hash rather than pass the raw text through.
  return createHash('sha256').update(raw).digest('hex');
}

async function parseBody(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}
