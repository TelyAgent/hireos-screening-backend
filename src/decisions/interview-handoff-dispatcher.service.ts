import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../persistence/prisma.service';

const POLL_INTERVAL_MS = 2000;
const BATCH_SIZE = 10;
// After this many failed attempts, stop retrying automatically -- a human can requeue
// (reset status to 'pending') once whatever was wrong with Interview is fixed.
const MAX_ATTEMPTS = 10;

/**
 * Delivers ScreeningOutboxEvent rows to the subsystem that needs to know about them.
 * This is the "transport" half of the outbox pattern described in
 * docs/HireOS-Database-Architecture-Decision.md §7/§9 -- plain HTTP today because no
 * real event bus (Redis Streams etc.) is deployed yet. The event envelope this writes
 * (stable ids + a summary) is the same one a real event bus would carry, so swapping
 * the delivery mechanism later never requires changing DecisionsService or the
 * receiving endpoint, only this dispatcher.
 *
 * Polling + lease-free retry mirrors the pattern already used by
 * DiscoveryService/ImportsService in this codebase, scaled down: volume here is a
 * handful of decisions a day, not a resume-parsing queue, so a simple compare-and-swap
 * on `status` is enough -- no lease token needed for a single-worker dev deployment.
 */
@Injectable()
export class InterviewHandoffDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InterviewHandoffDispatcherService.name);
  private timer?: ReturnType<typeof globalThis.setInterval>;
  private running = false;

  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    this.timer = globalThis.setInterval(() => void this.dispatchPending(), POLL_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) globalThis.clearInterval(this.timer);
  }

  private async dispatchPending() {
    if (this.running) return;
    this.running = true;
    try {
      const events = await this.db.screeningOutboxEvent.findMany({
        where: { status: 'pending', attempt: { lt: MAX_ATTEMPTS } },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      });
      for (const event of events) {
        await this.dispatchOne(event);
      }
    } finally {
      this.running = false;
    }
  }

  private async dispatchOne(event: { id: string; eventType: string; payload: unknown; attempt: number }) {
    const baseUrl = this.config.get<string>('INTERVIEW_BASE_URL', 'http://127.0.0.1:3001/api').replace(/\/$/, '');
    const endpoint = this.endpointFor(event.eventType);
    if (!endpoint) {
      // No receiver registered for this event type -- not a delivery failure, just
      // nothing subscribes to it (yet). Mark dispatched so it stops being polled.
      await this.db.screeningOutboxEvent.update({ where: { id: event.id }, data: { status: 'dispatched', dispatchedAt: new Date() } });
      return;
    }
    try {
      const response = await globalThis.fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event.payload),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await this.db.screeningOutboxEvent.update({ where: { id: event.id }, data: { status: 'dispatched', dispatchedAt: new Date() } });
    } catch (error) {
      const attempt = event.attempt + 1;
      const message = error instanceof Error ? error.message.slice(0, 500) : 'DISPATCH_FAILED';
      this.logger.warn(`Failed to dispatch ${event.eventType} (${event.id}), attempt ${attempt}: ${message}`);
      await this.db.screeningOutboxEvent.update({
        where: { id: event.id },
        data: { attempt, status: attempt >= MAX_ATTEMPTS ? 'failed' : 'pending', lastError: message },
      });
    }
  }

  private endpointFor(eventType: string): string | null {
    if (eventType === 'candidate.advanced_to_interview') return '/screening-handoff';
    return null;
  }
}
