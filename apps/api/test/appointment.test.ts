import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Appointment, ApptSlot, RescheduleRequest } from '../src/appointment.service';
import { localInstant } from '../src/booking.service';
import type { AppError } from '../src/errors';
import type { Visit } from '../src/visits.service';
import { ADMIN_PASSWORD, makeApi, signIn } from './helpers';

type R = { ok: boolean; code?: string; reason?: string; appointment?: Appointment; request?: RescheduleRequest; slots?: ApptSlot[]; appointments?: Appointment[];
  sessions?: number; skipped?: number; conflicts?: string[]; cancelled?: number; visit?: Visit; already?: boolean };
const MED = 'opd-2-0', EYE = 'opd-4-1';
let n = 0;
const key = () => `ap-key-${String(++n).padStart(6, '0')}`;
const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AppError).code; } return undefined; };

// Monday 2 Nov 2026, 10:00. Dr A: Tue–Thu 09:00–12:00 in 30-min slots of 2. Dr B: Tue 13:00–15:00.
function setup(opts: { approval?: boolean; cutoff?: number } = {}) {
  const api = makeApi();
  const setNow = (d: Date) => { api.appts.now = () => d; api.booking.now = () => d; };
  setNow(localInstant('2026-11-02', '10:00'));
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  api.gateway.setFeatures(admin, { patch: { appointments: true } });
  for (const [c, name] of [[MED, 'อายุรกรรมทั่วไป'], [EYE, 'ตา']])
    api.gateway.setApptPolicy(admin, { clinicCode: c, displayName: name, enabled: true, queuePrefix: c === MED ? 'A' : 'H', rescheduleNeedsApproval: opts.approval ?? true, cancelCutoffMinutes: opts.cutoff ?? 1440 });
  const made = api.gateway.createApptSessions(admin, { clinicCode: MED, providerCode: 'D001', providerName: 'นพ.สมชาย ใจดี', from: '2026-11-03', to: '2026-11-05', weekdays: [2, 3, 4], start: '09:00', end: '12:00', minutes: 30, capacity: 2 }) as R;
  api.gateway.createApptSessions(admin, { clinicCode: MED, providerCode: 'D002', providerName: 'พญ.สมศรี รักษา', from: '2026-11-03', to: '2026-11-03', weekdays: [2], start: '13:00', end: '15:00', minutes: 30, capacity: 2 });
  api.gateway.saveUser(admin, { username: 'staff.a', name: 'A', role: 'staff', password: 'password-1' });
  api.gateway.saveUser(admin, { username: 'head.b', name: 'B', role: 'supervisor', password: 'password-2' });
  const staff = signIn(api, 'staff.a', 'password-1'), head = signIn(api, 'head.b', 'password-2');
  const slot = (date: string, time: string, provider = 'D001') => api.appts.slots(MED, date, provider).find((s) => s.startsAt === localInstant(date, time).toISOString())!;
  const make = (hn: string, date = '2026-11-03', time = '09:00', provider = 'D001') => api.gateway.createAppt(staff, { hn, slotId: slot(date, time, provider).id, key: key() }) as R;
  return { api, admin, staff, head, slot, make, setNow, made };
}

test('administrators set rules and doctors\' sessions; a doctor is never in two sessions at once', () => {
  const { api, admin, staff, made } = setup();
  assert.deepEqual([made.sessions, made.conflicts!.length], [3, 0]);
  assert.equal(api.appts.slots(MED, '2026-11-03').length, 6 + 4, 'Dr A 6 slots + Dr B 4 slots');
  assert.equal((api.gateway.setApptPolicy(staff, { clinicCode: MED, enabled: false }) as R).code, 'FORBIDDEN');
  const again = api.gateway.createApptSessions(admin, { clinicCode: MED, providerCode: 'D001', providerName: 'นพ.สมชาย ใจดี', from: '2026-11-03', to: '2026-11-03', weekdays: [2], start: '09:00', end: '12:00', minutes: 30, capacity: 2 }) as R;
  assert.equal(again.skipped, 1, 'the same session again is skipped');
  const clash = api.gateway.createApptSessions(admin, { clinicCode: EYE, providerCode: 'D001', providerName: 'นพ.สมชาย ใจดี', from: '2026-11-04', to: '2026-11-04', weekdays: [3], start: '10:00', end: '11:00', minutes: 30, capacity: 2 }) as R;
  assert.deepEqual([clash.sessions, clash.conflicts], [0, ['2026-11-04']], 'overlaps his medicine session that day');
  assert.equal((api.gateway.apptSessions(staff, { clinicCode: MED, date: '2026-11-03' }) as { sessions: unknown[] }).sessions.length, 2);
  // The doctors the form offers again, each once, with the clinics they work in.
  assert.deepEqual((api.gateway.apptProviders(staff) as { providers: { code: string; name: string; clinics: string[] }[] }).providers.map((p) => [p.code, p.name, p.clinics]),
    [['D001', 'นพ.สมชาย ใจดี', [MED]], ['D002', 'พญ.สมศรี รักษา', [MED]]]);
});

