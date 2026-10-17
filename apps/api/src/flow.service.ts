import { Injectable } from '@nestjs/common';
export type FlowUpdate = {
  eventId: string;
  occurredAt: string;
  servicePointId: string;
  queueCount: number;
  averageWaitMinutes: number;
  source: 'demo' | 'his-adapter';
};
@Injectable()
export class FlowService {
  private readonly latest = new Map<string, FlowUpdate>();
  apply(update: FlowUpdate) {
    // Production: validate schema, source authorization, timestamp, idempotency,
    // and persist via transaction + outbox before broadcasting.
    if (update.queueCount < 0 || update.averageWaitMinutes < 0) {
      throw new Error('Queue metrics cannot be negative');
    }
    const previous = this.latest.get(update.servicePointId);
    if (previous && Date.parse(previous.occurredAt) > Date.parse(update.occurredAt)) {
      return { accepted: false, reason: 'stale-event' as const };
    }
    this.latest.set(update.servicePointId, update);
    return { accepted: true as const, update };
  }
  snapshot() { return [...this.latest.values()]; }
}
