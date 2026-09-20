/* global require */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { dirname, extname, join, resolve } from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { PDFParse } from 'pdf-parse';
import * as mammoth from 'mammoth';
import { PrismaService } from '../persistence/prisma.service';
import type { ImportChannel } from './imports.types';
import { SecurityScanService } from './security-scan.service';

type Segment = { id: string; text: string; page?: number };
type MulterFile = Express.Multer.File;

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_TEXT_SIZE = 150000;
// Below this length, extracted text is too sparse to reliably identify a real duplicate
// (two failed/near-empty extractions would otherwise collide on the same hash).
const MIN_TEXT_HASH_LENGTH = 200;
const PDFJS_DIR = dirname(require.resolve('pdfjs-dist/package.json'));
const PDF_CMAP_URL = join(PDFJS_DIR, 'cmaps') + '/';
const PDF_STANDARD_FONT_DATA_URL = join(PDFJS_DIR, 'standard_fonts') + '/';

@Injectable()
export class MaterialsService {
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
    private readonly securityScan: SecurityScanService,
  ) {}

  async saveUpload(workspaceId: string, file?: MulterFile, sourceType: ImportChannel = 'manual_upload') {
    if (!file || !file.size) throw new BadRequestException({ code: 'EMPTY_FILE' });
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException({ code: 'FILE_TOO_LARGE', maxBytes: MAX_FILE_SIZE });
    }

    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const hash = createHash('sha256').update(file.buffer).digest('hex');
    const existing = await this.db.material.findFirst({
      where: { workspaceId, hash },
      select: { id: true, name: true, size: true, hash: true, readStatus: true, errorCode: true },
    });
    if (existing) return { kind: 'exact_file' as const, material: existing };

    // Every new file is scanned before extraction ever touches its bytes. A quarantined
    // file is still recorded (for audit) but never parsed, so its text can never leak
    // into a candidate profile.
    const scan = this.securityScan.scan(file.buffer, file.mimetype, originalName);
    const parsed = scan.status === 'quarantined'
      ? { mime: file.mimetype, text: '', segments: [] as Segment[], errorCode: scan.reason ?? 'SECURITY_QUARANTINED' }
      : await this.extract(originalName, file.mimetype, file.buffer);

    const normalizedText = normalizeTextForDedupe(parsed.text);
    const normalizedTextHash = normalizedText.length >= MIN_TEXT_HASH_LENGTH
      ? createHash('sha256').update(normalizedText).digest('hex')
      : null;

    const storageRoot = resolve(this.config.get<string>('STORAGE_DIR', '.local/materials'));
    await mkdir(storageRoot, { recursive: true, mode: 0o700 });
    const storageKey = randomUUID();
    const storagePath = join(storageRoot, storageKey);
    await writeFile(storagePath, file.buffer, { mode: 0o600, flag: 'wx' });

    try {
      const material = await this.db.material.create({
        data: {
          workspaceId,
          name: originalName.slice(0, 255),
          mime: parsed.mime,
          size: file.size,
          hash,
          normalizedTextHash,
          storageKey,
          text: parsed.text,
          segments: parsed.segments,
          readStatus: scan.status === 'quarantined' ? 'blocked' : parsed.errorCode ? 'failed' : 'available',
          securityStatus: scan.status,
          extractionStatus: scan.status === 'quarantined' ? 'blocked' : parsed.errorCode ? 'failed' : 'available',
          sourceType,
          errorCode: parsed.errorCode,
        },
      });
      return { kind: 'created' as const, material };
    } catch (error) {
      await unlink(storagePath).catch(() => undefined);
      throw error;
    }
  }

  async get(workspaceId: string, id: string) {
    const material = await this.db.material.findFirst({
      where: { id, workspaceId },
      select: {
        id: true, name: true, mime: true, size: true, hash: true, text: true,
        segments: true, readStatus: true, securityStatus: true, extractionStatus: true,
        sourceType: true, sourceRef: true, sourceVersion: true, errorCode: true, createdAt: true,
      },
    });
    if (!material) throw new NotFoundException({ code: 'NOT_FOUND' });
    return material;
  }

  async list(workspaceId: string) {
    const materials = await this.db.material.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      include: {
        resumeVersion: {
          include: { candidate: { select: { displayName: true } } },
        },
      },
    });
    return materials.map((material) => ({
      id: material.id,
      name: material.name,
      type: material.mime.split('/').at(-1)?.toUpperCase() || 'FILE',
      sizeKB: Math.max(1, Math.round(material.size / 1024)),
      source: 'Manual upload',
      uploadedAt: material.createdAt.toISOString(),
      readStatus: material.readStatus === 'available' ? 'available' : material.readStatus,
      extraction: material.extractionStatus === 'blocked' || material.errorCode === 'OCR_REQUIRED'
        ? 'blocked'
        : material.errorCode ? 'failed' : material.text ? 'complete' : 'partial',
      security: material.securityStatus,
      linked: material.resumeVersion?.candidate.displayName || 'Unassigned',
    }));
  }

  private async extract(name: string, suppliedMime: string, buffer: Buffer) {
    const ext = extname(name).toLowerCase();
    const mimeByExtension: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain',
    };
    const mime = mimeByExtension[ext];
    if (!mime) throw new BadRequestException({ code: 'UNSUPPORTED_FILE_TYPE' });
    if (ext === '.pdf' && buffer.subarray(0, 5).toString() !== '%PDF-') {
      throw new BadRequestException({ code: 'UNSUPPORTED_FILE_TYPE' });
    }
    if (ext === '.docx' && buffer.subarray(0, 2).toString() !== 'PK') {
      throw new BadRequestException({ code: 'UNSUPPORTED_FILE_TYPE' });
    }

    try {
      let segments: Segment[];
      if (ext === '.pdf') {
        const parser = new PDFParse({
          data: buffer,
          cMapUrl: PDF_CMAP_URL,
          cMapPacked: true,
          standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
        });
        try {
          const result = await parser.getText();
          segments = result.pages.flatMap((page) => splitText(page.text, page.num));
        } finally {
          await parser.destroy();
        }
      } else {
        const text = ext === '.docx'
          ? (await mammoth.extractRawText({ buffer })).value
          : new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        if (text.includes('\0')) throw new Error('binary');
        segments = splitText(text);
      }
      segments = segments.map((segment, index) => ({ ...segment, id: `s${index + 1}` }));
      const text = segments.map((segment) => segment.text).join('\n\n');
      const errorCode = !segments.length
        ? ext === '.pdf' ? 'OCR_REQUIRED' : 'NO_EXTRACTABLE_TEXT'
        : text.length > MAX_TEXT_SIZE ? 'DOCUMENT_TOO_LONG' : null;
      return {
        mime: mime || suppliedMime,
        text: errorCode === 'DOCUMENT_TOO_LONG' ? '' : text,
        segments: errorCode === 'DOCUMENT_TOO_LONG' ? [] : segments,
        errorCode,
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      return { mime, text: '', segments: [], errorCode: 'FILE_UNREADABLE' };
    }
  }
}

// Lowercases and collapses everything but alphanumerics/CJK to single spaces, so the same
// resume re-extracted from a different container format (PDF vs DOCX) or with cosmetic
// whitespace/punctuation differences still hashes identically.
export function normalizeTextForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitText(text: string, page?: number): Segment[] {
  return text
    .split(/\n\s*\n/)
    .flatMap((paragraph) => {
      const trimmed = paragraph.trim();
      const result: Segment[] = [];
      for (let start = 0; start < trimmed.length; start += 4000) {
        result.push({ id: '', text: trimmed.slice(start, start + 4000), ...(page ? { page } : {}) });
      }
      return result;
    })
    .filter((segment) => segment.text.length > 0);
}