test('staff make an appointment by HN: an AP code, the doctor, the HN masked; one per clinic per day', () => {
  const { api, admin, make } = setup();
  const r = make('65-123456');
  assert.equal(r.ok, true, r.reason);
  assert.match(r.appointment!.code, /^AP[A-Z0-9]{6}$/);
  assert.equal(r.appointment!.providerName, 'นพ.สมชาย ใจดี');
  assert.equal(r.appointment!.hn, '••3456');
  assert.equal(make('65-123456', '2026-11-03', '13:00', 'D002').code, 'POLICY_REJECTED', 'already has one in this clinic that day');
  assert.equal(make('65-123456', '2026-11-04').ok, true, 'another day is fine');
  api.gateway.setFeatures(admin, { patch: { appointments: false } });
  assert.equal(make('65-9').code, 'FEATURE_DISABLED');
});

test('a slot never takes more than its places', () => {
  const { make } = setup();
  assert.equal(make('65-1').ok, true);
  assert.equal(make('65-2').ok, true);
  assert.equal(make('65-3').code, 'SLOT_FULL_OR_CLOSED');
});

test('cancelling gives the place back once; after the cut-off only a supervisor with overrides', () => {
  const { api, admin, staff, head, slot, make } = setup({ cutoff: 1440 * 2 });
  const a = make('65-1').appointment!; // Tue 09:00 — less than 2 days away
  assert.equal((api.gateway.cancelAppt(staff, { appointmentId: a.id, reason: 'ขอยกเลิก' }) as R).code, 'POLICY_REJECTED');
  assert.equal((api.gateway.cancelAppt(head, { appointmentId: a.id, reason: 'ขอยกเลิก' }) as R).code, 'POLICY_REJECTED');
  api.gateway.setFeatures(admin, { patch: { staffOverrides: true } });
  assert.equal((api.gateway.cancelAppt(head, { appointmentId: a.id, reason: 'ผู้ป่วยนอนโรงพยาบาลที่อื่น' }) as R).appointment!.status, 'CANCELLED');
  assert.equal((api.gateway.cancelAppt(head, { appointmentId: a.id, reason: 'ซ้ำ' }) as R).ok, true);
  assert.equal(slot('2026-11-03', '09:00').reserved, 0, 'released exactly once');
});

test('moving an appointment swaps the places in one step — or changes nothing', () => {
  const { api, staff, slot, make } = setup();
  const a = make('65-1').appointment!;
  make('65-2', '2026-11-04', '09:00'); make('65-3', '2026-11-04', '09:00'); // Wed 09:00 is now full
  const full = api.gateway.rescheduleAppt(staff, { appointmentId: a.id, slotId: slot('2026-11-04', '09:00').id, key: key() }) as R;
  assert.equal(full.code, 'SLOT_FULL_OR_CLOSED');
  assert.equal(api.appts.get(a.id)!.startsAt, localInstant('2026-11-03', '09:00').toISOString(), 'still at the old time');
  assert.equal(slot('2026-11-03', '09:00').reserved, 1);
  const moved = api.gateway.rescheduleAppt(staff, { appointmentId: a.id, slotId: slot('2026-11-03', '13:00', 'D002').id, key: key() }) as R;
  assert.equal(moved.appointment!.providerName, 'พญ.สมศรี รักษา');
  assert.equal(slot('2026-11-03', '09:00').reserved, 0);
  assert.equal(slot('2026-11-03', '13:00', 'D002').reserved, 1);
  api.gateway.createApptSessions(signIn(api, 'admin', ADMIN_PASSWORD), { clinicCode: EYE, providerCode: 'D009', providerName: 'นพ.ตา', from: '2026-11-03', to: '2026-11-03', weekdays: [2], start: '09:00', end: '10:00', minutes: 30, capacity: 2 });
  const eye = api.appts.slots(EYE, '2026-11-03')[0];
  assert.equal((api.gateway.rescheduleAppt(staff, { appointmentId: a.id, slotId: eye.id, key: key() }) as R).code, 'POLICY_REJECTED', 'another clinic');
});

