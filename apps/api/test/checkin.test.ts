import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localInstant, type Booking } from '../src/booking.service';
import type { Visit } from '../src/visits.service';
import { ADMIN_PASSWORD, makeApi, signIn } from './helpers';

type R = { ok: boolean; code?: string; reason?: string; already?: boolean; late?: boolean; visit?: Visit; ticket?: { token: string }; booking?: Booking };
const MED = 'opd-2-0';
let n = 0;
const key = () => `ci-key-${String(++n).padStart(6, '0')}`;
const at = (time: string) => localInstant('2026-11-03', time);

// Tuesday 3 Nov 2026: a 09:00–10:00 booking, live data mode, the kiosk window is 120 min before to 60 min after.
function setup(opts: { prefix?: boolean; live?: boolean } = {}) {
  const api = makeApi();
  api.booking.now = () => localInstant('2026-11-02', '10:00');
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  api.gateway.setFeatures(admin, { patch: { generalBooking: true } });
  api.gateway.setBookingPolicy(admin, { serviceCode: MED, displayName: 'อายุรกรรมทั่วไป', enabled: true, ...(opts.prefix === false ? {} : { queuePrefix: 'A' }) });
  api.gateway.createBookingSlots(admin, { serviceCode: MED, from: '2026-11-03', to: '2026-11-04', weekdays: [2, 3], start: '09:00', end: '11:00', minutes: 60, capacity: 5 });
  if (opts.live !== false) api.gateway.queueSettings(admin, { patch: { dataMode: 'live' }, at: 400, scope: 'system', summary: 'live' });
  const slotId = (date: string, time: string) => api.booking.slots(MED, date).find((s) => s.startsAt === localInstant(date, time).toISOString())!.id;
  const book = (hn: string, date = '2026-11-03', time = '09:00') => (api.gateway.createBooking(admin, { hn, slotId: slotId(date, time), key: key() }) as R).booking!;
  const checkIn = (code: string, channel: 'KIOSK' | 'COUNTER' = 'COUNTER', prefix?: string) => api.gateway.checkInBooking(admin, { code, channel, at: 500, prefix }) as R;
  api.booking.now = () => at('08:30');
  return { api, admin, book, checkIn, slotId };
}

test('checking in turns the booking into a queue number, with the booked time beside it and a QR link', () => {
  const { api, book, checkIn } = setup();
  const b = book('65-111111');
  const r = checkIn(b.code);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.already, false);
  assert.equal(r.visit!.queue, 'A001');
  assert.equal(r.visit!.bookedSlot, 'จอง 09:00–10:00');
  assert.deepEqual(r.visit!.steps.map((s) => s.kind), ['screening', 'exam']);
  assert.ok(r.ticket!.token.length >= 20, 'the patient page link for the slip');
  assert.equal(api.booking.get(b.id)!.status, 'CONVERTED_TO_QUEUE');
  assert.equal(api.booking.get(b.id)!.visitId, r.visit!.id);
  assert.ok(!('patientProfileId' in r.visit!) && !JSON.stringify(r.visit).includes('111111'), 'who the patient is stays off the screens');
  assert.ok(api.emitted.some((e) => e.event === 'visit'), 'every screen sees the new number');
  assert.equal(api.audit.list({ targetType: 'booking', targetId: b.id })[0].action, 'checkin.booking');
  assert.equal(api.queue.apply({ at: 510, station: 'screen:opd-2-0', action: 'call', patientId: r.visit!.id, step: 0 }).ok, true, 'staff can call them');
});

test('checking in again gives the same number and link — never a second place in the queue', () => {
  const { api, book, checkIn } = setup();
  const b = book('65-111111');
  const first = checkIn(b.code, 'KIOSK'), again = checkIn(b.code.toLowerCase().replace(/^bk/, 'bk-'), 'COUNTER');
  assert.equal(again.already, true);
  assert.equal(again.visit!.id, first.visit!.id);
  assert.equal(again.visit!.queue, first.visit!.queue);
  assert.equal(again.ticket!.token, first.ticket!.token);
  assert.equal(api.visits.list().length, 1);
  assert.equal(api.audit.list({ targetType: 'booking', targetId: b.id }).filter((e) => e.action === 'checkin.booking').length, 1);
});

test('codes are checked: wrong format, unknown, cancelled, another day', () => {
  const { api, admin, book, checkIn } = setup();
  assert.equal(checkIn('12345').code, 'VALIDATION_ERROR');
  assert.equal(checkIn('BKZZZZZZ').code, 'RESOURCE_NOT_FOUND');
  const gone = book('65-1', '2026-11-03', '10:00'); // still before its cut-off at 08:30
  api.gateway.cancelBooking(admin, { bookingId: gone.id, reason: 'ขอยกเลิก' });
  assert.equal(checkIn(gone.code).code, 'INVALID_STATE_TRANSITION');
  const tomorrow = book('65-2', '2026-11-04');
  const r = checkIn(tomorrow.code);
  assert.equal(r.code, 'POLICY_REJECTED');
  assert.match(r.reason!, /09:00/);
  assert.equal(api.visits.list().length, 0);
});

test('the kiosk only checks in inside the window; the counter can still help an early or late patient that day', () => {
  const { api, book, checkIn } = setup();
  const b = book('65-1');
  api.booking.now = () => at('06:30');
  const early = checkIn(b.code, 'KIOSK');
  assert.equal(early.code, 'POLICY_REJECTED');
  assert.match(early.reason!, /07:00/);
  const c = book('65-2');
  api.booking.now = () => at('11:30');
  assert.equal(checkIn(c.code, 'KIOSK').code, 'POLICY_REJECTED', 'more than 60 min after the slot');
  const counter = checkIn(c.code, 'COUNTER');
  assert.equal(counter.ok, true);
  assert.equal(counter.late, true);
  assert.equal(api.audit.list({ targetType: 'booking', targetId: c.id })[0].meta?.late, true);
});

test('nothing changes if the queue number cannot be made (one transaction)', () => {
  const { api, book, checkIn, slotId } = setup({ prefix: false });
  const b = book('65-1');
  assert.equal(checkIn(b.code).code, 'VALIDATION_ERROR', 'no queue letter set for the clinic and none sent');
  assert.equal(api.booking.get(b.id)!.status, 'CONFIRMED', 'the booking is untouched');
  assert.equal(api.visits.list().length, 0);
  assert.equal(api.booking.slots(MED, '2026-11-03').find((s) => s.id === slotId('2026-11-03', '09:00'))!.reserved, 1);
  assert.equal(checkIn(b.code, 'COUNTER', 'A').visit!.queue, 'A001', 'the screen\'s letter is used when the rules have none');
});

test('check-in joins the real queue, so the live data mode must be on', () => {
  const { book, checkIn } = setup({ live: false });
  assert.equal(checkIn(book('65-1').code).code, 'POLICY_REJECTED');
});

test('a checked-in booking cannot be cancelled', () => {
  const { api, admin, book, checkIn } = setup();
  const b = book('65-1');
  checkIn(b.code);
  assert.equal((api.gateway.cancelBooking(admin, { bookingId: b.id, reason: 'x' }) as R).code, 'INVALID_STATE_TRANSITION');
});
