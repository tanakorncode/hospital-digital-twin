import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AppointmentService } from './appointment.service';
import { BookingService } from './booking.service';
import { DbService } from './db.service';
import { AppError } from './errors';
import { VisitsService, type Visit } from './visits.service';

// Check-in: a patient with a booking (BK…) or a doctor's appointment (AP…) arrives and joins today's live queue.
// The booking/appointment, the visit (queue number) and the check-in record all live in this database, so the whole
// step is one transaction — there is no moment where the reservation is used up but no queue number exists, or the
// reverse. Repeating a check-in (double tap, the kiosk lost the reply, the patient tries again at the counter)
// returns the same visit and number: the source key is unique on visits and on check-in records.
// Where it happens:
//   KIOSK   — the patient types / scans the code; only inside the window (from N minutes before to N minutes after)
//   COUNTER — staff, who may also check in an early / late patient the same day (recorded as late)
export type Channel = 'COUNTER' | 'KIOSK';
export type SourceInfo = { kind: 'BOOKING' | 'APPOINTMENT'; id: string; code: string; serviceName: string; startsAt: string; endsAt: string; providerName?: string };
export type CheckInResult = { visit: Visit; source: SourceInfo; already: boolean; late: boolean };
const CODE_RE = /^(BK|AP)[A-Z0-9]{6}$/;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
type Found = SourceInfo & { status: string; clinicCode: string; profileId: string; prefix?: string; early: number; lateMin: number };

@Injectable()
export class CheckInService {
  constructor(private readonly store: DbService, private readonly booking: BookingService, private readonly visits: VisitsService, private readonly appts: AppointmentService) {}

  // at: the minute of the day the screens run on (as for every queue action); `prefix`: the clinic's queue letter, used
  // only when the clinic's rules do not name one yet.
  checkIn(code: unknown, opts: { channel: Channel; at: unknown; by: string; prefix?: unknown }): CheckInResult {
    const text = typeof code === 'string' ? code.trim().toUpperCase().replace(/[\s-]/g, '') : '';
    if (!CODE_RE.test(text)) throw new AppError('VALIDATION_ERROR', 'รหัสไม่ถูกต้อง (BK หรือ AP ตามด้วย 6 ตัว)');
    return this.store.tx(() => {
      const f = text.startsWith('BK') ? this.findBooking(text) : this.findAppointment(text);
      if (!f) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบรหัสนี้ กรุณาตรวจสอบอีกครั้ง หรือติดต่อเคาน์เตอร์');
      const source: SourceInfo = { kind: f.kind, id: f.id, code: f.code, serviceName: f.serviceName, startsAt: f.startsAt, endsAt: f.endsAt, providerName: f.providerName };
      // Already checked in: the same queue number again.
      const done = this.store.db.prepare('SELECT visit_id, late FROM check_in_records WHERE source_type = ? AND source_id = ?').get(f.kind, f.id) as { visit_id: string; late: number } | undefined;
      if (done) {
        const v = this.visits.get(done.visit_id);
        if (v) return { visit: v, source, already: true, late: !!done.late };
      }
      const what = f.kind === 'BOOKING' ? 'การจอง' : 'นัด';
      if (f.status === 'CANCELLED') throw new AppError('INVALID_STATE_TRANSITION', `${what}นี้ถูกยกเลิกแล้ว กรุณาติดต่อเคาน์เตอร์`);
      if (f.status !== 'CONFIRMED') throw new AppError('INVALID_STATE_TRANSITION', `${what}นี้ใช้เช็กอินไม่ได้แล้ว กรุณาติดต่อเคาน์เตอร์`);
      const now = this.booking.now(), start = new Date(f.startsAt), end = new Date(f.endsAt);
      if (start.toLocaleDateString('sv-SE') !== now.toLocaleDateString('sv-SE'))
        throw new AppError('POLICY_REJECTED', `${what}นี้เป็นของ${start.toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' })} ${hhmm(f.startsAt)} น.`);
      const opensAt = new Date(start.getTime() - f.early * 60_000), closesAt = new Date(end.getTime() + f.lateMin * 60_000);
      const outside = now < opensAt || now > closesAt;
      if (outside && opts.channel === 'KIOSK')
        throw new AppError('POLICY_REJECTED', now < opensAt ? `เช็กอินได้ตั้งแต่ ${hhmm(opensAt.toISOString())} น.` : `เลยเวลาเช็กอินของ${what}นี้แล้ว กรุณาติดต่อเคาน์เตอร์`);
      const label = f.kind === 'BOOKING' ? `จอง ${hhmm(f.startsAt)}–${hhmm(f.endsAt)}` : `นัด ${hhmm(f.startsAt)} · ${f.providerName}`;
      const { visit } = this.visits.enter({ flow: 'opd', clinicKey: f.clinicCode, dept: f.serviceName, prefix: f.prefix ?? opts.prefix, at: opts.at },
        { type: f.kind, id: f.id }, { profileId: f.profileId, bookedSlot: label.slice(0, 60) });
      const at = now.toISOString();
      const moved = f.kind === 'BOOKING'
        ? this.store.db.prepare(`UPDATE bookings SET status = 'CONVERTED_TO_QUEUE', visit_id = ?, checked_in_at = ?, updated_at = ? WHERE id = ? AND status = 'CONFIRMED'`).run(visit.id, at, at, f.id).changes === 1
        : this.appts.markCheckedIn(f.id, visit.id, at);
      if (!moved) throw new AppError('INVALID_STATE_TRANSITION', `${what}นี้เปลี่ยนสถานะไปแล้ว`);
      this.store.db.prepare(`INSERT INTO check_in_records (id, source_type, source_id, patient_profile_id, status, visit_day, visit_id, channel, late, created_by, created_at)
        VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?)`).run(`ci_${randomBytes(9).toString('base64url')}`, f.kind, f.id, f.profileId, now.toLocaleDateString('sv-SE'),
        visit.id, opts.channel, outside ? 1 : 0, opts.by, at);
      return { visit, source, already: false, late: outside };
    });
  }

  private findBooking(code: string): Found | undefined {
    const b = this.booking.list({ code })[0];
    if (!b) return undefined;
    const p = this.booking.policy(b.serviceCode);
    return { kind: 'BOOKING', id: b.id, code: b.code, serviceName: b.serviceName, startsAt: b.startsAt, endsAt: b.endsAt, status: b.status, clinicCode: b.serviceCode,
      profileId: (this.store.db.prepare('SELECT patient_profile_id AS p FROM bookings WHERE id = ?').get(b.id) as { p: string }).p,
      prefix: p?.queuePrefix, early: p?.checkinEarlyMinutes ?? 120, lateMin: p?.checkinLateMinutes ?? 60 };
  }
  private findAppointment(code: string): Found | undefined {
    const a = this.appts.list({ code })[0];
    if (!a) return undefined;
    const p = this.appts.policy(a.clinicCode);
    return { kind: 'APPOINTMENT', id: a.id, code: a.code, serviceName: a.clinicName, startsAt: a.startsAt, endsAt: a.endsAt, providerName: a.providerName, status: a.status,
      clinicCode: a.clinicCode, profileId: this.appts.profileOf(a.id)!, prefix: p?.queuePrefix, early: p?.checkinEarlyMinutes ?? 120, lateMin: p?.checkinLateMinutes ?? 60 };
  }
}