test('a request to move holds no place until approved; approval fails cleanly if the slot filled up', () => {
  const { api, staff, slot, make } = setup();
  const a = make('65-1').appointment!;
  const target = slot('2026-11-04', '10:00');
  const asked = api.appts.requestReschedule(a.id, target.id, 'ติดธุระ', { kind: 'staff', id: 1, canOverride: false });
  assert.equal(asked.immediate, false);
  assert.equal(api.appts.get(a.id)!.status, 'CONFIRMED', 'the original appointment stays valid');
  assert.equal(api.appts.get(a.id)!.pendingRequest!.id, asked.request!.id);
  assert.equal(slot('2026-11-04', '10:00').reserved, 0, 'no place held while waiting');
  assert.equal(codeOf(() => api.appts.requestReschedule(a.id, target.id, 'x', { kind: 'staff', id: 1, canOverride: false })), 'POLICY_REJECTED', 'one waiting request at a time');
  make('65-2', '2026-11-04', '10:00'); make('65-3', '2026-11-04', '10:00');
  assert.equal((api.gateway.decideAppt(staff, { requestId: asked.request!.id, approve: true }) as R).code, 'SLOT_FULL_OR_CLOSED');
  assert.equal(api.appts.requests()[0].status, 'PENDING', 'still waiting; nothing moved');
  assert.equal((api.gateway.decideAppt(staff, { requestId: asked.request!.id, approve: false }) as R).code, 'VALIDATION_ERROR', 'a rejection needs a reason');
  assert.equal((api.gateway.decideAppt(staff, { requestId: asked.request!.id, approve: false, note: 'ช่วงนั้นเต็ม เสนอวันพฤหัส' }) as R).request!.status, 'REJECTED');
  const b = api.appts.requestReschedule(a.id, slot('2026-11-05', '09:00').id, '', { kind: 'staff', id: 1, canOverride: false });
  const ok = api.gateway.decideAppt(staff, { requestId: b.request!.id, approve: true }) as R;
  assert.equal(ok.request!.status, 'APPROVED');
  assert.equal(api.appts.get(a.id)!.startsAt, localInstant('2026-11-05', '09:00').toISOString());
  assert.equal(api.appts.get(a.id)!.pendingRequest, undefined);
});

test('patients reach only their own appointments; without approval their move happens at once', () => {
  const { api, slot, make } = setup({ approval: false });
  const a = make('65-1', '2026-11-04').appointment!; // Wednesday: outside the 24-h cut-off
  const owner = api.booking.profileForHN('65-1'), other = api.booking.profileForHN('65-2');
  assert.equal(codeOf(() => api.appts.cancel(a.id, 'x', { kind: 'patient', profileId: other })), 'RESOURCE_NOT_FOUND');
  assert.equal(codeOf(() => api.appts.requestReschedule(a.id, slot('2026-11-05', '09:00').id, 'x', { kind: 'patient', profileId: other })), 'RESOURCE_NOT_FOUND');
  const r = api.appts.requestReschedule(a.id, slot('2026-11-05', '09:00').id, 'ติดงาน', { kind: 'patient', profileId: owner });
  assert.equal(r.immediate, true);
  assert.equal(r.appointment.startsAt, localInstant('2026-11-05', '09:00').toISOString());
  const t = make('65-9').appointment!; // Tuesday 09:00: inside the cut-off
  assert.equal(codeOf(() => api.appts.requestReschedule(t.id, slot('2026-11-05', '10:00').id, 'x', { kind: 'patient', profileId: api.booking.profileForHN('65-9') })), 'POLICY_REJECTED');
});

