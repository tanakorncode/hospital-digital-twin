import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localInstant } from '../src/booking.service';
import { metrics } from '../src/metrics';
import type { Report } from '../src/report.service';
import { ADMIN_PASSWORD, makeApi, signIn } from './helpers';

// The Phase 2 report (spec §15.1): from the records, for a range of days, counts only; staff limited to some clinics
// see only those. And the operation counters (refusals by code, replays, rate limits).
type R = { ok: boolean; code?: string; reason?: string; report?: Report; metrics?: ReturnType<typeof metrics.snapshot> };
const MED = 'opd-2-0', EYE = 'opd-4-1';
let n = 0;
const key = () => `rep-key-${String(++n).padStart(6, '0')}`;

// Tuesday 3 Nov 2026 08:30. Medicine: 3 bookings (one from LINE, one cancelled, one checked in at the kiosk) and
// 2 appointments (one moved on request). Eye: 1 booking.
function setup() {
  const api = makeApi(), now = localInstant('2026-11-03', '08:30');
  api.booking.now = () => now; api.appts.now = () => now;
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  api.gateway.setFeatures(admin, { patch: { generalBooking: true, appointments: true } });
  api.gateway.queueSettings(admin, { patch: { dataMode: 'live' }, at: 400, scope: 'system', summary: 'live' });
  for (const [c, name, letter] of [[MED, 'อายุรกรรม', 'A'], [EYE, 'ตา', 'H']]) {
    api.gateway.setBookingPolicy(admin, { serviceCode: c, displayName: name, enabled: true, queuePrefix: letter, cancelCutoffMinutes: 0, maxActivePerPatient: 3 });
    api.gateway.createBookingSlots(admin, { serviceCode: c, from: '2026-11-03', to: '2026-11-04', weekdays: [2, 3], start: '09:00', end: '11:00', minutes: 60, capacity: 1 });
  }
  api.gateway.setApptPolicy(admin, { clinicCode: MED, displayName: 'อายุรกรรม', enabled: true, cancelCutoffMinutes: 0, rescheduleNeedsApproval: true });
  api.gateway.createApptSessions(admin, { clinicCode: MED, providerCode: 'D1', providerName: 'นพ.เอ', from: '2026-11-04', to: '2026-11-04', weekdays: [3], start: '09:00', end: '10:00', minutes: 30, capacity: 2 });
  const med = api.booking.slots(MED, '2026-11-03'), med4 = api.booking.slots(MED, '2026-11-04');
  const first = (api.gateway.createBooking(admin, { hn: '65-000001', slotId: med[0].id, key: key() }) as { booking: { id: string; code: string } }).booking;
  const second = (api.gateway.createBooking(admin, { hn: '65-000002', slotId: med[1].id, key: key() }) as { booking: { id: string } }).booking;
  api.booking.book(api.booking.profileForHN('65-000003'), med4[0].id, 'LINE', 'line:test');
  api.gateway.createBooking(admin, { hn: '65-000004', slotId: api.booking.slots(EYE, '2026-11-03')[0].id, key: key() });
  api.gateway.cancelBooking(admin, { bookingId: second.id, reason: 'ผู้ป่วยขอยกเลิก' });
  assert.equal((api.gateway.checkInCode(admin, { code: first.code, channel: 'KIOSK', at: 520 }) as R).ok, true);
  const slots = api.appts.slots(MED, '2026-11-04');
  const ap = (api.gateway.createAppt(admin, { hn: '65-000005', slotId: slots[0].id, key: key() }) as { appointment: { id: string } }).appointment;
  api.gateway.createAppt(admin, { hn: '65-000006', slotId: slots[0].id, key: key() });
  const req = api.appts.requestReschedule(ap.id, slots[1].id, 'ติดธุระ', { kind: 'patient', profileId: api.booking.profileForHN('65-000005') });
  api.gateway.decideAppt(admin, { requestId: req.request!.id, approve: true });
  return { api, admin };
}

