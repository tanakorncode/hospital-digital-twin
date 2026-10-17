import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localInstant } from '../src/booking.service';
import { AppError } from '../src/errors';
import { ADMIN_PASSWORD, makeApi, patientController, signIn } from './helpers';

const U1 = `U${'1'.repeat(32)}`, U2 = `U${'2'.repeat(32)}`, U3 = `U${'3'.repeat(32)}`;
const MED = 'opd-2-0';
const codeOf = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as AppError).code; } return undefined; };
let n = 0;
const key = () => `portal-key-${String(++n).padStart(6, '0')}`;

// Monday 2 Nov 2026 10:00. Two linked patients (65-1 on U1, 65-2 on U2) and one LINE user not linked (U3).
async function setup(opts: { approval?: boolean } = {}) {
  const api = makeApi();
  const setNow = (d: Date) => { api.booking.now = () => d; api.appts.now = () => d; };
  setNow(localInstant('2026-11-02', '10:00'));
  api.identity.verifyIdToken = async (t: string) => t;
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  api.gateway.setFeatures(admin, { patch: { accountLinking: true, generalBooking: true, appointments: true } });
  api.gateway.setBookingPolicy(admin, { serviceCode: MED, displayName: 'อายุรกรรมทั่วไป', enabled: true, queuePrefix: 'A' });
  api.gateway.setBookingPolicy(admin, { serviceCode: 'opd-3-0', displayName: 'ศัลยกรรม', enabled: false });
  api.gateway.createBookingSlots(admin, { serviceCode: MED, from: '2026-11-03', to: '2026-11-04', weekdays: [2, 3], start: '09:00', end: '11:00', minutes: 60, capacity: 3 });
  api.gateway.setApptPolicy(admin, { clinicCode: MED, displayName: 'อายุรกรรมทั่วไป', enabled: true, queuePrefix: 'A', rescheduleNeedsApproval: opts.approval ?? true });
  api.gateway.createApptSessions(admin, { clinicCode: MED, providerCode: 'D001', providerName: 'นพ.สมชาย', from: '2026-11-04', to: '2026-11-06', weekdays: [3, 4, 5], start: '09:00', end: '10:00', minutes: 30, capacity: 2 });
  api.gateway.createApptSessions(admin, { clinicCode: MED, providerCode: 'D002', providerName: 'พญ.สมศรี', from: '2026-11-05', to: '2026-11-05', weekdays: [4], start: '13:00', end: '14:00', minutes: 30, capacity: 2 });
  const ctl = patientController(api);
  const session = async (u: string, hn?: string) => {
    const auth = `Bearer ${(await ctl.session('1.1.1.1', { idToken: u })).token}`;
    if (hn) api.gateway.confirmLink(admin, { code: ctl.startLink('1.1.1.1', auth).code, hn });
    return auth;
  };
  return { api, admin, ctl, setNow, p1: await session(U1, '65-1'), p2: await session(U2, '65-2'), stranger: await session(U3) };
}
const slotAt = (api: ReturnType<typeof makeApi>, date: string, time: string) => api.booking.slots(MED, date).find((s) => s.startsAt === localInstant(date, time).toISOString())!.id;

test('only a linked patient reaches the patient pages', async () => {
  const { ctl, stranger } = await setup();
  assert.equal(await codeOf(() => ctl.myBookings('1.1.1.1', stranger)), 'FORBIDDEN');
  assert.equal(await codeOf(() => ctl.queue('1.1.1.1', undefined)), 'AUTH_REQUIRED');
});

test('patients see only open services and book for themselves; a retried tap books once', async () => {
  const { api, ctl, p1, p2 } = await setup();
  assert.deepEqual(ctl.bookingServices('1.1.1.1', p1).services.map((s) => s.serviceCode), [MED], 'closed services are not offered');
  const slots = ctl.bookingSlots('1.1.1.1', MED, '2026-11-03', p1).slots;
  assert.equal(slots.length, 2);
  assert.ok(ctl.bookingDays('1.1.1.1', MED, p1).days.includes('2026-11-03'), 'the day picker offers days with places');
  assert.ok(!('capacity' in slots[0]), 'patients see places left, not the capacity');
  assert.equal(await codeOf(() => ctl.book('1.1.1.1', { slotId: slots[0].id }, p1, undefined)), 'VALIDATION_ERROR', 'needs an Idempotency-Key');
  const k = key();
  const a = ctl.book('1.1.1.1', { slotId: slots[0].id }, p1, k), b = ctl.book('1.1.1.1', { slotId: slots[0].id }, p1, k);
  assert.equal(a.booking.id, b.booking.id);
  assert.equal(a.booking.channel, 'LINE');
  assert.deepEqual(ctl.myBookings('1.1.1.1', p1).bookings.map((x) => x.id), [a.booking.id]);
  assert.deepEqual(ctl.myBookings('1.1.1.1', p2).bookings, [], 'never another patient\'s');
  assert.ok(api.emitted.some((e) => e.event === 'booking:changed' && e.to === 'staff'), 'the counter list refreshes');
  assert.ok(!JSON.stringify(api.audit.list()).includes(U1));
});