test('cancelling a doctor\'s session cancels its appointments and closes requests into it', () => {
  const { api, admin, slot, make } = setup();
  const a = make('65-1').appointment!, b = make('65-2', '2026-11-04').appointment!;
  api.appts.requestReschedule(b.id, slot('2026-11-03', '10:00').id, '', { kind: 'staff', id: 1, canOverride: false });
  const session = api.appts.sessions(MED, '2026-11-03').find((s) => s.providerCode === 'D001')!;
  assert.equal((api.gateway.setApptSession(admin, { sessionId: session.id, status: 'CANCELLED' }) as R).code, 'VALIDATION_ERROR');
  const r = api.gateway.setApptSession(admin, { sessionId: session.id, status: 'CANCELLED', reason: 'แพทย์ลาประชุม' }) as R;
  assert.equal(r.cancelled, 1);
  assert.equal(api.appts.get(a.id)!.cancellationReason, 'แพทย์ลาประชุม');
  assert.equal(api.appts.get(b.id)!.status, 'CONFIRMED');
  assert.equal(api.appts.get(b.id)!.pendingRequest, undefined, 'the request into the cancelled session is closed');
  assert.equal(make('65-3', '2026-11-03', '11:00').code, 'SLOT_FULL_OR_CLOSED');
});

test('no-show: a supervisor\'s decision after the time, with a reason — never automatic', () => {
  const { api, staff, head, make, setNow } = setup();
  const a = make('65-1').appointment!;
  assert.equal((api.gateway.noShowAppt(staff, { appointmentId: a.id, reason: 'x' }) as R).code, 'FORBIDDEN');
  assert.equal((api.gateway.noShowAppt(head, { appointmentId: a.id, reason: 'x' }) as R).code, 'POLICY_REJECTED', 'not over yet');
  setNow(localInstant('2026-11-03', '12:00'));
  assert.equal((api.gateway.noShowAppt(head, { appointmentId: a.id }) as R).code, 'VALIDATION_ERROR');
  assert.equal((api.gateway.noShowAppt(head, { appointmentId: a.id, reason: 'โทรติดต่อแล้วไม่มา' }) as R).appointment!.status, 'NO_SHOW');
  const b = make('65-2', '2026-11-04').appointment!;
  setNow(localInstant('2026-11-05', '07:00'));
  assert.equal(api.appts.expire(), 1);
  assert.equal(api.appts.get(b.id)!.status, 'EXPIRED', 'an unmarked past appointment expires — it is not a no-show');
});

test('an AP code checks in like a booking: a queue number with the doctor beside it, the same one if repeated', () => {
  const { api, admin, make, setNow } = setup();
  api.gateway.queueSettings(admin, { patch: { dataMode: 'live' }, at: 400, scope: 'system', summary: 'live' });
  const a = make('65-1').appointment!;
  setNow(localInstant('2026-11-03', '08:30'));
  const r = api.gateway.checkInCode(admin, { code: a.code, channel: 'KIOSK', at: 510 }) as R;
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.visit!.queue, 'A001');
  assert.equal(r.visit!.bookedSlot, 'นัด 09:00 · นพ.สมชาย ใจดี');
  assert.equal(api.appts.get(a.id)!.status, 'CHECKED_IN');
  assert.equal((api.gateway.checkInCode(admin, { code: a.code, channel: 'COUNTER', at: 511 }) as R).visit!.id, r.visit!.id);
  assert.equal(api.visits.list().length, 1);
  assert.equal((api.gateway.cancelAppt(admin, { appointmentId: a.id, reason: 'x' }) as R).code, 'INVALID_STATE_TRANSITION');
});

