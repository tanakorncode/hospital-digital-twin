import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Appointment } from '../src/appointment.service';
import type { User } from '../src/auth.service';
import { localInstant, type Booking } from '../src/booking.service';
import { ADMIN_PASSWORD, makeApi, signIn } from './helpers';

// Clinic scope (spec §14.2 / §16.4 "department scope enforced"): a staff member limited to medicine finds, books,
// cancels, moves and checks in only for medicine; one without a list (and every administrator) covers every clinic.
type R = { ok: boolean; code?: string; reason?: string; booking?: Booking; bookings?: Booking[]; appointment?: Appointment; appointments?: Appointment[]; requests?: unknown[]; user?: User };
const MED = 'opd-2-0', EYE = 'opd-4-1';
let n = 0;
const key = () => `scope-key-${String(++n).padStart(6, '0')}`;

function setup() {
  const api = makeApi(), now = localInstant('2026-11-03', '08:30');
  api.booking.now = () => now; api.appts.now = () => now;
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  api.gateway.setFeatures(admin, { patch: { generalBooking: true, appointments: true } });
  api.gateway.queueSettings(admin, { patch: { dataMode: 'live' }, at: 400, scope: 'system', summary: 'live' });
  for (const [c, name] of [[MED, 'อายุรกรรม'], [EYE, 'ตา']]) {
    api.gateway.setBookingPolicy(admin, { serviceCode: c, displayName: name, enabled: true, queuePrefix: c === MED ? 'A' : 'H' });
    api.gateway.createBookingSlots(admin, { serviceCode: c, from: '2026-11-03', to: '2026-11-04', weekdays: [2, 3], start: '09:00', end: '11:00', minutes: 60, capacity: 5 });
    api.gateway.setApptPolicy(admin, { clinicCode: c, displayName: name, enabled: true, rescheduleNeedsApproval: true, cancelCutoffMinutes: 0 });
    api.gateway.createApptSessions(admin, { clinicCode: c, providerCode: c === MED ? 'D1' : 'D2', providerName: c === MED ? 'นพ.เอ' : 'พญ.บี', from: '2026-11-03', to: '2026-11-04', weekdays: [2, 3], start: '09:00', end: '10:00', minutes: 30, capacity: 3 });
  }
  const made = api.gateway.saveUser(admin, { username: 'med.a', name: 'เอ', role: 'staff', password: 'password-1', clinics: [MED] }) as R;
  api.gateway.saveUser(admin, { username: 'all.b', name: 'บี', role: 'staff', password: 'password-2' });
  const med = signIn(api, 'med.a', 'password-1'), all = signIn(api, 'all.b', 'password-2');
  const bslot = (c: string, date = '2026-11-03') => api.booking.slots(c, date)[0].id;
  const aslot = (c: string, date = '2026-11-03') => api.appts.slots(c, date)[0].id;
  return { api, admin, med, all, bslot, aslot, medId: made.user!.id };
}

test('accounts keep their clinics; bad keys are refused; administrators always cover every clinic', () => {
  const { api, admin, medId } = setup();
  assert.deepEqual(api.auth.get(medId)!.clinics, [MED]);
  assert.equal((api.gateway.saveUser(admin, { id: medId, clinics: ['pharmacy'] }) as R).ok, false);
  assert.equal((api.gateway.saveUser(admin, { id: medId, clinics: 'opd-2-0' }) as R).ok, false);
  assert.deepEqual((api.gateway.saveUser(admin, { id: medId, clinics: [MED, 'er', MED] }) as R).user!.clinics, ['er', MED], 'duplicates dropped');
  assert.deepEqual((api.gateway.saveUser(admin, { id: medId, name: 'เอ ใหม่' }) as R).user!.clinics, ['er', MED], 'left out = unchanged');
  assert.deepEqual((api.gateway.saveUser(admin, { id: medId, clinics: [] }) as R).user!.clinics, [], 'empty = every clinic');
  assert.deepEqual(api.auth.list().find((u) => u.role === 'admin')!.clinics, []);
});

test('bookings: outside the clinics they cannot book, cancel or find them — at the counter or by HN', () => {
  const { api, med, all, bslot } = setup();
  const eye = api.gateway.createBooking(all, { hn: '65-000001', slotId: bslot(EYE), key: key() }) as R;
  assert.equal(eye.ok, true, eye.reason);
  assert.equal((api.gateway.createBooking(med, { hn: '65-000002', slotId: bslot(EYE), key: key() }) as R).code, 'FORBIDDEN');
  assert.equal((api.gateway.createBooking(med, { hn: '65-000002', slotId: bslot(MED), key: key() }) as R).ok, true);
  assert.equal((api.gateway.cancelBooking(med, { bookingId: eye.booking!.id, reason: 'ผู้ป่วยขอยกเลิก' }) as R).code, 'FORBIDDEN');
  assert.equal(api.booking.get(eye.booking!.id)!.status, 'CONFIRMED');
  assert.deepEqual((api.gateway.listBookings(med, { date: '2026-11-03' }) as R).bookings!.map((b) => b.serviceCode), [MED]);
  assert.equal((api.gateway.listBookings(med, { code: eye.booking!.code }) as R).bookings!.length, 0);
  api.gateway.createBooking(all, { hn: '65-000002', slotId: bslot(EYE, '2026-11-04'), key: key() });
  assert.deepEqual((api.gateway.listBookings(med, { hn: '65-000002' }) as R).bookings!.map((b) => b.serviceCode), [MED], 'HN search shows only their clinics');
  assert.equal((api.gateway.listBookings(all, { hn: '65-000002' }) as R).bookings!.length, 2);
});

