import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AuditService } from './audit.service';
import { DbService } from './db.service';
import { AppError } from './errors';

// How long records are kept (spec §14.3, pilot decision D7). Two kinds of clean-up run every 6 hours:
//  • housekeeping, always on: things that are useless once expired — retry keys (7 days), expired staff / patient
//    sessions, used or expired link codes, expired queue-slip links, LINE codes;
//  • records, per category, set by an administrator in days (0 = keep for ever — the default until the hospital
//    decides). Only finished records go: a booking or appointment that is still CONFIRMED, an active LINE link, a
//    message still waiting to be sent, or today's queue are never touched, whatever the setting.
// A patient record (HN) left with nothing pointing at it is removed with the last record that used it.
export type Category = 'bookings' | 'appointments' | 'queue' | 'lineLinks' | 'notifications' | 'audit';
export type Retention = Record<Category, number>;
export const CATEGORIES: Category[] = ['bookings', 'appointments', 'queue', 'lineLinks', 'notifications', 'audit'];
export const KEEP_FOREVER: Retention = { bookings: 0, appointments: 0, queue: 0, lineLinks: 0, notifications: 0, audit: 0 };
const MIN_DAYS = 30, MAX_DAYS = 3650;
export type RunResult = { at: string; dryRun: boolean; removed: Record<string, number> };
const DAY = 86_400_000;
type Step = { name: string; count: string; del: string; args: (cut: string) => unknown[] };