test('staff find appointments by day, code or HN (HN searches audited without the HN)', () => {
  const { api, staff, make } = setup();
  const a = make('65-424242').appointment!;
  assert.equal((api.gateway.listAppts(staff, { date: '2026-11-03' }) as R).appointments!.length, 1);
  assert.equal((api.gateway.listAppts(staff, { code: a.code.toLowerCase() }) as R).appointments![0].id, a.id);
  assert.equal((api.gateway.listAppts(staff, { hn: '65-424242' }) as R).appointments!.length, 1);
  assert.ok(!JSON.stringify(api.audit.list({ targetType: 'patient-search' })).includes('424242'));
  assert.ok(api.emitted.some((e) => e.event === 'appointment:changed' && e.to === 'staff'));
});

test('days on offer: only those with a doctor session and a place left, per doctor if asked', () => {
  const { api, staff } = setup();
  const days = (body: Record<string, unknown>) => (api.gateway.apptDays(staff, { clinicCode: MED, ...body }) as { days: string[] }).days;
  assert.deepEqual(days({}), ['2026-11-03', '2026-11-04', '2026-11-05']);
  assert.deepEqual(days({ providerCode: 'D002' }), ['2026-11-03']);
  assert.deepEqual((api.gateway.apptDays(staff, { clinicCode: EYE }) as { days: string[] }).days, [], 'no sessions');
});

test('before booking, staff check the HN: new here or seen before, what is still to come, LINE linked', () => {
  const { api, staff, make } = setup();
  type P = R & { patient?: { known: boolean; lineLinked: boolean; appointments: { code: string; clinicName: string; startsAt: string }[]; bookings: unknown[] } };
  const check = (hn: unknown) => api.gateway.patientByHn(staff, { hn }) as P;
  assert.deepEqual(check('65-777777').patient, { known: false, lineLinked: false, appointments: [], bookings: [] }, 'new here');
  assert.equal(check('x').code, 'VALIDATION_ERROR');
  assert.equal(check('').code, 'VALIDATION_ERROR');
  const a = make('65-777777','2026-11-05').appointment!; // past the 24-hour cancel cut-off, so it can be cancelled below
  const p = check('65-777777').patient!;
  assert.equal(p.known, true);
  assert.deepEqual(p.appointments.map((x) => [x.code, x.clinicName]), [[a.code, 'อายุรกรรมทั่วไป']]);
  // A cancelled appointment is not "to come".
  assert.equal((api.gateway.cancelAppt(staff, { appointmentId: a.id, reason: 'ผู้ป่วยแจ้ง' }) as R).ok, true);
  assert.deepEqual(check('65-777777').patient!.appointments, []);
  assert.ok(api.audit.list().some((e) => e.action === 'patient.search.hn'));
  assert.equal((api.gateway.patientByHn({ handshake: { auth: {}, headers: {} }, data: {} } as never, { hn: '65-777777' }) as R).code, 'AUTH_REQUIRED');
});

test('a schedule can mix hours by day: mornings on some days, afternoons on others, both on one', () => {
  const { api, admin } = setup();
  // Dr C, 9–20 Nov 2026: Mon + Tue 09:00–12:00, Wed 13:00–16:00, Mon also 13:00–15:00.
  const r = api.gateway.createApptSessions(admin, { clinicCode: EYE, providerCode: 'D003', providerName: 'นพ.ชัย ตาดี', from: '2026-11-09', to: '2026-11-20', minutes: 30, capacity: 1,
    blocks: [{ weekdays: [1, 2], start: '09:00', end: '12:00' }, { weekdays: [3], start: '13:00', end: '16:00' }, { weekdays: [1], start: '13:00', end: '15:00' }] }) as R & { slots?: number };
  assert.equal(r.ok, true, r.reason);
  // Mondays 2 sessions, Tuesdays 1, Wednesdays 1, over two weeks → 8 sessions; 6 + 6 + 6 + 4 slots a week → 44.
  assert.deepEqual([r.sessions, r.slots, r.conflicts], [8, 44, []]);
  const mon = api.appts.slots(EYE, '2026-11-09', 'D003').map((s) => new Date(s.startsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }));
  assert.deepEqual(mon, ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '13:00', '13:30', '14:00', '14:30'], 'morning and afternoon on Monday');
  assert.equal(api.appts.slots(EYE, '2026-11-11', 'D003').length, 6, 'Wednesday afternoon only');
  // Two blocks overlapping on the same day: the second is left out for that day, and said.
  const clash = api.gateway.createApptSessions(admin, { clinicCode: EYE, providerCode: 'D004', providerName: 'พญ.ซ้อน เวลา', from: '2026-11-09', to: '2026-11-09', minutes: 30, capacity: 1,
    blocks: [{ weekdays: [1], start: '09:00', end: '12:00' }, { weekdays: [1], start: '11:00', end: '13:00' }] }) as R;
  assert.deepEqual([clash.sessions, clash.conflicts], [1, ['2026-11-09']]);
  // A bad block says which one.
  const bad = api.gateway.createApptSessions(admin, { clinicCode: EYE, providerCode: 'D005', providerName: 'X', from: '2026-11-09', to: '2026-11-10', minutes: 30, capacity: 1,
    blocks: [{ weekdays: [1], start: '09:00', end: '12:00' }, { weekdays: [2], start: '14:00', end: '13:00' }] }) as R;
  assert.equal(bad.code, 'VALIDATION_ERROR'); assert.match(bad.reason!, /ช่วงที่ 2/);
  assert.equal(api.appts.slots(EYE, '2026-11-09', 'D005').length, 0, 'nothing made when one block is wrong');
});

