import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import { localInstant, maskHN } from './booking.service';
import { DbService } from './db.service';
import { AppError } from './errors';

// Doctor appointments — separate from general booking: own rules per clinic, own capacity (a doctor's session split
// into slots), own codes (AP…). Typically made by staff for the next visit ("นัดครั้งหน้า"); patients see, cancel and
// ask to move theirs from LINE in a later stage.
// Moving an appointment takes the new place and gives back the old one in the same transaction: if the new slot is
// full, nothing changes. A request to move (when the clinic wants to approve moves) holds no place until approved.
// NO_SHOW: only by a supervisor, after the appointment's time, with a reason. Unanswered LINE messages mean nothing.
export type ApptPolicy = { clinicCode: string; displayName: string; enabled: boolean; advanceDays: number; cancelCutoffMinutes: number; rescheduleNeedsApproval: boolean;
  patientSelectsProvider: boolean; queuePrefix?: string; checkinEarlyMinutes: number; checkinLateMinutes: number; version: number };
// roomId: the OPD exam room the doctor works in for this session (optional) — appointment patients wait for that room.
export type Session = { id: string; providerCode: string; providerName: string; clinicCode: string; startsAt: string; endsAt: string; status: 'OPEN' | 'CLOSED' | 'CANCELLED'; capacity: number; reserved: number; roomId?: string };
export type ApptSlot = { id: string; scheduleId: string; providerCode: string; providerName: string; clinicCode: string; startsAt: string; endsAt: string; capacity: number; reserved: number; remaining: number; status: 'OPEN' | 'CLOSED' | 'CANCELLED' };
export type ApptStatus = 'CONFIRMED' | 'CANCELLED' | 'CHECKED_IN' | 'COMPLETED' | 'NO_SHOW' | 'EXPIRED';
export type Appointment = { id: string; code: string; clinicCode: string; clinicName: string; providerCode: string; providerName: string; startsAt: string; endsAt: string;
  status: ApptStatus; channel: 'STAFF' | 'LINE'; hn: string; createdAt: string; roomId?: string; cancellationReason?: string; noShowReason?: string; visitId?: string;
  pendingRequest?: { id: string; startsAt: string; endsAt: string; providerName: string; reason?: string } };
export type RescheduleRequest = { id: string; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'; reason?: string; createdAt: string; decisionNote?: string;
  appointment: Appointment; to: { slotId: string; startsAt: string; endsAt: string; providerName: string } };
export type Actor = { kind: 'staff'; id: number; canOverride: boolean } | { kind: 'patient'; profileId: string };

export const ROOM_RE = /^opd-\d{3,4}$/;
const CLINIC_RE = /^opd-\d-\d{1,2}$/, PROVIDER_RE = /^[A-Za-z0-9ก-๙._-]{1,20}$/, DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CODE_CHARS = 'ACDEFGHJKLMNPQRTUVWXY3479';
const bad = (reason: string) => new AppError('VALIDATION_ERROR', reason);
const newId = (p: string) => `${p}_${randomBytes(9).toString('base64url')}`;
const localDate = (d: Date) => d.toLocaleDateString('sv-SE');
const dayRange = (date: string) => { const from = localInstant(date, '00:00'), to = new Date(from); to.setDate(to.getDate() + 1); return [from.toISOString(), to.toISOString()]; };
const actorRef = (a: Actor) => a.kind === 'staff' ? `user:${a.id}` : 'patient';

type PolicyRow = { clinic_code: string; display_name: string; enabled: number; advance_days: number; cancel_cutoff_minutes: number; reschedule_needs_approval: number;
  patient_selects_provider: number; queue_prefix: string | null; checkin_early_minutes: number; checkin_late_minutes: number; policy_version: number };
type SlotRow = { id: string; schedule_id: string; starts_at: string; ends_at: string; capacity: number; reserved_count: number; status: ApptSlot['status'];
  provider_code: string; provider_name: string; clinic_code: string; schedule_status: ApptSlot['status'] };
type ApptRow = { id: string; appointment_code: string; clinic_code: string; provider_code: string; status: ApptStatus; channel: 'STAFF' | 'LINE'; created_at: string;
  cancellation_reason: string | null; no_show_reason: string | null; visit_id: string | null; starts_at: string; ends_at: string; provider_name: string; display_name: string | null; hn: string | null; room_id: string | null };
const toPolicy = (r: PolicyRow): ApptPolicy => ({ clinicCode: r.clinic_code, displayName: r.display_name, enabled: !!r.enabled, advanceDays: r.advance_days,
  cancelCutoffMinutes: r.cancel_cutoff_minutes, rescheduleNeedsApproval: !!r.reschedule_needs_approval, patientSelectsProvider: !!r.patient_selects_provider,
  queuePrefix: r.queue_prefix ?? undefined, checkinEarlyMinutes: r.checkin_early_minutes, checkinLateMinutes: r.checkin_late_minutes, version: r.policy_version });
const toSlot = (r: SlotRow): ApptSlot => ({ id: r.id, scheduleId: r.schedule_id, providerCode: r.provider_code, providerName: r.provider_name, clinicCode: r.clinic_code,
  startsAt: r.starts_at, endsAt: r.ends_at, capacity: r.capacity, reserved: r.reserved_count, remaining: Math.max(0, r.capacity - r.reserved_count),
  status: r.schedule_status === 'OPEN' ? r.status : r.schedule_status });
