import { Injectable } from '@nestjs/common';
import { localInstant } from './booking.service';
import { DbService } from './db.service';
import { AppError } from './errors';

// The Phase 2 report (spec §15.1) for a range of days, from the records themselves — so it survives restarts:
//  • bookings and appointments due in the range, by outcome (came / cancelled / did not come) and per clinic;
//  • new ones made in the range, by channel (counter or LINE — how much LINE is used);
//  • check-ins by channel (kiosk / counter) and how many were outside their window;
//  • messages to patients by outcome, and LINE links made / ended / active.
// Counts only: no HN, no names, no LINE ids. Staff limited to some clinics see only those clinics (and not the
// hospital-wide LINE figures).
export type Outcome = { due: number; came: number; cancelled: number; missed: number; waiting: number };
export type ClinicRow = { clinic: string; name: string; booking: Outcome; appointment: Outcome };
export type DayRow = { day: string; bookingsMade: number; appointmentsMade: number; checkIns: number };
export type Report = {
  from: string; to: string; scoped: boolean;
  bookings: Outcome & { made: number; madeByLine: number };
  appointments: Outcome & { made: number; madeByLine: number; noShow: number; moved: number; movePending: number };
  checkIns: { total: number; kiosk: number; counter: number; outside: number };
  messages?: { sent: number; failed: number; skipped: number; waiting: number };
  line?: { linked: number; ended: number; active: number };
  clinics: ClinicRow[]; days: DayRow[];
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 92;
const empty = (): Outcome => ({ due: 0, came: 0, cancelled: 0, missed: 0, waiting: 0 });
const dayOf = (iso: string) => new Date(iso).toLocaleDateString('sv-SE');
// Booking / appointment status → outcome. "missed": the time passed without a check-in (EXPIRED) or a recorded no-show.
const BOOKING: Record<string, keyof Outcome> = { CONFIRMED: 'waiting', CHECKED_IN: 'came', CONVERTED_TO_QUEUE: 'came', CANCELLED: 'cancelled', EXPIRED: 'missed' };
const APPT: Record<string, keyof Outcome> = { CONFIRMED: 'waiting', CHECKED_IN: 'came', COMPLETED: 'came', CANCELLED: 'cancelled', EXPIRED: 'missed', NO_SHOW: 'missed' };

@Injectable()
export class ReportService {
  constructor(private readonly store: DbService) {}

  phase2(from: unknown, to: unknown, clinics: string[] = []): Report {
    if (typeof from !== 'string' || typeof to !== 'string' || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new AppError('VALIDATION_ERROR', 'ระบุช่วงวันที่');
    const start = localInstant(from, '00:00'), end = localInstant(to, '00:00'); end.setDate(end.getDate() + 1);
    if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_DAYS) throw new AppError('VALIDATION_ERROR', `ดูได้ครั้งละไม่เกิน ${MAX_DAYS} วัน`);
    const a = start.toISOString(), b = end.toISOString(), scoped = clinics.length > 0;
    const inScope = (c: string) => !scoped || clinics.includes(c);
    const db = this.store.db;
    const names = new Map<string, string>([
      ...(db.prepare('SELECT service_code AS c, display_name AS n FROM booking_policies').all() as { c: string; n: string }[]).map((r) => [r.c, r.n] as [string, string]),
      ...(db.prepare('SELECT clinic_code AS c, display_name AS n FROM appointment_policies').all() as { c: string; n: string }[]).map((r) => [r.c, r.n] as [string, string]),
    ]);
    const perClinic = new Map<string, ClinicRow>();
    const row = (c: string) => perClinic.get(c) ?? perClinic.set(c, { clinic: c, name: names.get(c) ?? c, booking: empty(), appointment: empty() }).get(c)!;
    const days = new Map<string, DayRow>();
    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) { const k = d.toLocaleDateString('sv-SE'); days.set(k, { day: k, bookingsMade: 0, appointmentsMade: 0, checkIns: 0 }); }
    const bump = (iso: string, k: 'bookingsMade' | 'appointmentsMade' | 'checkIns') => { const d = days.get(dayOf(iso)); if (d) d[k]++; };

    // Due in the range (by the booked time).
    const bookings = { ...empty(), made: 0, madeByLine: 0 };
    for (const r of db.prepare(`SELECT b.service_code AS c, b.status FROM bookings b JOIN booking_slots s ON s.id = b.slot_id WHERE s.starts_at >= ? AND s.starts_at < ?`).all(a, b) as { c: string; status: string }[]) {
      if (!inScope(r.c)) continue;
      const o = BOOKING[r.status]; bookings.due++; bookings[o]++; row(r.c).booking.due++; row(r.c).booking[o]++;
    }
    const appointments = { ...empty(), made: 0, madeByLine: 0, noShow: 0, moved: 0, movePending: 0 };
    for (const r of db.prepare(`SELECT a.clinic_code AS c, a.status FROM appointments a JOIN appointment_slots s ON s.id = a.slot_id WHERE s.starts_at >= ? AND s.starts_at < ?`).all(a, b) as { c: string; status: string }[]) {
      if (!inScope(r.c)) continue;
      const o = APPT[r.status]; appointments.due++; appointments[o]++; if (r.status === 'NO_SHOW') appointments.noShow++;
      row(r.c).appointment.due++; row(r.c).appointment[o]++;
    }
    // Made in the range (by when), and by which channel.
    for (const r of db.prepare('SELECT service_code AS c, channel, created_at AS at FROM bookings WHERE created_at >= ? AND created_at < ?').all(a, b) as { c: string; channel: string; at: string }[]) {
      if (!inScope(r.c)) continue;
      bookings.made++; if (r.channel === 'LINE') bookings.madeByLine++; bump(r.at, 'bookingsMade');
    }
    for (const r of db.prepare('SELECT clinic_code AS c, channel, created_at AS at FROM appointments WHERE created_at >= ? AND created_at < ?').all(a, b) as { c: string; channel: string; at: string }[]) {
      if (!inScope(r.c)) continue;
      appointments.made++; if (r.channel === 'LINE') appointments.madeByLine++; bump(r.at, 'appointmentsMade');
    }
    // Requests to move: decided in the range (approved = moved), and those still waiting now.
    for (const r of db.prepare(`SELECT a.clinic_code AS c, r.status, r.decided_at AS at FROM appointment_reschedule_requests r JOIN appointments a ON a.id = r.appointment_id
      WHERE r.status = 'PENDING' OR (r.decided_at >= ? AND r.decided_at < ?)`).all(a, b) as { c: string; status: string; at: string | null }[]) {
      if (!inScope(r.c)) continue;
      if (r.status === 'PENDING') appointments.movePending++; else if (r.status === 'APPROVED') appointments.moved++;
    }
    // Check-ins in the range (the clinic comes from the booking / appointment).
    const checkIns = { total: 0, kiosk: 0, counter: 0, outside: 0 };
    for (const r of db.prepare(`SELECT c.channel, c.late, c.created_at AS at, COALESCE(b.service_code, ap.clinic_code) AS c FROM check_in_records c
      LEFT JOIN bookings b ON c.source_type = 'BOOKING' AND b.id = c.source_id LEFT JOIN appointments ap ON c.source_type = 'APPOINTMENT' AND ap.id = c.source_id
      WHERE c.created_at >= ? AND c.created_at < ?`).all(a, b) as { channel: string; late: number; at: string; c: string | null }[]) {
      if (scoped && (!r.c || !inScope(r.c))) continue;
      checkIns.total++; if (r.channel === 'KIOSK') checkIns.kiosk++; else checkIns.counter++; if (r.late) checkIns.outside++; bump(r.at, 'checkIns');
    }
    const report: Report = { from, to, scoped, bookings, appointments, checkIns, clinics: [...perClinic.values()].sort((x, y) => x.name.localeCompare(y.name, 'th')), days: [...days.values()] };
    if (!scoped) {
      const m = { sent: 0, failed: 0, skipped: 0, waiting: 0 };
      for (const r of db.prepare(`SELECT status, COUNT(*) AS n FROM notification_jobs WHERE created_at >= ? AND created_at < ? GROUP BY status`).all(a, b) as { status: string; n: number }[]) {
        if (r.status === 'SENT') m.sent += r.n; else if (r.status === 'FAILED') m.failed += r.n; else if (r.status === 'SKIPPED') m.skipped += r.n;
        else if (r.status !== 'CANCELLED') m.waiting += r.n;
      }
      report.messages = m;
      const n = (sql: string, ...args: string[]) => (db.prepare(sql).get(...args) as { n: number }).n;
      report.line = { linked: n('SELECT COUNT(*) AS n FROM line_patient_links WHERE created_at >= ? AND created_at < ?', a, b),
        ended: n('SELECT COUNT(*) AS n FROM line_patient_links WHERE ended_at >= ? AND ended_at < ?', a, b),
        active: n(`SELECT COUNT(*) AS n FROM line_patient_links WHERE status = 'ACTIVE'`) };
    }
    return report;
  }
}