test('the list of doctors: add, rename (sessions to come follow), switch off (no new sessions), and schedules keep it complete', () => {
  const { api, admin, staff } = setup();
  type P = { code: string; name: string; clinics: string[]; active: boolean; upcoming: number; nextAt?: string };
  const list = () => (api.gateway.apptProviders(staff) as { providers: P[] }).providers;
  // Doctors who got a schedule are in the list, with what is coming.
  const a = list().find((p) => p.code === 'D001')!;
  assert.deepEqual([a.name, a.clinics, a.active, a.upcoming], ['นพ.สมชาย ใจดี', [MED], true, 3]);
  assert.ok(a.nextAt);
  // Add a doctor with no schedule yet.
  assert.equal((api.gateway.setApptProvider(staff, { code: 'D009', name: 'X' }) as R).code, 'FORBIDDEN');
  const added = api.gateway.setApptProvider(admin, { code: 'D009', name: 'พญ.ใหม่ ยังไม่มีตาราง', clinics: [EYE] }) as R & { provider?: P };
  assert.equal(added.ok, true, added.reason);
  assert.deepEqual([added.provider!.clinics, added.provider!.upcoming], [[EYE], 0]);
  assert.equal((api.gateway.setApptProvider(admin, { code: 'bad code', name: 'X' }) as R).code, 'VALIDATION_ERROR');
  assert.equal((api.gateway.setApptProvider(admin, { code: 'D010', name: 'X', clinics: ['nope'] }) as R).code, 'VALIDATION_ERROR');
  // Renamed: the sessions still to come carry the new name.
  api.gateway.setApptProvider(admin, { code: 'D001', name: 'นพ.สมชาย ใจดีมาก' });
  assert.ok(api.appts.slots(MED, '2026-11-03', 'D001').length);
  assert.equal((api.gateway.apptSessions(staff, { clinicCode: MED, date: '2026-11-03' }) as { sessions: { providerName: string; providerCode: string }[] }).sessions.find((s) => s.providerCode === 'D001')!.providerName, 'นพ.สมชาย ใจดีมาก');
  // Switched off: kept, no new sessions.
  api.gateway.setApptProvider(admin, { code: 'D009', name: 'พญ.ใหม่ ยังไม่มีตาราง', active: false });
  assert.equal(list().find((p) => p.code === 'D009')!.active, false);
  const off = api.gateway.createApptSessions(admin, { clinicCode: EYE, providerCode: 'D009', providerName: 'พญ.ใหม่ ยังไม่มีตาราง', from: '2026-11-09', to: '2026-11-09', weekdays: [1], start: '09:00', end: '10:00', minutes: 30, capacity: 1 }) as R;
  assert.equal(off.code, 'POLICY_REJECTED');
  // A schedule in another clinic adds that clinic to the doctor.
  api.gateway.createApptSessions(admin, { clinicCode: EYE, providerCode: 'D002', providerName: 'พญ.สมศรี รักษา', from: '2026-11-09', to: '2026-11-09', weekdays: [1], start: '09:00', end: '10:00', minutes: 30, capacity: 1 });
  assert.deepEqual(list().find((p) => p.code === 'D002')!.clinics, [MED, EYE]);
  // A doctor's sessions to come, every clinic, in time order.
  const ss = (api.gateway.apptProviderSessions(staff, { code: 'D002' }) as { sessions: { clinicCode: string; startsAt: string; capacity: number }[] }).sessions;
  assert.deepEqual(ss.map((x) => x.clinicCode), [MED, EYE]);
  assert.ok(ss[0].startsAt < ss[1].startsAt && ss[0].capacity === 8);
});

