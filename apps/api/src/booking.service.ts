import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import { DbService } from './db.service';
import { AppError } from './errors';
import { FacilityService } from './facility.service';

// General queue booking: a patient reserves a place in a time slot of a service (an OPD clinic) — not a doctor, and
// not yet a queue number (that comes at check-in, stage 2.3). Capacity is per slot; rules are per service.
// Every change runs in one write transaction (DbService.tx), so two people can never take the last place, and a
// cancelled booking gives its place back exactly once.
// Times: stored as UTC ISO-8601; the hospital enters and reads them in local time (the server runs in TZ=Asia/Bangkok).
export type Policy = { serviceCode: string; displayName: string; enabled: boolean; advanceDays: number; cancelCutoffMinutes: number; maxActivePerPatient: number; version: number; updatedAt: string;
  queuePrefix?: string; checkinEarlyMinutes: number; checkinLateMinutes: number };
export type Slot = { id: string; serviceCode: string; startsAt: string; endsAt: string; capacity: number; reserved: number; remaining: number; status: 'OPEN' | 'CLOSED' | 'CANCELLED' };
export type BookingStatus = 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'CHECKED_IN' | 'CONVERTED_TO_QUEUE';
// What staff see. The HN is masked (last 4 digits) — enough to confirm with the patient at the counter.
export type Booking = { id: string; code: string; serviceCode: string; serviceName: string; startsAt: string; endsAt: string; status: BookingStatus;
  channel: 'STAFF' | 'LINE'; hn: string; createdAt: string; cancelledAt?: string; cancellationReason?: string; visitId?: string };
export type SlotPlan = { serviceCode?: unknown; from?: unknown; to?: unknown; weekdays?: unknown; start?: unknown; end?: unknown; minutes?: unknown; capacity?: unknown };
export type Actor = { kind: 'staff'; id: number; name: string; canOverride: boolean } | { kind: 'patient'; profileId: string };

const CODE_CHARS = 'ACDEFGHJKLMNPQRTUVWXY3479'; // no 0/O, 1/I, 2/Z, 5/S, 6/B, 8 — read out over the phone without mistakes
const HN_RE = /^[0-9A-Za-z-]{3,20}$/, DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_SLOTS_PER_PLAN = 2000, MAX_PLAN_DAYS = 92;
const bad = (reason: string) => new AppError('VALIDATION_ERROR', reason);
const id = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const maskHN = (hn: string) => `••${hn.slice(-4)}`;
// Local wall-clock date + time → instant (server TZ = the hospital's).
export function localInstant(date: string, time: string) {
  const [y, m, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi);
}
const localDate = (d: Date) => d.toLocaleDateString('sv-SE');

type PolicyRow = { service_code: string; display_name: string; enabled: number; advance_days: number; cancel_cutoff_minutes: number; max_active_per_patient: number; policy_version: number; updated_at: string; queue_prefix: string | null; checkin_early_minutes: number; checkin_late_minutes: number };
type SlotRow = { id: string; service_code: string; starts_at: string; ends_at: string; capacity: number; reserved_count: number; status: Slot['status'] };
type BookingRow = { id: string; booking_code: string; patient_profile_id: string; slot_id: string; service_code: string; status: BookingStatus; channel: 'STAFF' | 'LINE';
  visit_id: string | null; cancelled_at: string | null; cancellation_reason: string | null; created_at: string; starts_at: string; ends_at: string; display_name: string | null; hn: string | null };
const toPolicy = (r: PolicyRow): Policy => ({ serviceCode: r.service_code, displayName: r.display_name, enabled: !!r.enabled, advanceDays: r.advance_days,
  cancelCutoffMinutes: r.cancel_cutoff_minutes, maxActivePerPatient: r.max_active_per_patient, version: r.policy_version, updatedAt: r.updated_at,
  queuePrefix: r.queue_prefix ?? undefined, checkinEarlyMinutes: r.checkin_early_minutes, checkinLateMinutes: r.checkin_late_minutes });
const toSlot = (r: SlotRow): Slot => ({ id: r.id, serviceCode: r.service_code, startsAt: r.starts_at, endsAt: r.ends_at, capacity: r.capacity, reserved: r.reserved_count,
  remaining: Math.max(0, r.capacity - r.reserved_count), status: r.status });