// What each category removes, children before parents (foreign keys are on). `cut`: ISO time (or YYYY-MM-DD for the
// queue) before which finished records go.
const RULES: Record<Category, Step[]> = {
  bookings: [
    { name: 'check-ins', count: `SELECT COUNT(*) AS n FROM check_in_records WHERE source_type = 'BOOKING' AND source_id IN (SELECT b.id FROM bookings b JOIN booking_slots s ON s.id = b.slot_id WHERE b.status <> 'CONFIRMED' AND s.starts_at < ?)`,
      del: `DELETE FROM check_in_records WHERE source_type = 'BOOKING' AND source_id IN (SELECT b.id FROM bookings b JOIN booking_slots s ON s.id = b.slot_id WHERE b.status <> 'CONFIRMED' AND s.starts_at < ?)`, args: (c) => [c] },
    { name: 'bookings', count: `SELECT COUNT(*) AS n FROM bookings WHERE status <> 'CONFIRMED' AND slot_id IN (SELECT id FROM booking_slots WHERE starts_at < ?)`,
      del: `DELETE FROM bookings WHERE status <> 'CONFIRMED' AND slot_id IN (SELECT id FROM booking_slots WHERE starts_at < ?)`, args: (c) => [c] },
    { name: 'booking slots', count: `SELECT COUNT(*) AS n FROM booking_slots s WHERE s.starts_at < ? AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id)`,
      del: `DELETE FROM booking_slots WHERE starts_at < ? AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = booking_slots.id)`, args: (c) => [c] },
  ],
  appointments: [
    { name: 'requests to move', count: `SELECT COUNT(*) AS n FROM appointment_reschedule_requests WHERE status <> 'PENDING' AND appointment_id IN (SELECT a.id FROM appointments a JOIN appointment_slots s ON s.id = a.slot_id WHERE a.status <> 'CONFIRMED' AND s.starts_at < ?)`,
      del: `DELETE FROM appointment_reschedule_requests WHERE status <> 'PENDING' AND appointment_id IN (SELECT a.id FROM appointments a JOIN appointment_slots s ON s.id = a.slot_id WHERE a.status <> 'CONFIRMED' AND s.starts_at < ?)`, args: (c) => [c] },
    { name: 'check-ins', count: `SELECT COUNT(*) AS n FROM check_in_records WHERE source_type = 'APPOINTMENT' AND source_id IN (SELECT a.id FROM appointments a JOIN appointment_slots s ON s.id = a.slot_id WHERE a.status <> 'CONFIRMED' AND s.starts_at < ?)`,
      del: `DELETE FROM check_in_records WHERE source_type = 'APPOINTMENT' AND source_id IN (SELECT a.id FROM appointments a JOIN appointment_slots s ON s.id = a.slot_id WHERE a.status <> 'CONFIRMED' AND s.starts_at < ?)`, args: (c) => [c] },
    { name: 'appointments', count: `SELECT COUNT(*) AS n FROM appointments a WHERE a.status <> 'CONFIRMED' AND a.slot_id IN (SELECT id FROM appointment_slots WHERE starts_at < ?) AND NOT EXISTS (SELECT 1 FROM appointment_reschedule_requests r WHERE r.appointment_id = a.id)`,
      del: `DELETE FROM appointments WHERE status <> 'CONFIRMED' AND slot_id IN (SELECT id FROM appointment_slots WHERE starts_at < ?) AND NOT EXISTS (SELECT 1 FROM appointment_reschedule_requests r WHERE r.appointment_id = appointments.id)`, args: (c) => [c] },
    { name: 'appointment slots', count: `SELECT COUNT(*) AS n FROM appointment_slots s WHERE s.starts_at < ? AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id) AND NOT EXISTS (SELECT 1 FROM appointment_reschedule_requests r WHERE r.requested_slot_id = s.id)`,
      del: `DELETE FROM appointment_slots WHERE starts_at < ? AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = appointment_slots.id) AND NOT EXISTS (SELECT 1 FROM appointment_reschedule_requests r WHERE r.requested_slot_id = appointment_slots.id)`, args: (c) => [c] },
    { name: 'doctor sessions', count: `SELECT COUNT(*) AS n FROM provider_schedules p WHERE p.ends_at < ? AND NOT EXISTS (SELECT 1 FROM appointment_slots s WHERE s.schedule_id = p.id)`,
      del: `DELETE FROM provider_schedules WHERE ends_at < ? AND NOT EXISTS (SELECT 1 FROM appointment_slots s WHERE s.schedule_id = provider_schedules.id)`, args: (c) => [c] },
  ],
  // Whole days of the live queue: the action log, the patients (visits), their numbers and queue-slip links.
  queue: [
    { name: 'queue log', count: 'SELECT COUNT(*) AS n FROM queue_events WHERE day < ?', del: 'DELETE FROM queue_events WHERE day < ?', args: (d) => [d] },
    { name: 'visits', count: 'SELECT COUNT(*) AS n FROM visits WHERE day < ?', del: 'DELETE FROM visits WHERE day < ?', args: (d) => [d] },
    { name: 'queue numbers', count: 'SELECT COUNT(*) AS n FROM queue_counters WHERE day < ?', del: 'DELETE FROM queue_counters WHERE day < ?', args: (d) => [d] },
    { name: 'walk-in check-ins', count: `SELECT COUNT(*) AS n FROM check_in_records WHERE source_type = 'WALK_IN' AND visit_day < ?`, del: `DELETE FROM check_in_records WHERE source_type = 'WALK_IN' AND visit_day < ?`, args: (d) => [d] },
    { name: 'queue-slip links', count: 'SELECT COUNT(*) AS n FROM tickets WHERE day < ?', del: 'DELETE FROM tickets WHERE day < ?', args: (d) => [d] },
  ],
  lineLinks: [
    { name: 'ended LINE links', count: `SELECT COUNT(*) AS n FROM line_patient_links WHERE status <> 'ACTIVE' AND COALESCE(ended_at, created_at) < ?`,
      del: `DELETE FROM line_patient_links WHERE status <> 'ACTIVE' AND COALESCE(ended_at, created_at) < ?`, args: (c) => [c] },
  ],
  notifications: [
    { name: 'message attempts', count: `SELECT COUNT(*) AS n FROM notification_logs WHERE job_id IN (SELECT id FROM notification_jobs WHERE status IN ('SENT','FAILED','CANCELLED','SKIPPED') AND updated_at < ?)`,
      del: `DELETE FROM notification_logs WHERE job_id IN (SELECT id FROM notification_jobs WHERE status IN ('SENT','FAILED','CANCELLED','SKIPPED') AND updated_at < ?)`, args: (c) => [c] },
    { name: 'messages', count: `SELECT COUNT(*) AS n FROM notification_jobs WHERE status IN ('SENT','FAILED','CANCELLED','SKIPPED') AND updated_at < ?`,
      del: `DELETE FROM notification_jobs WHERE status IN ('SENT','FAILED','CANCELLED','SKIPPED') AND updated_at < ?`, args: (c) => [c] },
  ],
  audit: [
    { name: 'audit entries', count: 'SELECT COUNT(*) AS n FROM audit_log WHERE created_at < ?', del: 'DELETE FROM audit_log WHERE created_at < ?', args: (c) => [c] },
  ],
};
// Patient records (HN) nothing refers to any more.
const ORPHAN = `FROM patient_profiles p WHERE p.updated_at < ?
  AND NOT EXISTS (SELECT 1 FROM bookings x WHERE x.patient_profile_id = p.id) AND NOT EXISTS (SELECT 1 FROM appointments x WHERE x.patient_profile_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM line_patient_links x WHERE x.patient_profile_id = p.id) AND NOT EXISTS (SELECT 1 FROM check_in_records x WHERE x.patient_profile_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM visits x WHERE x.patient_profile_id = p.id) AND NOT EXISTS (SELECT 1 FROM notification_jobs x WHERE x.target_type = 'PROFILE' AND x.target_id = p.id)`;

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Retention');
  private timer?: NodeJS.Timeout;
  now = () => new Date();
  constructor(private readonly store: DbService, private readonly audit: AuditService) {}

  onModuleInit() { this.safeRun(); this.timer = setInterval(() => this.safeRun(), 6 * 3600_000); this.timer.unref(); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  private safeRun() { try { this.run(); } catch (err) { this.log.error(`clean-up failed: ${(err as Error).message}`); } }

  settings(): Retention { return { ...KEEP_FOREVER, ...(this.store.getKv<Partial<Retention>>('retention') ?? {}) }; }
  lastRun(): RunResult | undefined { return this.store.getKv<RunResult>('retention.last'); }
  // 0 = keep for ever, else 30–3650 days. Audit entries: at least as long as every category with a period, so the trail
  // of a removed record never goes before the record itself.
  check(patch: unknown): Retention {
    if (!patch || typeof patch !== 'object') throw new AppError('VALIDATION_ERROR', 'ไม่มีค่าที่จะบันทึก');
    const next = this.settings();
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (!CATEGORIES.includes(k as Category)) throw new AppError('VALIDATION_ERROR', `ไม่รู้จักหมวด ${k}`);
      if (!Number.isInteger(v) || ((v as number) !== 0 && ((v as number) < MIN_DAYS || (v as number) > MAX_DAYS)))
        throw new AppError('VALIDATION_ERROR', `ระยะเวลาเก็บต้องเป็น 0 (เก็บตลอด) หรือ ${MIN_DAYS}–${MAX_DAYS} วัน`);
      next[k as Category] = v as number;
    }
    const longest = Math.max(0, ...CATEGORIES.filter((c) => c !== 'audit').map((c) => next[c]));
    if (next.audit && next.audit < longest) throw new AppError('POLICY_REJECTED', 'บันทึกการใช้งานต้องเก็บนานไม่น้อยกว่าหมวดอื่น (หรือเก็บตลอด)');
    return next;
  }
  set(patch: unknown, by: string): Retention {
    const next = this.check(patch);
    this.store.setKv('retention', next);
    this.audit.record({ actorType: 'staff', actorId: by, action: 'retention.update', targetType: 'settings', targetId: 'retention', meta: next });
    return next;
  }

  // dryRun: count only (what the settings would remove now). `with`: try other settings without saving them.
  run(opts: { dryRun?: boolean; with?: Retention } = {}): RunResult {
    const s = opts.with ?? this.settings(), now = this.now(), removed: Record<string, number> = {};
    const add = (name: string, n: number) => { if (n) removed[name] = (removed[name] ?? 0) + n; };
    const exec = (sql: string, count: string, args: unknown[], name: string) =>
      add(name, opts.dryRun ? (this.store.db.prepare(count).get(...(args as never[])) as { n: number }).n : Number(this.store.db.prepare(sql).run(...(args as never[])).changes));
    this.store.tx(() => {
      for (const c of CATEGORIES) {
        if (!s[c]) continue;
        const at = new Date(now.getTime() - s[c] * DAY), cut = c === 'queue' ? at.toLocaleDateString('sv-SE') : at.toISOString();
        for (const step of RULES[c]) exec(step.del, step.count, step.args(cut), step.name);
      }
      if (!opts.dryRun) this.housekeeping(now, add);
      const orphanCut = new Date(now.getTime() - DAY).toISOString(); // a record made in the last day may be about to be used
      exec(`DELETE FROM patient_profiles WHERE id IN (SELECT p.id ${ORPHAN})`, `SELECT COUNT(*) AS n ${ORPHAN}`, [orphanCut], 'patient records');
    });
    const result: RunResult = { at: now.toISOString(), dryRun: !!opts.dryRun, removed };
    if (!opts.dryRun) {
      this.store.setKv('retention.last', result);
      if (Object.keys(removed).length) {
        this.audit.record({ actorType: 'system', action: 'retention.purge', targetType: 'database', meta: removed });
        this.log.log(`removed ${Object.entries(removed).map(([k, n]) => `${n} ${k}`).join(', ')}`);
      }
    }
    return result;
  }

  private housekeeping(now: Date, add: (name: string, n: number) => void) {
    const iso = now.toISOString(), del = (sql: string, ...args: string[]) => Number(this.store.db.prepare(sql).run(...args).changes);
    add('retry keys', del('DELETE FROM idempotency_keys WHERE created_at < ?', new Date(now.getTime() - 7 * DAY).toISOString()));
    add('staff sessions', del('DELETE FROM sessions WHERE expires_at < ?', iso));
    add('patient sessions', del('DELETE FROM patient_sessions WHERE expires_at < ?', iso));
    add('link codes', del('DELETE FROM link_requests WHERE created_at < ?', new Date(now.getTime() - DAY).toISOString()));
    if (this.has('line_codes')) add('LINE codes', del('DELETE FROM line_codes WHERE expires_at < ?', iso));
    // Queue-slip links a week after they expired (their day's queue may still be kept).
    if (this.has('tickets')) {
      const old = new Date(now.getTime() - 7 * DAY).toISOString();
      if (this.has('line_links')) add('LINE queue subscriptions', del('DELETE FROM line_links WHERE ticket IN (SELECT token FROM tickets WHERE expires_at < ?)', old));
      add('queue-slip links', del('DELETE FROM tickets WHERE expires_at < ? AND parent IS NOT NULL', old));
      add('queue-slip links', del('DELETE FROM tickets WHERE expires_at < ? AND token NOT IN (SELECT parent FROM tickets WHERE parent IS NOT NULL)', old));
    }
  }
  private has(table: string) { return !!this.store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table); }
}
