import { Injectable } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

export class MailApiError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

export interface MailboxCredentials {
  email: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

export interface MailInboxMessage {
  id: string;
  from: string;
  subject: string;
  date: string | null;
}

@Injectable()
export class MailService {
  private buildImapClient(creds: MailboxCredentials): ImapFlow {
    return new ImapFlow({
      host: creds.imapHost,
      port: creds.imapPort,
      secure: creds.imapTls,
      auth: { user: creds.email, pass: creds.password },
      logger: false,
    });
  }

  /** Connects and locks INBOX, then disconnects -- proves the address, password
   * (app password / auth code) and IMAP host/port actually work together. */
  async testImap(creds: MailboxCredentials): Promise<{ messagesExist: number }> {
    const client = this.buildImapClient(creds);
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        return { messagesExist: client.mailbox ? client.mailbox.exists : 0 };
      } finally {
        lock.release();
      }
    } catch (error) {
      throw new MailApiError(describeMailError(error, 'imap'), error);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  /** nodemailer's verify() does a real SMTP handshake + AUTH without sending a
   * message -- confirms outbound credentials without risking an actual send. */
  async testSmtp(creds: MailboxCredentials): Promise<void> {
    const transporter = nodemailer.createTransport({
      host: creds.smtpHost,
      port: creds.smtpPort,
      secure: creds.smtpSecure,
      auth: { user: creds.email, pass: creds.password },
    });
    try {
      await transporter.verify();
    } catch (error) {
      throw new MailApiError(describeMailError(error, 'smtp'), error);
    } finally {
      transporter.close();
    }
  }

  async listRecentInbox(creds: MailboxCredentials, maxResults = 10): Promise<MailInboxMessage[]> {
    const client = this.buildImapClient(creds);
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const exists = client.mailbox ? client.mailbox.exists : 0;
        if (!exists) return [];
        const range = `${Math.max(1, exists - maxResults + 1)}:*`;
        const messages: MailInboxMessage[] = [];
        for await (const msg of client.fetch({ seq: range }, { envelope: true })) {
          messages.push({
            id: String(msg.uid ?? msg.seq),
            from: msg.envelope?.from?.[0]?.address || msg.envelope?.from?.[0]?.name || '',
            subject: msg.envelope?.subject || '(no subject)',
            date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
          });
        }
        return messages.reverse();
      } finally {
        lock.release();
      }
    } catch (error) {
      throw new MailApiError(describeMailError(error, 'imap'), error);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
}

function describeMailError(error: unknown, protocol: 'imap' | 'smtp'): string {
  const err = error as { message?: string; code?: string; responseCode?: number };
  const label = protocol === 'imap' ? 'IMAP' : 'SMTP';
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return `${label} 服务器地址无法解析，请检查主机名。`;
  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') return `无法连接到 ${label} 服务器，请检查主机名和端口。`;
  if (err.responseCode === 535 || /invalid credentials|authentication failed|auth/i.test(err.message || '')) {
    return `${label} 认证失败，请检查邮箱地址和授权码（不是邮箱登录密码）。`;
  }
  return err.message ? `${label} 错误：${err.message}` : `无法连接到 ${label} 服务器。`;
}