test('check-in and walk-ins: only for their clinics', () => {
  const { api, med, all, bslot } = setup();
  const eye = (api.gateway.createBooking(all, { hn: '65-000001', slotId: bslot(EYE), key: key() }) as R).booking!;
  const r = api.gateway.checkInCode(med, { code: eye.code, at: 520 }) as R;
  assert.equal(r.code, 'FORBIDDEN');
  assert.match(r.reason!, /ตา/, 'says whose code it is so the patient can be sent there');
  assert.equal(api.booking.get(eye.id)!.status, 'CONFIRMED', 'nothing changed');
  const ok = api.gateway.checkInCode(all, { code: eye.code, at: 520 }) as R;
  assert.equal(ok.ok, true, ok.reason);
  assert.equal((api.gateway.enterVisit(med, { flow: 'opd', clinicKey: EYE, dept: 'ตา', prefix: 'H', at: 520, key: key() }) as R).code, 'FORBIDDEN');
  assert.equal((api.gateway.enterVisit(med, { flow: 'er', at: 520, key: key() }) as R).code, 'FORBIDDEN');
  const w = api.gateway.enterVisit(med, { flow: 'opd', clinicKey: MED, dept: 'อายุรกรรม', prefix: 'A', at: 520, key: key() }) as R;
  assert.equal(w.ok, true, w.reason);
});

test('appointments: make, move, cancel, decide and no-show only inside the clinics; lists are filtered', () => {
  const { api, admin, med, all, aslot } = setup();
  const eye = (api.gateway.createAppt(all, { hn: '65-000001', slotId: aslot(EYE, '2026-11-04'), key: key() }) as R).appointment!;
  assert.equal((api.gateway.createAppt(med, { hn: '65-000003', slotId: aslot(EYE), key: key() }) as R).code, 'FORBIDDEN');
  assert.equal((api.gateway.createAppt(med, { hn: '65-000003', slotId: aslot(MED), key: key() }) as R).ok, true);
  assert.equal((api.gateway.cancelAppt(med, { appointmentId: eye.id, reason: 'ผู้ป่วยขอยกเลิก' }) as R).code, 'FORBIDDEN');
  assert.equal((api.gateway.rescheduleAppt(med, { appointmentId: eye.id, slotId: api.appts.slots(EYE, '2026-11-04')[1].id, key: key() }) as R).code, 'FORBIDDEN');
  assert.deepEqual((api.gateway.listAppts(med, { date: '2026-11-04' }) as R).appointments!.length, 0);
  assert.equal((api.gateway.listAppts(all, { date: '2026-11-04' }) as R).appointments!.length, 1);
  // A request to move (from LINE) waits for staff of that clinic.
  const profile = api.booking.profileForHN('65-000001');
  const asked = api.appts.requestReschedule(eye.id, api.appts.slots(EYE, '2026-11-04')[1].id, 'ติดธุระ', { kind: 'patient', profileId: profile });
  assert.equal((api.gateway.apptRequests(med, {}) as R).requests!.length, 0);
  assert.equal((api.gateway.decideAppt(med, { requestId: asked.request!.id, approve: true }) as R).code, 'FORBIDDEN');
  assert.equal((api.gateway.decideAppt(admin, { requestId: asked.request!.id, approve: true }) as R).ok, true);
});

test('a changed account reaches screens already open: new clinics at once, suspended = signed out', () => {
  const { api, admin, med, bslot, medId } = setup();
  assert.equal((api.gateway.createBooking(med, { hn: '65-000009', slotId: bslot(EYE), key: key() }) as R).code, 'FORBIDDEN');
  api.gateway.saveUser(admin, { id: medId, clinics: [MED, EYE] });
  assert.equal((api.gateway.createBooking(med, { hn: '65-000009', slotId: bslot(EYE), key: key() }) as R).ok, true, 'no need to sign in again');
  api.gateway.saveUser(admin, { id: medId, active: false });
  assert.equal((api.gateway.listBookings(med, { date: '2026-11-03' }) as R).code, 'AUTH_REQUIRED', 'the open screen is signed out');
  const sent = (med as unknown as { sent: { event: string; data: unknown }[] }).sent.filter((e) => e.event === 'auth:me');
  assert.equal(sent.at(-1)!.data, null);
});
