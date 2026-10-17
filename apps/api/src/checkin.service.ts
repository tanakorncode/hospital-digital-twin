import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { BookingService, type Booking } from './booking.service';
import { DbService } from './db.service';
import { AppError } from './errors';
import { VisitsService, type Visit } from './visits.service';

// Check-in: a patient with a booking arrives and joins today's live queue.
// The booking, the visit (queue number) and the check-in record all live in this database, so the whole step is one
// transaction — there is no moment where the booking is used up but no queue number exists, or the reverse.
// Repeating a check-in (double tap, the kiosk lost the reply, the patient tries again at the counter) returns the same
// visit and number: the booking's source key is unique on visits and on check-in records.
// Where it happens:
//   KIOSK   — the patient types / scans the code; only inside the window (from N minutes before the slot to N minutes after)
//   COUNTER — staff, who may also check in an early / late patient the same day (recorded as late)
export type Channel = 'COUNTER' | 'KIOSK';
export type CheckInResult = { visit: Visit; booking: Booking; already: boolean; late: boolean };
const CODE_RE = /^BK[A-Z0-9]{6}$/;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

@Injectable()
export class CheckInService {
  constructor(private readonly store: DbService, private readonly booking: BookingService, private readonly visits: VisitsService) {}

  // at: the minute of the day the screens run on (as for every queue action); `prefix`: the clinic's queue letter, used
  // only when the clinic's booking rules do not name one yet.
  checkInBooking(code: unknown, opts: { channel: Channel; at: unknown; by: string; prefix?: unknown }): CheckInResult {
    const text = typeof code === 'string' ? code.trim().toUpperCase().replace(/[\s-]/g, '') : '';
    if (!CODE_RE.test(text)) throw new AppError('VALIDATION_ERROR', 'รหัสจองไม่ถูกต้อง (BK ตามด้วย 6 ตัว)');
    return this.store.tx(() => {
      const b = this.booking.list({ code: text })[0];
      if (!b) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบรหัสจองนี้ กรุณาตรวจสอบอีกครั้ง หรือติดต่อเคาน์เตอร์');
      // Already checked in: the same queue number again.
      const done = this.store.db.prepare(`SELECT visit_id, late FROM check_in_records WHERE source_type = 'BOOKING' AND source_id = ?`).get(b.id) as { visit_id: string; late: number } | undefined;
      if (done) {
        const v = this.visits.get(done.visit_id);
        if (v) return { visit: v, booking: b, already: true, late: !!done.late };
      }
      if (b.status === 'CANCELLED') throw new AppError('INVALID_STATE_TRANSITION', 'การจองนี้ถูกยกเลิกแล้ว กรุณาติดต่อเคาน์เตอร์');
      if (b.status !== 'CONFIRMED') throw new AppError('INVALID_STATE_TRANSITION', 'การจองนี้หมดอายุแล้ว กรุณาติดต่อเคาน์เตอร์');
      const now = this.booking.now(), start = new Date(b.startsAt), end = new Date(b.endsAt);
      if (start.toLocaleDateString('sv-SE') !== now.toLocaleDateString('sv-SE'))
        throw new AppError('POLICY_REJECTED', `การจองนี้เป็นของ${start.toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' })} ${hhmm(b.startsAt)} น.`);
      const p = this.booking.policy(b.serviceCode);
      const early = p?.checkinEarlyMinutes ?? 120, lateMin = p?.checkinLateMinutes ?? 60;
      const opensAt = new Date(start.getTime() - early * 60_000), closesAt = new Date(end.getTime() + lateMin * 60_000);
      const outside = now < opensAt || now > closesAt;
      if (outside && opts.channel === 'KIOSK')
        throw new AppError('POLICY_REJECTED', now < opensAt ? `เช็กอินได้ตั้งแต่ ${hhmm(opensAt.toISOString())} น.` : 'เลยเวลาเช็กอินของการจองนี้แล้ว กรุณาติดต่อเคาน์เตอร์');
      const prefix = p?.queuePrefix ?? opts.prefix;
      const { visit } = this.visits.enter({ flow: 'opd', clinicKey: b.serviceCode, dept: b.serviceName, prefix, at: opts.at }, { type: 'BOOKING', id: b.id },
        { profileId: this.profileOf(b.id), bookedSlot: `${hhmm(b.startsAt)}–${hhmm(b.endsAt)}` });
      const at = now.toISOString();
      if (this.store.db.prepare(`UPDATE bookings SET status = 'CONVERTED_TO_QUEUE', visit_id = ?, checked_in_at = ?, updated_at = ? WHERE id = ? AND status = 'CONFIRMED'`)
        .run(visit.id, at, at, b.id).changes !== 1) throw new AppError('INVALID_STATE_TRANSITION', 'การจองนี้เปลี่ยนสถานะไปแล้ว');
      this.store.db.prepare(`INSERT INTO check_in_records (id, source_type, source_id, patient_profile_id, status, visit_day, visit_id, channel, late, created_by, created_at)
        VALUES (?, 'BOOKING', ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?)`).run(`ci_${randomBytes(9).toString('base64url')}`, b.id, this.profileOf(b.id), now.toLocaleDateString('sv-SE'),
        visit.id, opts.channel, outside ? 1 : 0, opts.by, at);
      return { visit, booking: this.booking.get(b.id)!, already: false, late: outside };
    });
  }

  private profileOf(bookingId: string) {
    return (this.store.db.prepare('SELECT patient_profile_id AS p FROM bookings WHERE id = ?').get(bookingId) as { p: string }).p;
  }
}
