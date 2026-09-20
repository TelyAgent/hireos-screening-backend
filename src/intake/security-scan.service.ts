import { Injectable } from '@nestjs/common';

export type SecurityScanResult = { status: 'passed' | 'quarantined'; reason?: string };

// Signatures checked regardless of the extension the uploader claims, as defense against
// a file whose true content does not match its declared type.
const EXECUTABLE_SIGNATURES: Array<{ bytes: number[]; reason: string }> = [
  { bytes: [0x4d, 0x5a], reason: 'EXECUTABLE_SIGNATURE_DETECTED' }, // MZ: Windows PE
  { bytes: [0x7f, 0x45, 0x4c, 0x46], reason: 'EXECUTABLE_SIGNATURE_DETECTED' }, // \x7fELF: Linux ELF
  { bytes: [0x23, 0x21], reason: 'SCRIPT_SHEBANG_DETECTED' }, // #!: shell/interpreter script
];

/**
 * Adapter boundary for pre-extraction file safety checks. This intentionally stays a
 * dependency-free heuristic layer (no real antivirus/OCR integration, per the import
 * chain plan's non-goals): it flags known-risky byte signatures so a resume upload never
 * reaches text extraction unexamined. Swap the body of `scan()` for a call to a real
 * scanning service later without touching any caller.
 */
@Injectable()
export class SecurityScanService {
  scan(buffer: Buffer, mime: string, fileName: string): SecurityScanResult {
    for (const signature of EXECUTABLE_SIGNATURES) {
      if (bufferStartsWith(buffer, signature.bytes)) {
        return { status: 'quarantined', reason: signature.reason };
      }
    }

    const lowerName = fileName.toLowerCase();

    if (mime.includes('pdf') || lowerName.endsWith('.pdf')) {
      if (containsAny(buffer, ['/JavaScript', '/JS', '/OpenAction', '/AA', '/Launch'])) {
        return { status: 'quarantined', reason: 'PDF_ACTIVE_CONTENT_DETECTED' };
      }
    }

    if (mime.includes('officedocument') || lowerName.endsWith('.docx')) {
      if (containsAny(buffer, ['vbaProject.bin'])) {
        return { status: 'quarantined', reason: 'OFFICE_MACRO_DETECTED' };
      }
    }

    return { status: 'passed' };
  }
}

function bufferStartsWith(buffer: Buffer, bytes: number[]) {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function containsAny(buffer: Buffer, needles: string[]) {
  return needles.some((needle) => buffer.includes(Buffer.from(needle, 'latin1')));
}