const toBooking = (r: BookingRow): Booking => ({ id: r.id, code: r.booking_code, serviceCode: r.service_code, serviceName: r.display_name ?? r.service_code, startsAt: r.starts_at,
  endsAt: r.ends_at, status: r.status, channel: r.channel, hn: r.hn ? maskHN(r.hn) : '', createdAt: r.created_at, cancelledAt: r.cancelled_at ?? undefined,
  cancellationReason: r.cancellation_reason ?? undefined, visitId: r.visit_id ?? undefined });
const BOOKING_SELECT = `SELECT b.*, s.starts_at, s.ends_at, p.display_name, pp.external_patient_id AS hn FROM bookings b
  JOIN booking_slots s ON s.id = b.slot_id LEFT JOIN booking_policies p ON p.service_code = b.service_code JOIN patient_profiles pp ON pp.id = b.patient_profile_id`;

@Injectable()
export class BookingService implements OnModuleInit, OnModuleDestroy {
  // The clock, replaceable in tests.
  now = () => new Date();
  private timer?: NodeJS.Timeout;
  private readonly facility: FacilityService;
  constructor(private readonly store: DbService, facility?: FacilityService) { this.facility = facility ?? new FacilityService(store); }
  onModuleInit() { this.expire(); this.timer = setInterval(() => this.expire(), 3600_000); this.timer.unref(); }
  onModuleDestroy() { clearInterval(this.timer); }