const SLOT_SELECT = `SELECT s.*, p.provider_code, p.provider_name, p.clinic_code, p.status AS schedule_status FROM appointment_slots s JOIN provider_schedules p ON p.id = s.schedule_id`;
const APPT_SELECT = `SELECT a.*, s.starts_at, s.ends_at, p.provider_name, p.room_id, pol.display_name, pp.external_patient_id AS hn FROM appointments a
  JOIN appointment_slots s ON s.id = a.slot_id JOIN provider_schedules p ON p.id = s.schedule_id
  LEFT JOIN appointment_policies pol ON pol.clinic_code = a.clinic_code JOIN patient_profiles pp ON pp.id = a.patient_profile_id`;

@Injectable()
export class AppointmentService implements OnModuleInit, OnModuleDestroy {
  now = () => new Date();
  private timer?: NodeJS.Timeout;
  constructor(private readonly store: DbService) {}
  onModuleInit() { this.expire(); this.timer = setInterval(() => this.expire(), 3600_000); this.timer.unref(); }
  onModuleDestroy() { clearInterval(this.timer); }

  // ---- rules --------------------------------------------------------------------------------------------------
  policies(): ApptPolicy[] { return (this.store.db.prepare('SELECT * FROM appointment_policies ORDER BY clinic_code').all() as PolicyRow[]).map(toPolicy); }
  policy(clinic: string): ApptPolicy | undefined {
    const r = this.store.db.prepare('SELECT * FROM appointment_policies WHERE clinic_code = ?').get(clinic) as PolicyRow | undefined;
    return r ? toPolicy(r) : undefined;
  }
  setPolicy(input: Record<string, unknown>, by: string): ApptPolicy {
    const code = input.clinicCode;
    if (typeof code !== 'string' || !CLINIC_RE.test(code)) throw bad('ระบุคลินิก');
    const cur = this.policy(code);
    const name = input.displayName ?? cur?.displayName;
    if (typeof name !== 'string' || !name.trim() || name.length > 30) throw bad('ระบุชื่อคลินิก (ไม่เกิน 30 ตัวอักษร)');
    const int = (k: string, lo: number, hi: number, fallback: number) => {
      const v = input[k]; if (v === undefined) return fallback;
      if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) throw bad(`ค่า ${k} ต้องอยู่ระหว่าง ${lo}–${hi}`);
      return v as number;
    };
    const bool = (k: string, fallback: boolean) => { const v = input[k]; if (v === undefined) return fallback; if (typeof v !== 'boolean') throw bad('ค่าเปิด/ปิดไม่ถูกต้อง'); return v; };
    if (input.queuePrefix !== undefined && (typeof input.queuePrefix !== 'string' || !/^[A-Z]{1,2}$/.test(input.queuePrefix))) throw bad('อักษรนำหน้าคิวไม่ถูกต้อง');
    const n = {
      enabled: bool('enabled', cur?.enabled ?? false), advanceDays: int('advanceDays', 0, 365, cur?.advanceDays ?? 90), cancelCutoffMinutes: int('cancelCutoffMinutes', 0, 20160, cur?.cancelCutoffMinutes ?? 1440),
      rescheduleNeedsApproval: bool('rescheduleNeedsApproval', cur?.rescheduleNeedsApproval ?? true), patientSelectsProvider: bool('patientSelectsProvider', cur?.patientSelectsProvider ?? false),
      queuePrefix: (input.queuePrefix as string | undefined) ?? cur?.queuePrefix ?? null, checkinEarlyMinutes: int('checkinEarlyMinutes', 0, 720, cur?.checkinEarlyMinutes ?? 120),
      checkinLateMinutes: int('checkinLateMinutes', 0, 720, cur?.checkinLateMinutes ?? 60),
    };
    this.store.db.prepare(`INSERT INTO appointment_policies (clinic_code, display_name, enabled, advance_days, cancel_cutoff_minutes, reschedule_needs_approval, patient_selects_provider,
      queue_prefix, checkin_early_minutes, checkin_late_minutes, policy_version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(clinic_code) DO UPDATE SET display_name = excluded.display_name, enabled = excluded.enabled, advance_days = excluded.advance_days,
      cancel_cutoff_minutes = excluded.cancel_cutoff_minutes, reschedule_needs_approval = excluded.reschedule_needs_approval, patient_selects_provider = excluded.patient_selects_provider,
      queue_prefix = excluded.queue_prefix, checkin_early_minutes = excluded.checkin_early_minutes, checkin_late_minutes = excluded.checkin_late_minutes,
      policy_version = policy_version + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(code, name.trim(), n.enabled ? 1 : 0, n.advanceDays, n.cancelCutoffMinutes, n.rescheduleNeedsApproval ? 1 : 0, n.patientSelectsProvider ? 1 : 0, n.queuePrefix,
        n.checkinEarlyMinutes, n.checkinLateMinutes, this.now().toISOString(), by);
    return this.policy(code)!;
  }

  // ---- doctors' sessions ------------------------------------------------------------------------------------------
  // One session per chosen day (start–end), cut into slots of `minutes` with `capacity` places each. A day where the
  // doctor already has an overlapping session (in any clinic) is skipped and reported, never double-booked.
  createSessions(plan: Record<string, unknown>): { sessions: number; slots: number; skipped: number; conflicts: string[] } {
    const { clinicCode, providerCode, providerName, from, to, weekdays, start, end, minutes, capacity, roomId } = plan;
    if (roomId !== undefined && roomId !== null && roomId !== '' && (typeof roomId !== 'string' || !ROOM_RE.test(roomId))) throw bad('ห้องตรวจไม่ถูกต้อง');
    if (typeof clinicCode !== 'string' || !this.policy(clinicCode)) throw bad('ตั้งกติกาการนัดของคลินิกนี้ก่อน');
    if (typeof providerCode !== 'string' || !PROVIDER_RE.test(providerCode)) throw bad('ระบุรหัสแพทย์ (เช่น รหัสใน HIS หรือเลข ว.)');
    if (typeof providerName !== 'string' || !providerName.trim() || providerName.length > 60) throw bad('ระบุชื่อแพทย์');
    if (typeof from !== 'string' || !DATE_RE.test(from) || typeof to !== 'string' || !DATE_RE.test(to) || to < from) throw bad('ช่วงวันที่ไม่ถูกต้อง');
    if (typeof start !== 'string' || !TIME_RE.test(start) || typeof end !== 'string' || !TIME_RE.test(end) || end <= start) throw bad('ช่วงเวลาไม่ถูกต้อง');
    if (!Number.isInteger(minutes) || (minutes as number) < 5 || (minutes as number) > 240) throw bad('ความยาวช่วงต้องอยู่ระหว่าง 5–240 นาที');
    if (!Number.isInteger(capacity) || (capacity as number) < 1 || (capacity as number) > 100) throw bad('จำนวนนัดต่อช่วงต้องอยู่ระหว่าง 1–100');
    if (!Array.isArray(weekdays) || !weekdays.length || weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw bad('เลือกวันในสัปดาห์');
    const days: string[] = [];
    for (let d = localInstant(from, '12:00'); localDate(d) <= to; d.setDate(d.getDate() + 1)) {
      if (days.length > 184) throw bad('สร้างได้ครั้งละไม่เกิน 6 เดือน');
      if ((weekdays as number[]).includes(d.getDay())) days.push(localDate(d));
    }
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)), hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const times: [string, string][] = [];
    for (let m = toMin(start); m + (minutes as number) <= toMin(end); m += minutes as number) times.push([hhmm(m), hhmm(m + (minutes as number))]);
    if (!times.length) throw bad('ช่วงเวลาสั้นกว่าความยาวหนึ่งช่วง');
    return this.store.tx(() => {
      const at = this.now().toISOString();
      let sessions = 0, slots = 0, skipped = 0;
      const conflicts: string[] = [];
      for (const day of days) {
        const s = localInstant(day, start).toISOString(), e = localInstant(day, end).toISOString();
        const clash = this.store.db.prepare(`SELECT starts_at FROM provider_schedules WHERE provider_code = ? AND status <> 'CANCELLED' AND starts_at < ? AND ends_at > ?`).get(providerCode, e, s) as { starts_at: string } | undefined;
        if (clash) { if (clash.starts_at === s) skipped++; else conflicts.push(day); continue; }
        const sid = newId('ps');
        this.store.db.prepare(`INSERT INTO provider_schedules (id, provider_code, provider_name, clinic_code, starts_at, ends_at, status, created_at, updated_at, room_id) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`)
          .run(sid, providerCode, providerName.trim(), clinicCode, s, e, at, at, typeof roomId === 'string' && roomId ? roomId : null);
        sessions++;
        for (const [a, b] of times) {
          this.store.db.prepare(`INSERT INTO appointment_slots (id, schedule_id, starts_at, ends_at, capacity, reserved_count, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 'OPEN', ?, ?)`)
            .run(newId('as'), sid, localInstant(day, a).toISOString(), localInstant(day, b).toISOString(), capacity as number, at, at);
          slots++;
        }
      }
      return { sessions, slots, skipped, conflicts };
    });
  }

  sessions(clinic: unknown, date: unknown): Session[] {
    if (typeof clinic !== 'string' || typeof date !== 'string' || !DATE_RE.test(date)) throw bad('ระบุคลินิกและวันที่');
    const [a, b] = dayRange(date);
    return (this.store.db.prepare(`SELECT p.*, COALESCE(SUM(s.capacity), 0) AS cap, COALESCE(SUM(s.reserved_count), 0) AS res FROM provider_schedules p
      LEFT JOIN appointment_slots s ON s.schedule_id = p.id WHERE p.clinic_code = ? AND p.starts_at >= ? AND p.starts_at < ? GROUP BY p.id ORDER BY p.starts_at, p.provider_name`)
      .all(clinic, a, b) as (Record<string, string> & { cap: number; res: number })[]).map((r) => ({ id: r.id, providerCode: r.provider_code, providerName: r.provider_name,
      clinicCode: r.clinic_code, startsAt: r.starts_at, endsAt: r.ends_at, status: r.status as Session['status'], capacity: r.cap, reserved: r.res, ...(r.room_id ? { roomId: r.room_id } : {}) }));
  }

  slots(clinic: unknown, date: unknown, provider?: unknown): ApptSlot[] {
    if (typeof clinic !== 'string' || typeof date !== 'string' || !DATE_RE.test(date)) throw bad('ระบุคลินิกและวันที่');
    const [a, b] = dayRange(date), pc = typeof provider === 'string' && provider ? provider : null;
    return (this.store.db.prepare(`${SLOT_SELECT} WHERE p.clinic_code = ? AND s.starts_at >= ? AND s.starts_at < ? AND (? IS NULL OR p.provider_code = ?) ORDER BY s.starts_at, p.provider_name`)
      .all(clinic, a, b, pc, pc) as SlotRow[]).map(toSlot);
  }
  bookable(clinic: unknown, date: unknown, provider?: unknown): ApptSlot[] {
    const p = typeof clinic === 'string' ? this.policy(clinic) : undefined;
    if (!p?.enabled) return [];
    const now = this.now(), limit = this.limit(p);
    return this.slots(clinic, date, provider).filter((s) => s.status === 'OPEN' && s.remaining > 0 && new Date(s.startsAt) > now && new Date(s.startsAt) <= limit);
  }
  // The days with a place left (optionally with one doctor) — pickers offer only these.
  openDays(clinic: unknown, provider?: unknown, except?: { startsAt: string; providerCode: string }): string[] {
    const p = typeof clinic === 'string' ? this.policy(clinic) : undefined;
    if (!p?.enabled) return [];
    const pc = typeof provider === 'string' && provider ? provider : null;
    const rows = this.store.db.prepare(`SELECT s.starts_at, p.provider_code FROM appointment_slots s JOIN provider_schedules p ON p.id = s.schedule_id
      WHERE p.clinic_code = ? AND p.status = 'OPEN' AND s.status = 'OPEN' AND s.reserved_count < s.capacity AND s.starts_at > ? AND s.starts_at <= ? AND (? IS NULL OR p.provider_code = ?)
      ORDER BY s.starts_at`).all(p.clinicCode, this.now().toISOString(), this.limit(p).toISOString(), pc, pc) as { starts_at: string; provider_code: string }[];
    return [...new Set(rows.filter((r) => !except || r.starts_at !== except.startsAt || r.provider_code !== except.providerCode).map((r) => localDate(new Date(r.starts_at))))];
  }
  // The days a patient may move their own appointment to (same rules as movableSlots).
  movableDays(id: unknown, profileId: string): string[] {
    const a = this.mine(id, { kind: 'patient', profileId }), p = this.policy(a.clinicCode);
    return this.openDays(a.clinicCode, p?.patientSelectsProvider ? undefined : a.providerCode, { startsAt: a.startsAt, providerCode: a.providerCode });
  }
  private limit(p: ApptPolicy) { const l = new Date(this.now().getTime()); l.setDate(l.getDate() + p.advanceDays); l.setHours(23, 59, 59, 999); return l; }

  // Close (no new appointments), reopen, or cancel a whole session (the doctor is away): its appointments are cancelled
  // with the reason, and requests to move into it are closed. Or change its room (`roomId`, '' = none): patients of the
  // session already in today's queue are then held for the new room (`movedVisits`).
  setSession(id: unknown, change: { status?: unknown; reason?: unknown; roomId?: unknown }, by: string): { session: Session; cancelled: Appointment[]; movedVisits: string[] } {
    return this.store.tx(() => {
      const r = typeof id === 'string' ? this.store.db.prepare('SELECT * FROM provider_schedules WHERE id = ?').get(id) as { id: string; status: string; clinic_code: string; starts_at: string } | undefined : undefined;
      if (!r) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบตารางออกตรวจนี้');
      if (r.status === 'CANCELLED') throw new AppError('INVALID_STATE_TRANSITION', 'ตารางนี้ถูกยกเลิกแล้ว');
      const st = change.status, room = change.roomId;
      if (st === undefined && room === undefined) throw bad('ไม่มีสิ่งที่จะเปลี่ยน');
      if (st !== undefined && st !== 'OPEN' && st !== 'CLOSED' && st !== 'CANCELLED') throw bad('สถานะไม่ถูกต้อง');
      if (room !== undefined && room !== null && room !== '' && (typeof room !== 'string' || !ROOM_RE.test(room))) throw bad('ห้องตรวจไม่ถูกต้อง');
      const at = this.now().toISOString();
      let cancelled: Appointment[] = [], movedVisits: string[] = [];
      if (room !== undefined) {
        const next = typeof room === 'string' && room ? room : null;
        this.store.db.prepare('UPDATE provider_schedules SET room_id = ?, updated_at = ? WHERE id = ?').run(next, at, r.id);
        const today = new Date().toLocaleDateString('sv-SE');
        movedVisits = (this.store.db.prepare(`UPDATE visits SET exam_room = ? WHERE day = ? AND source_type = 'APPOINTMENT' AND source_id IN
          (SELECT a.id FROM appointments a JOIN appointment_slots s ON s.id = a.slot_id WHERE s.schedule_id = ?) RETURNING id`).all(next, today, r.id) as { id: string }[]).map((x) => x.id);
      }
      if (st === 'CANCELLED') {
        const reason = typeof change.reason === 'string' ? change.reason.trim().slice(0, 100) : '';
        if (!reason) throw bad('ระบุเหตุผลที่ยกเลิก เช่น แพทย์ลาประชุม');
        const ids = (this.store.db.prepare(`SELECT a.id FROM appointments a JOIN appointment_slots s ON s.id = a.slot_id WHERE s.schedule_id = ? AND a.status = 'CONFIRMED'`).all(r.id) as { id: string }[]).map((x) => x.id);
        cancelled = ids.map((x) => this.cancelRow(x, reason, by, at)).filter((x): x is Appointment => !!x);
        this.store.db.prepare(`UPDATE appointment_reschedule_requests SET status = 'CANCELLED', decided_by = ?, decided_at = ?, decision_note = ? WHERE status = 'PENDING'
          AND requested_slot_id IN (SELECT id FROM appointment_slots WHERE schedule_id = ?)`).run(by, at, `ตารางแพทย์ถูกยกเลิก: ${reason}`, r.id);
      }
      if (st !== undefined) this.store.db.prepare('UPDATE provider_schedules SET status = ?, updated_at = ? WHERE id = ?').run(st, at, r.id);
      const day = new Date(r.starts_at).toLocaleDateString('sv-SE');
      return { session: this.sessions(r.clinic_code, day).find((x) => x.id === r.id)!, cancelled, movedVisits };
    });
  }

  // ---- appointments -----------------------------------------------------------------------------------------------
  create(profileId: string, slotId: unknown, channel: 'STAFF' | 'LINE', by: string): Appointment {
    return this.store.tx(() => {
      const s = this.slot(slotId);
      const p = this.policy(s.clinicCode);
      if (!p?.enabled) throw new AppError('POLICY_REJECTED', 'คลินิกนี้ยังไม่เปิดให้นัด');
      this.checkSlotUsable(s, p);
      const day = dayRange(new Date(s.startsAt).toLocaleDateString('sv-SE'));
      if (this.store.db.prepare(`SELECT 1 FROM appointments a JOIN appointment_slots s ON s.id = a.slot_id WHERE a.patient_profile_id = ? AND a.clinic_code = ? AND a.status = 'CONFIRMED'
        AND s.starts_at >= ? AND s.starts_at < ?`).get(profileId, s.clinicCode, day[0], day[1])) throw new AppError('POLICY_REJECTED', 'ผู้ป่วยมีนัดคลินิกนี้ในวันเดียวกันอยู่แล้ว');
      this.take(s.id);
      const id = newId('ap'), at = this.now().toISOString();
      this.store.db.prepare(`INSERT INTO appointments (id, appointment_code, patient_profile_id, slot_id, clinic_code, provider_code, status, channel, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?)`).run(id, this.newCode(), profileId, s.id, s.clinicCode, s.providerCode, channel, by, at, at);
      return this.get(id)!;
    });
  }

  cancel(id: unknown, reason: unknown, actor: Actor): { appointment: Appointment; changed: boolean; override: boolean } {
    return this.store.tx(() => {
      const a = this.mine(id, actor);
      if (a.status === 'CANCELLED') return { appointment: a, changed: false, override: false };
      if (a.status !== 'CONFIRMED') throw new AppError('INVALID_STATE_TRANSITION', 'นัดนี้เปลี่ยนสถานะไปแล้ว ยกเลิกไม่ได้');
      const text = typeof reason === 'string' ? reason.trim().slice(0, 100) : '';
      if (!text) throw bad('ระบุเหตุผลที่ยกเลิก');
      const late = this.pastCutoff(a);
      if (late && !(actor.kind === 'staff' && actor.canOverride)) throw new AppError('POLICY_REJECTED', 'เลยเวลายกเลิกนัดแล้ว กรุณาติดต่อคลินิก');
      const done = this.cancelRow(a.id, text, actorRef(actor), this.now().toISOString());
      return { appointment: done ?? this.get(a.id)!, changed: !!done, override: late };
    });
  }
  private cancelRow(id: string, reason: string, by: string, at: string): Appointment | undefined {
    if (this.store.db.prepare(`UPDATE appointments SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = ?, cancelled_by = ?, updated_at = ? WHERE id = ? AND status = 'CONFIRMED'`)
      .run(at, reason, by, at, id).changes !== 1) return undefined;
    this.release((this.store.db.prepare('SELECT slot_id FROM appointments WHERE id = ?').get(id) as { slot_id: string }).slot_id, at);
    this.store.db.prepare(`UPDATE appointment_reschedule_requests SET status = 'CANCELLED', decided_by = ?, decided_at = ?, decision_note = 'นัดถูกยกเลิก' WHERE appointment_id = ? AND status = 'PENDING'`).run(by, at, id);
    return this.get(id);
  }

  // Move to another slot of the same clinic now: new place taken, old one given back — or nothing changes.
  reschedule(id: unknown, slotId: unknown, actor: Actor, opts: { viaRequest?: string } = {}): Appointment {
    return this.store.tx(() => {
      const a = this.mine(id, actor);
      if (a.status !== 'CONFIRMED') throw new AppError('INVALID_STATE_TRANSITION', 'เลื่อนได้เฉพาะนัดที่ยังไม่ถึงวัน');
      const s = this.slot(slotId), p = this.policy(a.clinicCode);
      if (s.clinicCode !== a.clinicCode) throw new AppError('POLICY_REJECTED', 'เลื่อนได้ภายในคลินิกเดิมเท่านั้น');
      if (s.id === (this.store.db.prepare('SELECT slot_id FROM appointments WHERE id = ?').get(a.id) as { slot_id: string }).slot_id) throw new AppError('POLICY_REJECTED', 'เป็นช่วงเวลาเดิม');
      if (!p) throw new AppError('POLICY_REJECTED', 'คลินิกนี้ยังไม่เปิดให้นัด');
      this.checkSlotUsable(s, p);
      const at = this.now().toISOString(), old = (this.store.db.prepare('SELECT slot_id FROM appointments WHERE id = ?').get(a.id) as { slot_id: string }).slot_id;
      this.take(s.id);
      this.release(old, at);
      this.store.db.prepare('UPDATE appointments SET slot_id = ?, provider_code = ?, updated_at = ? WHERE id = ?').run(s.id, s.providerCode, at, a.id);
      // Other waiting requests are settled by this move.
      this.store.db.prepare(`UPDATE appointment_reschedule_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE appointment_id = ? AND status = 'PENDING'`)
        .run(opts.viaRequest ? 'APPROVED' : 'CANCELLED', actorRef(actor), at, opts.viaRequest ? null : 'เจ้าหน้าที่เลื่อนนัดให้แล้ว', a.id);
      return this.get(a.id)!;
    });
  }

  // Ask to move. If the clinic does not approve moves and a patient asks, it is done straight away.
  requestReschedule(id: unknown, slotId: unknown, reason: unknown, actor: Actor): { request?: RescheduleRequest; appointment: Appointment; immediate: boolean } {
    return this.store.tx(() => {
      const a = this.mine(id, actor), p = this.policy(a.clinicCode);
      if (a.status !== 'CONFIRMED') throw new AppError('INVALID_STATE_TRANSITION', 'ขอเลื่อนได้เฉพาะนัดที่ยังไม่ถึงวัน');
      if (actor.kind === 'patient' && this.pastCutoff(a)) throw new AppError('POLICY_REJECTED', 'เลยเวลาขอเลื่อนนัดแล้ว กรุณาติดต่อคลินิก');
      const s = this.slot(slotId);
      if (s.clinicCode !== a.clinicCode) throw new AppError('POLICY_REJECTED', 'เลื่อนได้ภายในคลินิกเดิมเท่านั้น');
      if (actor.kind === 'patient' && !p?.patientSelectsProvider && s.providerCode !== a.providerCode) throw new AppError('POLICY_REJECTED', 'เลื่อนได้เฉพาะกับแพทย์ท่านเดิม');
      if (p) this.checkSlotUsable(s, p);
      if (actor.kind === 'patient' && p && !p.rescheduleNeedsApproval) return { appointment: this.reschedule(a.id, s.id, actor), immediate: true };
      if (a.pendingRequest) throw new AppError('POLICY_REJECTED', 'มีคำขอเลื่อนนัดที่รอพิจารณาอยู่แล้ว');
      const rid = newId('rr'), text = typeof reason === 'string' ? reason.trim().slice(0, 100) : '';
      this.store.db.prepare(`INSERT INTO appointment_reschedule_requests (id, appointment_id, requested_slot_id, status, reason, requested_by, created_at) VALUES (?, ?, ?, 'PENDING', ?, ?, ?)`)
        .run(rid, a.id, s.id, text || null, actorRef(actor), this.now().toISOString());
      return { request: this.request(rid)!, appointment: this.get(a.id)!, immediate: false };
    });
  }

  // Staff decide. Approving moves the appointment (fails, and changes nothing, if the slot has filled up meanwhile).
  decide(requestId: unknown, approve: unknown, note: unknown, actor: Extract<Actor, { kind: 'staff' }>): RescheduleRequest {
    return this.store.tx(() => {
      const r = typeof requestId === 'string' ? this.request(requestId) : undefined;
      if (!r) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบคำขอนี้');
      if (r.status !== 'PENDING') return r;
      const text = typeof note === 'string' ? note.trim().slice(0, 100) : '';
      if (approve === true) this.reschedule(r.appointment.id, r.to.slotId, actor, { viaRequest: r.id });
      else if (approve === false) {
        if (!text) throw bad('ระบุเหตุผลที่ไม่อนุมัติ');
        this.store.db.prepare(`UPDATE appointment_reschedule_requests SET status = 'REJECTED', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`).run(actorRef(actor), this.now().toISOString(), text, r.id);
      } else throw bad('ระบุว่าอนุมัติหรือไม่');
      return this.request(r.id)!;
    });
  }

  // Did not come: a supervisor's decision, after the appointment's time, with a reason. The place is not given back
  // (the time has passed).
  markNoShow(id: unknown, reason: unknown, by: string): Appointment {
    return this.store.tx(() => {
      const a = this.get(id);
      if (!a) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบนัดนี้');
      if (a.status !== 'CONFIRMED') throw new AppError('INVALID_STATE_TRANSITION', 'บันทึกไม่มาตามนัดได้เฉพาะนัดที่ยังไม่เช็กอิน');
      if (new Date(a.endsAt) > this.now()) throw new AppError('POLICY_REJECTED', 'ยังไม่ถึงเวลาสิ้นสุดของนัด');
      const text = typeof reason === 'string' ? reason.trim().slice(0, 100) : '';
      if (!text) throw bad('ระบุเหตุผล เช่น โทรติดต่อแล้วไม่มา');
      this.store.db.prepare(`UPDATE appointments SET status = 'NO_SHOW', no_show_reason = ?, cancelled_by = ?, updated_at = ? WHERE id = ? AND status = 'CONFIRMED'`).run(text, by, this.now().toISOString(), a.id);
      return this.get(a.id)!;
    });
  }

  // Appointments of past days that were not checked in and nobody marked: no longer active (not a no-show).
  expire() {
    const today = localInstant(localDate(this.now()), '00:00').toISOString(), at = this.now().toISOString();
    const n = this.store.db.prepare(`UPDATE appointments SET status = 'EXPIRED', updated_at = ? WHERE status = 'CONFIRMED' AND slot_id IN (SELECT id FROM appointment_slots WHERE ends_at < ?)`).run(at, today).changes;
    this.store.db.prepare(`UPDATE appointment_reschedule_requests SET status = 'CANCELLED', decided_at = ?, decision_note = 'หมดเวลา' WHERE status = 'PENDING'
      AND requested_slot_id IN (SELECT id FROM appointment_slots WHERE starts_at < ?)`).run(at, at);
    return n;
  }

  // Check-in (CheckInService) marks the appointment as arrived, inside its transaction.
  markCheckedIn(id: string, visitId: string, at: string) {
    return this.store.db.prepare(`UPDATE appointments SET status = 'CHECKED_IN', visit_id = ?, checked_in_at = ?, updated_at = ? WHERE id = ? AND status = 'CONFIRMED'`).run(visitId, at, at, id).changes === 1;
  }
  profileOf(id: string) { return (this.store.db.prepare('SELECT patient_profile_id AS p FROM appointments WHERE id = ?').get(id) as { p: string } | undefined)?.p; }

  // ---- reading ---------------------------------------------------------------------------------------------------
  get(id: unknown): Appointment | undefined {
    if (typeof id !== 'string') return undefined;
    const r = this.store.db.prepare(`${APPT_SELECT} WHERE a.id = ?`).get(id) as ApptRow | undefined;
    return r ? this.toAppt(r) : undefined;
  }
  list(f: { date?: unknown; clinicCode?: unknown; code?: unknown; hn?: unknown }): Appointment[] {
    if (typeof f.code === 'string' && f.code.trim()) {
      const r = this.store.db.prepare(`${APPT_SELECT} WHERE a.appointment_code = ?`).get(f.code.trim().toUpperCase().replace(/[\s-]/g, '')) as ApptRow | undefined;
      return r ? [this.toAppt(r)] : [];
    }
    if (typeof f.hn === 'string' && f.hn.trim()) {
      if (!/^[0-9A-Za-z-]{3,20}$/.test(f.hn.trim())) throw bad('HN ไม่ถูกต้อง');
      return (this.store.db.prepare(`${APPT_SELECT} WHERE pp.external_patient_id = ? ORDER BY s.starts_at DESC LIMIT 50`).all(f.hn.trim()) as ApptRow[]).map((r) => this.toAppt(r));
    }
    if (typeof f.date !== 'string' || !DATE_RE.test(f.date)) throw bad('ระบุวันที่');
    const [a, b] = dayRange(f.date), c = typeof f.clinicCode === 'string' && f.clinicCode ? f.clinicCode : null;
    return (this.store.db.prepare(`${APPT_SELECT} WHERE s.starts_at >= ? AND s.starts_at < ? AND (? IS NULL OR a.clinic_code = ?) ORDER BY s.starts_at, p.provider_name`)
      .all(a, b, c, c) as ApptRow[]).map((r) => this.toAppt(r));
  }
  // A patient's own appointments (their LINE page): upcoming, and those of the last 30 days.
  forProfile(profileId: string): Appointment[] {
    const since = new Date(this.now().getTime() - 30 * 86_400_000).toISOString();
    return (this.store.db.prepare(`${APPT_SELECT} WHERE a.patient_profile_id = ? AND s.ends_at > ? ORDER BY s.starts_at DESC LIMIT 30`).all(profileId, since) as ApptRow[]).map((r) => this.toAppt(r));
  }
  // Where a patient may move their own appointment: same clinic, and the same doctor unless the clinic lets patients choose.
  movableSlots(id: unknown, date: unknown, profileId: string): ApptSlot[] {
    const a = this.mine(id, { kind: 'patient', profileId }), p = this.policy(a.clinicCode);
    return this.bookable(a.clinicCode, date, p?.patientSelectsProvider ? undefined : a.providerCode)
      .filter((s) => s.startsAt !== a.startsAt || s.providerCode !== a.providerCode);
  }
  // The clinic a slot / a request to move belongs to (for checking a staff member's clinics).
  slotClinic(slotId: unknown) {
    return typeof slotId === 'string' ? (this.store.db.prepare('SELECT p.clinic_code AS c FROM appointment_slots s JOIN provider_schedules p ON p.id = s.schedule_id WHERE s.id = ?').get(slotId) as { c: string } | undefined)?.c : undefined;
  }
  sessionClinic(sessionId: unknown) {
    return typeof sessionId === 'string' ? (this.store.db.prepare('SELECT clinic_code AS c FROM provider_schedules WHERE id = ?').get(sessionId) as { c: string } | undefined)?.c : undefined;
  }
  requestClinic(requestId: unknown) {
    return typeof requestId === 'string' ? (this.store.db.prepare('SELECT a.clinic_code AS c FROM appointment_reschedule_requests r JOIN appointments a ON a.id = r.appointment_id WHERE r.id = ?').get(requestId) as { c: string } | undefined)?.c : undefined;
  }
  requests(status: unknown = 'PENDING'): RescheduleRequest[] {
    const st = typeof status === 'string' ? status : 'PENDING';
    return (this.store.db.prepare(`SELECT id FROM appointment_reschedule_requests WHERE status = ? ORDER BY created_at LIMIT 200`).all(st) as { id: string }[]).map((r) => this.request(r.id)!);
  }
  private request(id: string): RescheduleRequest | undefined {
    const r = this.store.db.prepare(`SELECT r.*, s.starts_at, s.ends_at, p.provider_name FROM appointment_reschedule_requests r JOIN appointment_slots s ON s.id = r.requested_slot_id
      JOIN provider_schedules p ON p.id = s.schedule_id WHERE r.id = ?`).get(id) as Record<string, string> | undefined;
    if (!r) return undefined;
    return { id: r.id, status: r.status as RescheduleRequest['status'], reason: r.reason ?? undefined, createdAt: r.created_at, decisionNote: r.decision_note ?? undefined,
      appointment: this.get(r.appointment_id)!, to: { slotId: r.requested_slot_id, startsAt: r.starts_at, endsAt: r.ends_at, providerName: r.provider_name } };
  }
  private toAppt(r: ApptRow): Appointment {
    const pr = this.store.db.prepare(`SELECT r.id, r.reason, s.starts_at, s.ends_at, p.provider_name FROM appointment_reschedule_requests r JOIN appointment_slots s ON s.id = r.requested_slot_id
      JOIN provider_schedules p ON p.id = s.schedule_id WHERE r.appointment_id = ? AND r.status = 'PENDING'`).get(r.id) as Record<string, string> | undefined;
    return { id: r.id, code: r.appointment_code, clinicCode: r.clinic_code, clinicName: r.display_name ?? r.clinic_code, providerCode: r.provider_code, providerName: r.provider_name,
      startsAt: r.starts_at, endsAt: r.ends_at, status: r.status, channel: r.channel, hn: r.hn ? maskHN(r.hn) : '', createdAt: r.created_at,
      cancellationReason: r.cancellation_reason ?? undefined, noShowReason: r.no_show_reason ?? undefined, visitId: r.visit_id ?? undefined,
      pendingRequest: pr ? { id: pr.id, startsAt: pr.starts_at, endsAt: pr.ends_at, providerName: pr.provider_name, reason: pr.reason ?? undefined } : undefined, ...(r.room_id ? { roomId: r.room_id } : {}) };
  }

  // ---- helpers -----------------------------------------------------------------------------------------------------
  private slot(id: unknown): ApptSlot {
    const r = typeof id === 'string' ? this.store.db.prepare(`${SLOT_SELECT} WHERE s.id = ?`).get(id) as SlotRow | undefined : undefined;
    if (!r) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบช่วงเวลานี้');
    return toSlot(r);
  }
  private checkSlotUsable(s: ApptSlot, p: ApptPolicy) {
    if (s.status !== 'OPEN') throw new AppError('SLOT_FULL_OR_CLOSED', 'ช่วงเวลานี้ปิดรับนัดแล้ว');
    if (new Date(s.startsAt) <= this.now()) throw new AppError('POLICY_REJECTED', 'ช่วงเวลานี้เริ่มไปแล้ว');
    if (new Date(s.startsAt) > this.limit(p)) throw new AppError('POLICY_REJECTED', `นัดล่วงหน้าได้ไม่เกิน ${p.advanceDays} วัน`);
  }
  private take(slotId: string) {
    if (this.store.db.prepare(`UPDATE appointment_slots SET reserved_count = reserved_count + 1, updated_at = ? WHERE id = ? AND status = 'OPEN' AND reserved_count < capacity
      AND schedule_id IN (SELECT id FROM provider_schedules WHERE status = 'OPEN')`).run(this.now().toISOString(), slotId).changes !== 1)
      throw new AppError('SLOT_FULL_OR_CLOSED', 'ช่วงเวลานี้เต็มหรือปิดรับแล้ว');
  }
  private release(slotId: string, at: string) {
    this.store.db.prepare('UPDATE appointment_slots SET reserved_count = reserved_count - 1, updated_at = ? WHERE id = ? AND reserved_count > 0').run(at, slotId);
  }
  private pastCutoff(a: Appointment) {
    const p = this.policy(a.clinicCode);
    return this.now() > new Date(new Date(a.startsAt).getTime() - (p?.cancelCutoffMinutes ?? 0) * 60_000);
  }
  // Patients only reach their own appointments; anything else looks like "not found".
  private mine(id: unknown, actor: Actor): Appointment {
    const a = this.get(id);
    if (!a || (actor.kind === 'patient' && this.profileOf(a.id) !== actor.profileId)) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบนัดนี้');
    return a;
  }
  private newCode() {
    for (;;) {
      const code = 'AP' + Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
      if (!this.store.db.prepare('SELECT 1 FROM appointments WHERE appointment_code = ?').get(code)) return code;
    }
  }
}
