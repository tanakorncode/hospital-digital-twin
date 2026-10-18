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

test('queue: staff call, hold, open and move only at their departments’ stations; supervisors set only their groups', () => {
  const { api, admin, med, all } = setup();
  const ix = api.facility.index(), pointIn = (d: string, kind = 'room') => [...ix.point.values()].find((p) => { const g = ix.group.get(p.groupId)!; return g.departmentId === d && g.pointKind === kind && !p.retiredAt; })!.id;
  const medRoom = pointIn(MED), medRoom2 = [...ix.point.values()].filter((p) => ix.group.get(p.groupId)!.departmentId === MED && ix.group.get(p.groupId)!.pointKind === 'room')[1].id, eyeRoom = pointIn(EYE);
  const q = (u: typeof med, cmd: Record<string, unknown>) => api.gateway.queueCommand(u, { at: 600, patientId: 'p-0001', step: 3, ...cmd } as never) as R;
  assert.equal(q(med, { station: medRoom, action: 'call' }).ok, true, 'their own room');
  for (const action of ['open', 'call', 'hold', 'pause', 'done']) assert.equal(q(med, { station: eyeRoom, action }).code, 'FORBIDDEN', `${action} at another department`);
  assert.match(q(med, { station: eyeRoom, action: 'call' }).reason!, /นอกแผนก/);
  assert.equal(q(med, { station: 'made-up', action: 'call' }).code, 'FORBIDDEN', 'a station the model does not have');
  assert.equal(q(med, { station: 'supervisor', action: 'call' }).code, 'FORBIDDEN', 'the consoles only move and take requests');
  assert.equal(q(med, { station: medRoom, action: 'transfer', target: medRoom2, position: 'keep' }).ok, true, 'within the department');
  assert.equal(q(med, { station: medRoom, action: 'transfer', target: eyeRoom, position: 'keep' }).code, 'FORBIDDEN', 'into another department');
  assert.equal(q(med, { station: eyeRoom, action: 'transfer', target: medRoom, position: 'keep' }).code, 'FORBIDDEN', 'out of another department');
  assert.equal(q(med, { station: 'supervisor', action: 'transfer', target: eyeRoom, position: 'keep', step: 4 }).code, 'FORBIDDEN');
  assert.equal(q(med, { station: 'supervisor', action: 'transfer', target: medRoom2, position: 'keep', step: 4 }).ok, true);
  for (const u of [all, admin]) assert.equal(q(u, { station: eyeRoom, action: 'call', patientId: 'p-0002' }).ok, true, 'no list / administrator: everywhere');
  // A real patient of the eye clinic cannot be pulled into a medicine room by medicine staff.
  const v = api.gateway.enterVisit(all, { flow: 'opd', clinicKey: EYE, dept: 'ตา', prefix: 'H', at: 520, key: key() }) as R & { visit?: { id: string } };
  assert.equal(q(med, { station: 'supervisor', action: 'transfer', target: medRoom, position: 'keep', patientId: v.visit!.id, step: 0 }).code, 'FORBIDDEN');
  // Settings: a supervisor of medicine sets medicine's groups and stations, not the eye clinic's.
  const made = api.gateway.saveUser(admin, { username: 'med.sup', name: 'ซี', role: 'supervisor', password: 'password-3', clinics: [MED] }) as R;
  assert.equal(made.ok, true, made.reason);
  const sup = signIn(api, 'med.sup', 'password-3');
  const set = (patch: Record<string, unknown>) => api.gateway.queueSettings(sup, { patch, at: 600, scope: 'x', summary: 'ทดสอบ' } as never) as R;
  const medGroup = ix.point.get(medRoom)!.groupId, eyeGroup = ix.point.get(eyeRoom)!.groupId;
  assert.equal(set({ groups: { [medGroup]: { mode: 'suggest' } } }).ok, true);
  assert.equal(set({ stations: { [medRoom]: { cap: 3 } } }).ok, true);
  assert.equal(set({ groups: { [eyeGroup]: { mode: 'suggest' } } }).code, 'FORBIDDEN');
  assert.equal(set({ stations: { [medRoom]: { cap: 2 }, [eyeRoom]: { cap: 3 } } }).code, 'FORBIDDEN', 'one outside refuses all');
  assert.equal(api.queue.getSettings().stations[medRoom]?.cap, 3);
});

test('queue: the ER key covers every part of the ER (triage too); a shared service can be an account’s department', () => {
  const { api, admin } = setup();
  const ix = api.facility.index(), pointOf = (group: string) => [...ix.point.values()].find((p) => p.groupId === group && !p.retiredAt)!.id;
  const triage = pointOf('counter:triage'), pharmacy = pointOf('counter:pharmacy'), medRoom = [...ix.point.values()].find((p) => ix.group.get(p.groupId)!.departmentId === MED && ix.group.get(p.groupId)!.pointKind === 'room')!.id;
  api.gateway.saveUser(admin, { username: 'er.c', name: 'ซี', role: 'staff', password: 'password-4', clinics: ['er'] });
  assert.equal((api.gateway.saveUser(admin, { username: 'rx.d', name: 'ดี', role: 'staff', password: 'password-5', clinics: ['opd-1-1'] }) as R).ok, true, 'pharmacy is a department too');
  const er = signIn(api, 'er.c', 'password-4'), rx = signIn(api, 'rx.d', 'password-5');
  let n = 10; // a new patient each time: one already called elsewhere cannot be called again
  const q = (u: typeof er, station: string) => api.gateway.queueCommand(u, { at: 600, station, action: 'call', patientId: `p-00${++n}`, step: 1 } as never) as R;
  assert.equal(q(er, triage).ok, true, 'ER staff at triage');
  assert.equal(q(er, pharmacy).code, 'FORBIDDEN');
  assert.equal(q(rx, pharmacy).ok, true, 'pharmacy staff at the pharmacy');
  assert.equal(q(rx, medRoom).code, 'FORBIDDEN');
});