  // ---- policies (administrators) -----------------------------------------------------------------------------
  policies(): Policy[] {
    return (this.store.db.prepare('SELECT * FROM booking_policies ORDER BY service_code').all() as PolicyRow[]).map(toPolicy);
  }
  policy(serviceCode: string): Policy | undefined {
    const r = this.store.db.prepare('SELECT * FROM booking_policies WHERE service_code = ?').get(serviceCode) as PolicyRow | undefined;
    return r ? toPolicy(r) : undefined;
  }
  // Create or change a service's rules. Every change bumps the version (bookings keep the rules they were made under
  // in the audit trail).
  setPolicy(input: { serviceCode?: unknown; displayName?: unknown; enabled?: unknown; advanceDays?: unknown; cancelCutoffMinutes?: unknown; maxActivePerPatient?: unknown;
    queuePrefix?: unknown; checkinEarlyMinutes?: unknown; checkinLateMinutes?: unknown }, by: string): Policy {
    const code = input.serviceCode;
    // A department of the facility model that takes bookings.
    if (typeof code !== 'string' || !this.facility.department(code)?.features.booking) throw bad('ระบุบริการ (คลินิกที่เปิดรับจองในผังโรงพยาบาล)');
    const cur = this.policy(code);
    const name = input.displayName === undefined ? cur?.displayName : input.displayName;
    if (typeof name !== 'string' || !name.trim() || name.length > 30) throw bad('ระบุชื่อบริการ (ไม่เกิน 30 ตัวอักษร)');
    const int = (v: unknown, lo: number, hi: number, fallback: number, what: string) => {
      if (v === undefined) return fallback;
      if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) throw bad(`${what}ต้องอยู่ระหว่าง ${lo}–${hi}`);
      return v as number;
    };
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw bad('ค่าเปิด/ปิดไม่ถูกต้อง');
    if (input.queuePrefix !== undefined && (typeof input.queuePrefix !== 'string' || !/^[A-Z]{1,2}$/.test(input.queuePrefix))) throw bad('อักษรนำหน้าคิวไม่ถูกต้อง');
    const next = {
      enabled: input.enabled === undefined ? cur?.enabled ?? false : input.enabled,
      advanceDays: int(input.advanceDays, 0, 180, cur?.advanceDays ?? 14, 'จองล่วงหน้า'),
      cancelCutoffMinutes: int(input.cancelCutoffMinutes, 0, 10080, cur?.cancelCutoffMinutes ?? 60, 'เวลาปิดรับยกเลิก'),
      maxActivePerPatient: int(input.maxActivePerPatient, 1, 10, cur?.maxActivePerPatient ?? 1, 'จำนวนการจองต่อคน'),
      queuePrefix: (input.queuePrefix as string | undefined) ?? cur?.queuePrefix ?? null,
      checkinEarlyMinutes: int(input.checkinEarlyMinutes, 0, 720, cur?.checkinEarlyMinutes ?? 120, 'เช็กอินก่อนเวลา'),
      checkinLateMinutes: int(input.checkinLateMinutes, 0, 720, cur?.checkinLateMinutes ?? 60, 'เช็กอินหลังเวลา'),
    };
    const at = this.now().toISOString();
    this.store.db.prepare(`INSERT INTO booking_policies (service_code, display_name, enabled, advance_days, cancel_cutoff_minutes, max_active_per_patient, policy_version, updated_at, updated_by,
      queue_prefix, checkin_early_minutes, checkin_late_minutes)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?) ON CONFLICT(service_code) DO UPDATE SET display_name = excluded.display_name, enabled = excluded.enabled, advance_days = excluded.advance_days,
      cancel_cutoff_minutes = excluded.cancel_cutoff_minutes, max_active_per_patient = excluded.max_active_per_patient, policy_version = policy_version + 1,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by, queue_prefix = excluded.queue_prefix, checkin_early_minutes = excluded.checkin_early_minutes,
      checkin_late_minutes = excluded.checkin_late_minutes`)
      .run(code, name.trim(), next.enabled ? 1 : 0, next.advanceDays, next.cancelCutoffMinutes, next.maxActivePerPatient, at, by, next.queuePrefix, next.checkinEarlyMinutes, next.checkinLateMinutes);
    return this.policy(code)!;
  }

  // ---- slots (administrators) --------------------------------------------------------------------------------
  // Make slots for a date range: on the chosen weekdays (0 = Sunday), from `start` to `end`, every `minutes`, each
  // with `capacity` places. Slots that already exist are left as they are (running it twice is harmless).
  createSlots(plan: SlotPlan): { created: number; skipped: number } {
    const { serviceCode, from, to, weekdays, start, end, minutes, capacity } = plan;
    if (typeof serviceCode !== 'string' || !this.policy(serviceCode)) throw bad('ตั้งกติกาของบริการนี้ก่อนสร้างช่วงเวลา');
    if (typeof from !== 'string' || !DATE_RE.test(from) || typeof to !== 'string' || !DATE_RE.test(to) || to < from) throw bad('ช่วงวันที่ไม่ถูกต้อง');
    if (typeof start !== 'string' || !TIME_RE.test(start) || typeof end !== 'string' || !TIME_RE.test(end) || end <= start) throw bad('ช่วงเวลาไม่ถูกต้อง');
    if (!Number.isInteger(minutes) || (minutes as number) < 5 || (minutes as number) > 480) throw bad('ความยาวช่วงต้องอยู่ระหว่าง 5–480 นาที');
    if (!Number.isInteger(capacity) || (capacity as number) < 1 || (capacity as number) > 500) throw bad('จำนวนที่ต่อช่วงต้องอยู่ระหว่าง 1–500');
    if (!Array.isArray(weekdays) || !weekdays.length || weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw bad('เลือกวันในสัปดาห์');
    const days: string[] = [];
    for (let d = localInstant(from, '12:00'); localDate(d) <= to; d.setDate(d.getDate() + 1)) {
      if (days.length > MAX_PLAN_DAYS) throw bad(`สร้างได้ครั้งละไม่เกิน ${MAX_PLAN_DAYS} วัน`);
      if ((weekdays as number[]).includes(d.getDay())) days.push(localDate(d));
    }
    const times: [string, string][] = [];
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)), hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    for (let m = toMin(start); m + (minutes as number) <= toMin(end); m += minutes as number) times.push([hhmm(m), hhmm(m + (minutes as number))]);
    if (days.length * times.length > MAX_SLOTS_PER_PLAN) throw bad(`สร้างได้ครั้งละไม่เกิน ${MAX_SLOTS_PER_PLAN} ช่วง`);
    if (!times.length) throw bad('ช่วงเวลาสั้นกว่าความยาวหนึ่งช่วง');
    return this.store.tx(() => {
      const at = this.now().toISOString(), ins = this.store.db.prepare(`INSERT INTO booking_slots (id, service_code, starts_at, ends_at, capacity, reserved_count, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, 'OPEN', ?, ?) ON CONFLICT(service_code, starts_at) DO NOTHING`);
      let created = 0;
      for (const day of days) for (const [a, b] of times) created += Number(ins.run(id('bs'), serviceCode, localInstant(day, a).toISOString(), localInstant(day, b).toISOString(), capacity as number, at, at).changes);
      return { created, skipped: days.length * times.length - created };
    });
  }

  slots(serviceCode: unknown, date: unknown): Slot[] {
    if (typeof serviceCode !== 'string' || typeof date !== 'string' || !DATE_RE.test(date)) throw bad('ระบุบริการและวันที่');
    const from = localInstant(date, '00:00'), to = new Date(from); to.setDate(to.getDate() + 1);
    return (this.store.db.prepare('SELECT * FROM booking_slots WHERE service_code = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at')
      .all(serviceCode, from.toISOString(), to.toISOString()) as SlotRow[]).map(toSlot);
  }
  // What a patient can pick: open, not started, within the booking window, with a place left.
  bookable(serviceCode: unknown, date: unknown): Slot[] {
    const p = typeof serviceCode === 'string' ? this.policy(serviceCode) : undefined;
    if (!p?.enabled) return [];
    const now = this.now(), limit = new Date(now); limit.setDate(limit.getDate() + p.advanceDays); limit.setHours(23, 59, 59, 999);
    return this.slots(serviceCode, date).filter((s) => s.status === 'OPEN' && s.remaining > 0 && new Date(s.startsAt) > now && new Date(s.startsAt) <= limit);
  }

  // The days that still have a place a patient can book (open, not started, inside the window) — pickers offer only
  // these, so a day without slots (a weekend, a holiday) is never offered.
  openDays(serviceCode: unknown): string[] {
    const p = typeof serviceCode === 'string' ? this.policy(serviceCode) : undefined;
    if (!p?.enabled) return [];
    const now = this.now(), limit = new Date(now); limit.setDate(limit.getDate() + p.advanceDays); limit.setHours(23, 59, 59, 999);
    const rows = this.store.db.prepare(`SELECT starts_at FROM booking_slots WHERE service_code = ? AND status = 'OPEN' AND reserved_count < capacity AND starts_at > ? AND starts_at <= ? ORDER BY starts_at`)
      .all(p.serviceCode, now.toISOString(), limit.toISOString()) as { starts_at: string }[];
    return [...new Set(rows.map((r) => localDate(new Date(r.starts_at))))];
  }

  // Close (no new bookings, existing kept), reopen, change the number of places — or cancel the slot (e.g. the clinic
  // is not running that day): every booking in it is cancelled with the reason given.
  setSlot(slotId: unknown, change: { status?: unknown; capacity?: unknown; reason?: unknown }, by: string): { slot: Slot; cancelled: Booking[] } {
    return this.store.tx(() => {
      const r = typeof slotId === 'string' ? this.store.db.prepare('SELECT * FROM booking_slots WHERE id = ?').get(slotId) as SlotRow | undefined : undefined;
      if (!r) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบช่วงเวลานี้');
      if (r.status === 'CANCELLED') throw new AppError('INVALID_STATE_TRANSITION', 'ช่วงเวลานี้ถูกยกเลิกแล้ว');
      const at = this.now().toISOString();
      let cancelled: Booking[] = [];
      if (change.capacity !== undefined) {
        if (!Number.isInteger(change.capacity) || (change.capacity as number) < 0 || (change.capacity as number) > 500) throw bad('จำนวนที่ไม่ถูกต้อง');
        if ((change.capacity as number) < r.reserved_count) throw new AppError('POLICY_REJECTED', `มีผู้จองแล้ว ${r.reserved_count} คน — ลดจำนวนที่ให้ต่ำกว่านี้ไม่ได้`);
        this.store.db.prepare('UPDATE booking_slots SET capacity = ?, updated_at = ? WHERE id = ?').run(change.capacity as number, at, r.id);
      }
      if (change.status !== undefined) {
        if (change.status !== 'OPEN' && change.status !== 'CLOSED' && change.status !== 'CANCELLED') throw bad('สถานะไม่ถูกต้อง');
        if (change.status === 'CANCELLED') {
          const reason = typeof change.reason === 'string' ? change.reason.trim().slice(0, 100) : '';
          if (!reason) throw bad('ระบุเหตุผลที่ยกเลิกช่วงเวลา');
          const ids = (this.store.db.prepare(`SELECT id FROM bookings WHERE slot_id = ? AND status = 'CONFIRMED'`).all(r.id) as { id: string }[]).map((x) => x.id);
          cancelled = ids.map((b) => this.cancelRow(b, reason, by, at)).filter((x): x is Booking => !!x);
        }
        this.store.db.prepare('UPDATE booking_slots SET status = ?, updated_at = ? WHERE id = ?').run(change.status as string, at, r.id);
      }
      return { slot: toSlot(this.store.db.prepare('SELECT * FROM booking_slots WHERE id = ?').get(r.id) as SlotRow), cancelled };
    });
  }

  // ---- patients ---------------------------------------------------------------------------------------------------
  // At the counter: staff have checked the patient's identity (ID card, as today) and type the HN.
  // Whether this HN has been used here before (booked, given an appointment, linked to LINE). Throws on a malformed HN.
  knowsHN(hn: unknown): boolean {
    if (typeof hn !== 'string' || !HN_RE.test(hn.trim())) throw bad('HN ไม่ถูกต้อง (ตัวเลข ตัวอักษรอังกฤษ และ - ยาว 3–20 ตัว)');
    return !!this.store.db.prepare('SELECT 1 FROM patient_profiles WHERE external_patient_id = ?').get(hn.trim());
  }
  profileForHN(hn: unknown): string {
    if (typeof hn !== 'string' || !HN_RE.test(hn.trim())) throw bad('HN ไม่ถูกต้อง');
    const value = hn.trim(), at = this.now().toISOString();
    const r = this.store.db.prepare('SELECT id FROM patient_profiles WHERE external_patient_id = ?').get(value) as { id: string } | undefined;
    if (r) return r.id;
    const pid = id('pt');
    this.store.db.prepare(`INSERT INTO patient_profiles (id, external_patient_id, identity_status, created_at, updated_at) VALUES (?, ?, 'VERIFIED', ?, ?)`).run(pid, value, at, at);
    return pid;
  }

  // ---- bookings ---------------------------------------------------------------------------------------------------
  book(profileId: string, slotId: unknown, channel: 'STAFF' | 'LINE', createdBy: string): Booking {
    return this.store.tx(() => {
      const s = typeof slotId === 'string' ? this.store.db.prepare('SELECT * FROM booking_slots WHERE id = ?').get(slotId) as SlotRow | undefined : undefined;
      if (!s) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบช่วงเวลานี้');
      const p = this.policy(s.service_code), now = this.now();
      if (!p?.enabled) throw new AppError('POLICY_REJECTED', 'บริการนี้ยังไม่เปิดให้จอง');
      if (new Date(s.starts_at) <= now) throw new AppError('POLICY_REJECTED', 'ช่วงเวลานี้เริ่มไปแล้ว');
      const limit = new Date(now); limit.setDate(limit.getDate() + p.advanceDays); limit.setHours(23, 59, 59, 999);
      if (new Date(s.starts_at) > limit) throw new AppError('POLICY_REJECTED', `จองล่วงหน้าได้ไม่เกิน ${p.advanceDays} วัน`);
      const mine = this.store.db.prepare(`SELECT b.slot_id FROM bookings b JOIN booking_slots s ON s.id = b.slot_id
        WHERE b.patient_profile_id = ? AND b.service_code = ? AND b.status IN ('CONFIRMED','CHECKED_IN') AND s.ends_at > ?`).all(profileId, s.service_code, now.toISOString()) as { slot_id: string }[];
      if (mine.some((x) => x.slot_id === s.id)) throw new AppError('POLICY_REJECTED', 'ผู้ป่วยจองช่วงเวลานี้ไว้แล้ว');
      if (mine.length >= p.maxActivePerPatient) throw new AppError('POLICY_REJECTED', `ผู้ป่วยมีการจองของบริการนี้ที่ยังไม่ถึงวันอยู่แล้ว (สูงสุด ${p.maxActivePerPatient})`);
      // The place itself: only if the slot is open and has room — decided by the database in one statement.
      const at = now.toISOString();
      if (this.store.db.prepare(`UPDATE booking_slots SET reserved_count = reserved_count + 1, updated_at = ? WHERE id = ? AND status = 'OPEN' AND reserved_count < capacity`).run(at, s.id).changes !== 1)
        throw new AppError('SLOT_FULL_OR_CLOSED', 'ช่วงเวลานี้เต็มหรือปิดรับแล้ว');
      const bid = id('bk'), code = this.newCode();
      this.store.db.prepare(`INSERT INTO bookings (id, booking_code, patient_profile_id, slot_id, service_code, status, channel, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?)`).run(bid, code, profileId, s.id, s.service_code, channel, createdBy, at, at);
      return this.get(bid)!;
    });
  }

  // Cancel and give the place back — once. Before the cut-off anyone allowed to manage the booking may cancel; after
  // it only staff with override permission (and a reason). Repeating a cancel returns the cancelled booking.
  cancel(bookingId: unknown, reason: unknown, actor: Actor): { booking: Booking; changed: boolean; override: boolean } {
    return this.store.tx(() => {
      const b = this.get(bookingId);
      if (!b || (actor.kind === 'patient' && this.ownerOf(b.id) !== actor.profileId)) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบการจองนี้');
      if (b.status === 'CANCELLED') return { booking: b, changed: false, override: false };
      if (b.status !== 'CONFIRMED') throw new AppError('INVALID_STATE_TRANSITION', b.status === 'EXPIRED' ? 'การจองนี้หมดอายุแล้ว' : 'ผู้ป่วยเช็กอินแล้ว ยกเลิกการจองไม่ได้');
      const text = typeof reason === 'string' ? reason.trim().slice(0, 100) : '';
      if (!text) throw bad('ระบุเหตุผลที่ยกเลิก');
      const p = this.policy(b.serviceCode), now = this.now();
      const cutoff = new Date(new Date(b.startsAt).getTime() - (p?.cancelCutoffMinutes ?? 0) * 60_000);
      const late = now > cutoff;
      if (late && !(actor.kind === 'staff' && actor.canOverride))
        throw new AppError('POLICY_REJECTED', `เลยเวลายกเลิกแล้ว (ต้องยกเลิกก่อนเวลานัด ${p?.cancelCutoffMinutes ?? 0} นาที) — ติดต่อหัวหน้างาน`);
      const done = this.cancelRow(b.id, text, actor.kind === 'staff' ? `user:${actor.id}` : 'patient', now.toISOString());
      return { booking: done ?? this.get(b.id)!, changed: !!done, override: late };
    });
  }
  // The single place a booking leaves CONFIRMED for CANCELLED; the slot gets its place back only if this call made
  // the change (a concurrent or repeated cancel changes nothing).
  private cancelRow(bookingId: string, reason: string, by: string, at: string): Booking | undefined {
    const ch = this.store.db.prepare(`UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = ?, cancelled_by = ?, updated_at = ? WHERE id = ? AND status = 'CONFIRMED'`)
      .run(at, reason, by, at, bookingId).changes;
    if (ch !== 1) return undefined;
    this.store.db.prepare(`UPDATE booking_slots SET reserved_count = reserved_count - 1, updated_at = ? WHERE id = (SELECT slot_id FROM bookings WHERE id = ?) AND reserved_count > 0`).run(at, bookingId);
    return this.get(bookingId);
  }

  // Bookings of past days that nobody checked in for. Not a no-show record — just no longer active.
  expire() {
    const today = localInstant(localDate(this.now()), '00:00').toISOString(), at = this.now().toISOString();
    return this.store.db.prepare(`UPDATE bookings SET status = 'EXPIRED', updated_at = ? WHERE status = 'CONFIRMED' AND slot_id IN (SELECT id FROM booking_slots WHERE ends_at < ?)`).run(at, today).changes;
  }

  get(bookingId: unknown): Booking | undefined {
    if (typeof bookingId !== 'string') return undefined;
    const r = this.store.db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(bookingId) as BookingRow | undefined;
    return r ? toBooking(r) : undefined;
  }
  profileOf(bookingId: string) { return this.ownerOf(bookingId)!; }
  private ownerOf(bookingId: string) {
    return (this.store.db.prepare('SELECT patient_profile_id AS p FROM bookings WHERE id = ?').get(bookingId) as { p: string } | undefined)?.p;
  }
  // A patient's own bookings (their LINE page): upcoming, and those of the last 30 days.
  forProfile(profileId: string): Booking[] {
    const since = new Date(this.now().getTime() - 30 * 86_400_000).toISOString();
    return (this.store.db.prepare(`${BOOKING_SELECT} WHERE b.patient_profile_id = ? AND s.ends_at > ? ORDER BY s.starts_at DESC LIMIT 30`).all(profileId, since) as BookingRow[]).map(toBooking);
  }
  ownedBy(bookingId: unknown, profileId: string) {
    return typeof bookingId === 'string' && (this.store.db.prepare('SELECT 1 FROM bookings WHERE id = ? AND patient_profile_id = ?').get(bookingId, profileId) !== undefined);
  }
  // The service a slot belongs to (for checking a staff member's clinics before booking into it).
  slotService(slotId: unknown) {
    return typeof slotId === 'string' ? (this.store.db.prepare('SELECT service_code AS c FROM booking_slots WHERE id = ?').get(slotId) as { c: string } | undefined)?.c : undefined;
  }
  // Staff lists: one day (optionally one service), or one booking by its code, or a patient's bookings by HN.
  // Today's bookings by service and status — counts only (the dashboard).
  dayCounts(day = localDate(this.now())): { service: string; status: BookingStatus; n: number }[] {
    const a = localInstant(day, '00:00'), b = new Date(a); b.setDate(b.getDate() + 1);
    return this.store.db.prepare(`SELECT b.service_code AS service, b.status, COUNT(*) AS n FROM bookings b JOIN booking_slots s ON s.id = b.slot_id
      WHERE s.starts_at >= ? AND s.starts_at < ? GROUP BY b.service_code, b.status`).all(a.toISOString(), b.toISOString()) as { service: string; status: BookingStatus; n: number }[];
  }
  list(f: { date?: unknown; serviceCode?: unknown; code?: unknown; hn?: unknown }): Booking[] {
    if (typeof f.code === 'string' && f.code.trim()) {
      const r = this.store.db.prepare(`${BOOKING_SELECT} WHERE b.booking_code = ?`).get(f.code.trim().toUpperCase()) as BookingRow | undefined;
      return r ? [toBooking(r)] : [];
    }
    if (typeof f.hn === 'string' && f.hn.trim()) {
      if (!HN_RE.test(f.hn.trim())) throw bad('HN ไม่ถูกต้อง');
      return (this.store.db.prepare(`${BOOKING_SELECT} WHERE pp.external_patient_id = ? ORDER BY s.starts_at DESC LIMIT 50`).all(f.hn.trim()) as BookingRow[]).map(toBooking);
    }
    if (typeof f.date !== 'string' || !DATE_RE.test(f.date)) throw bad('ระบุวันที่');
    const from = localInstant(f.date, '00:00'), to = new Date(from); to.setDate(to.getDate() + 1);
    const svc = typeof f.serviceCode === 'string' && f.serviceCode ? f.serviceCode : null;
    return (this.store.db.prepare(`${BOOKING_SELECT} WHERE s.starts_at >= ? AND s.starts_at < ? AND (? IS NULL OR b.service_code = ?) ORDER BY s.starts_at, b.created_at`)
      .all(from.toISOString(), to.toISOString(), svc, svc) as BookingRow[]).map(toBooking);
  }

  // Short code for the patient's slip / LINE (BK + 6), random so codes can't be guessed in sequence.
  private newCode() {
    for (;;) {
      const code = 'BK' + Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
      if (!this.store.db.prepare('SELECT 1 FROM bookings WHERE booking_code = ?').get(code)) return code;
    }
  }
}