test('patients cancel only their own bookings, before the cut-off', async () => {
  const { api, ctl, p1, p2, setNow } = await setup();
  const mine = ctl.book('1.1.1.1', { slotId: slotAt(api, '2026-11-03', '10:00') }, p1, key()).booking;
  assert.equal(await codeOf(() => ctl.cancelBooking('1.1.1.1', mine.id, { reason: 'x' }, p2)), 'RESOURCE_NOT_FOUND');
  setNow(localInstant('2026-11-03', '09:30'));
  assert.equal(await codeOf(() => ctl.cancelBooking('1.1.1.1', mine.id, { reason: 'ติดธุระ' }, p1)), 'POLICY_REJECTED', 'within an hour of the slot');
  setNow(localInstant('2026-11-02', '10:00'));
  assert.equal(ctl.cancelBooking('1.1.1.1', mine.id, { reason: 'ติดธุระ' }, p1).booking.status, 'CANCELLED');
});

test('appointments: patients see theirs, may move to the same doctor only, and the clinic approves moves', async () => {
  const { api, admin, ctl, p1, p2 } = await setup();
  const slot = api.appts.slots(MED, '2026-11-04').find((s) => s.providerCode === 'D001')!;
  const a = (api.gateway.createAppt(admin, { hn: '65-1', slotId: slot.id, key: key() }) as { appointment: { id: string } }).appointment;
  assert.equal(ctl.myAppointments('1.1.1.1', p1).appointments.length, 1);
  assert.equal(ctl.myAppointments('1.1.1.1', p2).appointments.length, 0);
  const choices = ctl.appointmentSlots('1.1.1.1', a.id, '2026-11-05', p1).slots;
  assert.ok(choices.length > 0 && choices.every((s) => s.providerName === 'นพ.สมชาย'), 'the other doctor is not offered');
  assert.equal(await codeOf(() => ctl.appointmentSlots('1.1.1.1', a.id, '2026-11-05', p2)), 'RESOURCE_NOT_FOUND');
  assert.ok(ctl.appointmentDays('1.1.1.1', a.id, p1).days.includes('2026-11-05'));
  assert.equal(await codeOf(() => ctl.appointmentDays('1.1.1.1', a.id, p2)), 'RESOURCE_NOT_FOUND', 'not theirs');
  const otherDoctor = api.appts.slots(MED, '2026-11-05').find((s) => s.providerCode === 'D002')!;
  assert.equal(await codeOf(() => ctl.rescheduleAppointment('1.1.1.1', a.id, { slotId: otherDoctor.id }, p1)), 'POLICY_REJECTED');
  const r = ctl.rescheduleAppointment('1.1.1.1', a.id, { slotId: choices[0].id, reason: 'ติดงาน' }, p1);
  assert.equal(r.immediate, false, 'waits for the clinic');
  assert.equal(ctl.myAppointments('1.1.1.1', p1).appointments[0].pendingRequest?.startsAt, choices[0].startsAt);
  assert.equal(ctl.cancelAppointment('1.1.1.1', a.id, { reason: 'หายดีแล้ว' }, p1).appointment.status, 'CANCELLED');
});

test('my queue: today\'s number with its live link, and today\'s bookings still to check in', async () => {
  const { api, admin, ctl, p1, setNow } = await setup();
  const b = ctl.book('1.1.1.1', { slotId: slotAt(api, '2026-11-03', '09:00') }, p1, key()).booking;
  api.gateway.queueSettings(admin, { patch: { dataMode: 'live' }, at: 400, scope: 'system', summary: 'live' });
  setNow(localInstant('2026-11-03', '08:30'));
  const before = ctl.queue('1.1.1.1', p1);
  assert.deepEqual([before.visits.length, before.bookings.map((x) => x.code)], [0, [b.code]], 'booked today, not yet checked in');
  api.gateway.checkInCode(admin, { code: b.code, channel: 'COUNTER', at: 510 });
  const after = ctl.queue('1.1.1.1', p1);
  assert.equal(after.visits[0].queue, 'A001');
  assert.ok(api.tickets.check(after.visits[0].link).ok, 'a working link to the live queue page');
  assert.equal(after.bookings.length, 0);
});

test('a walk-in taken in with the HN (ID card checked) shows in the patient\'s LINE and gets queue messages', async () => {
  const { api, admin, ctl, p1 } = await setup();
  api.gateway.setFeatures(admin, { patch: { notifications: true } });
  api.gateway.queueSettings(admin, { patch: { dataMode: 'live' }, at: 400, scope: 'system', summary: 'live' });
  assert.equal((api.gateway.enterVisit(admin, { flow: 'opd', clinicKey: MED, dept: 'อายุรกรรมทั่วไป', prefix: 'A', at: 500, hn: 'bad hn!', key: key() }) as { code?: string }).code, 'VALIDATION_ERROR');
  const v = (api.gateway.enterVisit(admin, { flow: 'opd', clinicKey: MED, dept: 'อายุรกรรมทั่วไป', prefix: 'A', at: 500, hn: '65-1', key: key() }) as { visit: Record<string, unknown> }).visit;
  assert.ok(!JSON.stringify(v).includes('65-1'), 'the HN never travels with the visit');
  assert.deepEqual(ctl.queue('1.1.1.1', p1).visits.map((x) => x.queue), [v.queue]);
  api.gateway.queueCommand(admin, { at: 510, station: 'screen:opd-2-0', action: 'call', patientId: v.id as string, step: 0 });
  const jobs = (api.db.db.prepare('SELECT template FROM notification_jobs').all() as { template: string }[]).map((j) => j.template);
  assert.deepEqual(jobs, ['CHECKIN_DONE', 'QUEUE_CALL']);
  const anon = (api.gateway.enterVisit(admin, { flow: 'opd', clinicKey: MED, dept: 'อายุรกรรมทั่วไป', prefix: 'A', at: 501, key: key() }) as { visit: { id: string } }).visit;
  assert.equal(api.visits.profileOf(anon.id), undefined, 'without an HN the walk-in stays anonymous');
});