test('the report counts what was made, what came due and how it ended — per clinic and per day', () => {
  const { api, admin } = setup();
  const r = (api.gateway.phase2Report(admin, { from: '2026-11-03', to: '2026-11-04' }) as R).report!;
  assert.deepEqual([r.bookings.made, r.bookings.madeByLine], [4, 1]);
  assert.deepEqual([r.bookings.due, r.bookings.came, r.bookings.cancelled, r.bookings.waiting], [4, 1, 1, 2]);
  assert.deepEqual([r.appointments.made, r.appointments.due, r.appointments.moved, r.appointments.movePending], [2, 2, 1, 0]);
  assert.deepEqual(r.checkIns, { total: 1, kiosk: 1, counter: 0, outside: 0 });
  const medRow = r.clinics.find((c) => c.clinic === MED)!;
  assert.deepEqual([medRow.name, medRow.booking.due, medRow.appointment.due], ['อายุรกรรม', 3, 2]);
  assert.equal(r.days.length, 2);
  assert.deepEqual(r.days.map((d) => [d.day, d.bookingsMade, d.appointmentsMade, d.checkIns]), [['2026-11-03', 4, 2, 1], ['2026-11-04', 0, 0, 0]]);
  assert.ok(r.messages && r.line, 'administrators also see the hospital-wide LINE figures');
  assert.equal(JSON.stringify(r).includes('65-'), false, 'no HN anywhere');
});

test('who may see it: supervisors (their clinics only), not staff; ranges are checked', () => {
  const { api, admin } = setup();
  api.gateway.saveUser(admin, { username: 'eye.head', name: 'หัวหน้าตา', role: 'supervisor', password: 'password-1', clinics: [EYE] });
  api.gateway.saveUser(admin, { username: 'staff.a', name: 'A', role: 'staff', password: 'password-2' });
  const head = signIn(api, 'eye.head', 'password-1'), staff = signIn(api, 'staff.a', 'password-2');
  assert.equal((api.gateway.phase2Report(staff, { from: '2026-11-03', to: '2026-11-04' }) as R).code, 'FORBIDDEN');
  const r = (api.gateway.phase2Report(head, { from: '2026-11-03', to: '2026-11-04' }) as R).report!;
  assert.equal(r.scoped, true);
  assert.deepEqual(r.clinics.map((c) => c.clinic), [EYE]);
  assert.deepEqual([r.bookings.due, r.appointments.due, r.checkIns.total], [1, 0, 0]);
  assert.equal(r.messages, undefined);
  assert.equal((api.gateway.phase2Report(admin, { from: '2026-11-04', to: '2026-11-03' }) as R).code, 'VALIDATION_ERROR');
  assert.equal((api.gateway.phase2Report(admin, { from: '2026-01-01', to: '2026-12-31' }) as R).code, 'VALIDATION_ERROR', 'at most 92 days');
});

test('operation counters: refusals by code, replayed requests, rate limits — administrators only', () => {
  const { api, admin } = setup();
  metrics.reset();
  const full = api.booking.slots(MED, '2026-11-03')[0].id;
  assert.equal((api.gateway.createBooking(admin, { hn: '65-000009', slotId: full, key: key() }) as R).code, 'SLOT_FULL_OR_CLOSED');
  const k = key(), slot = api.booking.slots(EYE, '2026-11-04')[0].id;
  api.gateway.createBooking(admin, { hn: '65-000010', slotId: slot, key: k });
  api.gateway.createBooking(admin, { hn: '65-000010', slotId: slot, key: k });
  const m = (api.gateway.metricsReport(admin) as R).metrics!;
  assert.equal(m.counters['refused.socket.SLOT_FULL_OR_CLOSED'], 1);
  assert.equal(m.counters['replayed.booking:create'], 1);
  assert.equal(Object.keys(m.counters).some((c) => /\d{2}-\d{6}|user:\d/.test(c)), false, 'labels never name a patient or a user');
  api.gateway.saveUser(admin, { username: 'head.b', name: 'B', role: 'supervisor', password: 'password-2' });
  assert.equal((api.gateway.metricsReport(signIn(api, 'head.b', 'password-2')) as R).code, 'FORBIDDEN');
});