test('doctors and their weekly hours come in from a spreadsheet: checked first, then all or nothing', () => {
  const { api, admin, staff } = setup();
  type I = R & { result?: { doctors: number; added: number; sessions: number; slots: number; conflicts: { code: string; day: string }[] } };
  const rows = [
    { code: 'D101', name: 'นพ.หนึ่ง', clinic: MED, weekdays: [1, 2], start: '09:00', end: '12:00' },
    { code: 'D101', name: 'นพ.หนึ่ง', clinic: MED, weekdays: [3], start: '13:00', end: '15:00' },
    { code: 'D102', name: 'พญ.สอง', clinic: EYE, weekdays: [1], start: '09:00', end: '11:00' },
    { code: 'D103', name: 'นพ.สาม (ยังไม่มีตาราง)', clinic: EYE },
  ];
  const opts = { from: '2026-11-09', to: '2026-11-15', minutes: 30, capacity: 2 };
  assert.equal((api.gateway.importAppt(staff, { rows, ...opts }) as R).code, 'FORBIDDEN');
  const dry = api.gateway.importAppt(admin, { rows, ...opts, dryRun: true }) as I;
  assert.equal(dry.ok, true, dry.reason);
  // Mon + Tue mornings (6 slots each) and Wed afternoon (4) for D101; Mon 9–11 (4) for D102.
  assert.deepEqual([dry.result!.doctors, dry.result!.added, dry.result!.sessions, dry.result!.slots], [3, 3, 4, 6 + 6 + 4 + 4]);
  assert.equal((api.gateway.apptProviders(staff) as { providers: { code: string }[] }).providers.some((p) => p.code === 'D101'), false, 'a dry run keeps nothing');
  const real = api.gateway.importAppt(admin, { rows, ...opts }) as I;
  assert.deepEqual([real.result!.sessions, real.result!.slots], [4, 20]);
  const list = (api.gateway.apptProviders(staff) as { providers: { code: string; clinics: string[]; upcoming: number }[] }).providers;
  assert.deepEqual(list.filter((p) => p.code.startsWith('D1')).sort((a, b) => a.code.localeCompare(b.code)).map((p) => [p.code, p.clinics, p.upcoming]), [['D101', [MED], 3], ['D102', [EYE], 1], ['D103', [EYE], 0]]);
  assert.ok(api.audit.list().some((e) => e.action === 'appointment.import'));
  // Again: the same sessions are skipped, nothing doubled.
  const again = api.gateway.importAppt(admin, { rows, ...opts }) as I & { result?: { skipped: number } };
  assert.deepEqual([again.result!.sessions, again.result!.skipped], [0, 4]);
  // One bad row: nothing at all, and it says which.
  const bad = api.gateway.importAppt(admin, { rows: [...rows, { code: 'D104', name: 'X', clinic: 'nope' }], ...opts }) as I;
  assert.equal(bad.code, 'VALIDATION_ERROR'); assert.match(bad.reason!, /แถวที่ 5/);
  const wrongTime = api.gateway.importAppt(admin, { rows: [{ code: 'D105', name: 'Y', clinic: MED, weekdays: [1], start: '12:00', end: '09:00' }], ...opts }) as I;
  assert.match(wrongTime.reason!, /Y \(D105\)/);
  assert.equal((api.gateway.apptProviders(staff) as { providers: { code: string }[] }).providers.some((p) => p.code === 'D105'), false, 'rolled back');
});
