import { Injectable } from '@nestjs/common';
import { DbService } from './db.service';

// The audit trail for changes that matter outside today's queue log: accounts, settings, feature switches, patient
// links, and (Phase 2) bookings, appointments, check-ins and staff overrides.
// Holds opaque references only — user:<id>, a record id — never a patient's name, HN, token or password.
export type ActorType = 'staff' | 'patient' | 'system' | 'his';
export type AuditEntry = {
  actorType: ActorType; actorId?: string; action: string; targetType?: string; targetId?: string;
  outcome?: 'ok' | 'denied' | 'failed'; reason?: string; requestId?: string; meta?: Record<string, unknown>;
};
export type AuditRow = AuditEntry & { id: number; createdAt: string };
type Row = { id: number; created_at: string; actor_type: ActorType; actor_id: string | null; action: string; target_type: string | null; target_id: string | null; outcome: 'ok' | 'denied' | 'failed'; reason: string | null; request_id: string | null; meta_json: string | null };
// Never written to the trail even if a caller passes them by mistake.
const SECRET_KEYS = /pass|token|secret|otp|hn|name|phone|citizen/i;

@Injectable()
export class AuditService {
  constructor(private readonly store: DbService) {}

  record(e: AuditEntry) {
    const meta = e.meta ? Object.fromEntries(Object.entries(e.meta).filter(([k]) => !SECRET_KEYS.test(k))) : undefined;
    this.store.db.prepare(`INSERT INTO audit_log (created_at, actor_type, actor_id, action, target_type, target_id, outcome, reason, request_id, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(new Date().toISOString(), e.actorType, e.actorId ?? null, e.action, e.targetType ?? null, e.targetId ?? null,
      e.outcome ?? 'ok', e.reason?.slice(0, 300) ?? null, e.requestId ?? null, meta && Object.keys(meta).length ? JSON.stringify(meta) : null);
  }

  // Newest first; optionally one record's history.
  list(f: { targetType?: string; targetId?: string; limit?: number } = {}): AuditRow[] {
    const limit = Math.min(500, Math.max(1, Math.floor(f.limit ?? 100)));
    const rows = (f.targetType
      ? this.store.db.prepare('SELECT * FROM audit_log WHERE target_type = ? AND (? IS NULL OR target_id = ?) ORDER BY id DESC LIMIT ?').all(f.targetType, f.targetId ?? null, f.targetId ?? null, limit)
      : this.store.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit)) as Row[];
    return rows.map((r) => ({ id: r.id, createdAt: r.created_at, actorType: r.actor_type, actorId: r.actor_id ?? undefined, action: r.action,
      targetType: r.target_type ?? undefined, targetId: r.target_id ?? undefined, outcome: r.outcome, reason: r.reason ?? undefined,
      requestId: r.request_id ?? undefined, meta: r.meta_json ? JSON.parse(r.meta_json) : undefined }));
  }
}
