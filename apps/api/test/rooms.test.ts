import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Appointment, Session } from '../src/appointment.service';
import { localInstant } from '../src/booking.service';
import type { Visit } from '../src/visits.service';
import { ADMIN_PASSWORD, makeApi, signIn } from './helpers';

// Doctor ↔ room: a doctor's session can name the exam room. A patient checked in for that doctor's appointment waits
// for that room (not the next free room of the clinic). If the doctor works in another room today, the session's
// room is changed and the patients already waiting move with the doctor.
type R = { ok: boolean; code?: string; reason?: string; session?: Session; sessions?: Session[]; appointment?: Appointment; visit?: Visit; movedVisits?: number };
const MED = 'opd-2-0', EYE = 'opd-4-1';
let n = 0;
const key = () => `room-key-${String(++n).padStart(6, '0')}`;

function setup() {
  const api = makeApi(), now = localInstant('2026-11-03', '08:30');
  api.booking.now = () => now; api.appts.now = () => now;
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  api.gateway.setFeatures(admin, { patch: { appointments: true } });
  api.gateway.queueSettings(admin, { patch: { dataMode: 'live' }, at: 400, scope: 'system', summary: 'live' });
  for (const [c, l] of [[MED, 'A'], [EYE, 'H']]) api.gateway.setApptPolicy(admin, { clinicCode: c, displayName: c, enabled: true, queuePrefix: l });
  const made = api.gateway.createApptSessions(admin, { clinicCode: MED, providerCode: 'D1', providerName: 'นพ.เอ', from: '2026-11-03', to: '2026-11-03', weekdays: [2], start: '09:00', end: '10:00', minutes: 30, capacity: 2, roomId: 'opd-203' }) as R & { sessions: number };
  assert.equal(made.sessions, 1);
  api.gateway.createApptSessions(admin, { clinicCode: MED, providerCode: 'D2', providerName: 'พญ.บี', from: '2026-11-03', to: '2026-11-03', weekdays: [2], start: '09:00', end: '10:00', minutes: 30, capacity: 2 });
  const slotOf = (doc: string) => api.appts.slots(MED, '2026-11-03', doc)[0].id;
  const book = (hn: string, doc: string) => (api.gateway.createAppt(admin, { hn, slotId: slotOf(doc), key: key() }) as R).appointment!;
  return { api, admin, book, session: () => (api.gateway.apptSessions(admin, { clinicCode: MED, date: '2026-11-03' }) as R).sessions!.find((s) => s.providerCode === 'D1')! };
}

test('a session keeps its room; the appointment and the visit from its check-in carry it', () => {
  const { api, admin, book, session } = setup();
  assert.equal(session().roomId, 'opd-203');
  const a = book('65-000001', 'D1'), b = book('65-000002', 'D2');
  assert.equal(a.roomId, 'opd-203');
  assert.equal(b.roomId, undefined, 'a session without a room: the clinic\'s next free room, as before');
  const va = (api.gateway.checkInCode(admin, { code: a.code, at: 520 }) as R).visit!, vb = (api.gateway.checkInCode(admin, { code: b.code, at: 521 }) as R).visit!;
  assert.equal(va.examRoom, 'opd-203');
  assert.equal(vb.examRoom, undefined);
  assert.equal((api.gateway.createApptSessions(admin, { clinicCode: EYE, providerCode: 'D3', providerName: 'x', from: '2026-11-04', to: '2026-11-04', weekdays: [3], start: '09:00', end: '10:00', minutes: 30, capacity: 2, roomId: 'pharmacy' }) as R).code, 'VALIDATION_ERROR');
});

test('the doctor moves room today: the session changes and the waiting patients move with the doctor', () => {
  const { api, admin, book, session } = setup();
  const a = book('65-000001', 'D1');
  const v = (api.gateway.checkInCode(admin, { code: a.code, at: 520 }) as R).visit!;
  api.emitted.length = 0;
  const r = api.gateway.setApptSession(admin, { sessionId: session().id, roomId: 'opd-207' }) as R;
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.movedVisits, 1);
  assert.equal(api.visits.get(v.id)!.examRoom, 'opd-207');
  assert.ok(api.emitted.some((e) => e.event === 'visit' && (e.data as Visit).examRoom === 'opd-207'), 'screens hear about it');
  assert.equal(session().status, 'OPEN', 'the status is untouched');
  assert.equal((api.gateway.setApptSession(admin, { sessionId: session().id, roomId: '' }) as R).session!.roomId, undefined, "'' = no room");
  assert.equal(api.visits.get(v.id)!.examRoom, undefined);
  assert.equal((api.gateway.setApptSession(admin, { sessionId: session().id }) as R).code, 'VALIDATION_ERROR', 'nothing to change');
});

test('supervisors of the clinic may change the room, not the status; staff neither', () => {
  const { api, admin, session } = setup();
  api.gateway.saveUser(admin, { username: 'med.head', name: 'หัวหน้าอายุรกรรม', role: 'supervisor', password: 'password-1', clinics: [MED] });
  api.gateway.saveUser(admin, { username: 'eye.head', name: 'หัวหน้าตา', role: 'supervisor', password: 'password-2', clinics: [EYE] });
  api.gateway.saveUser(admin, { username: 'staff.a', name: 'A', role: 'staff', password: 'password-3' });
  const med = signIn(api, 'med.head', 'password-1'), eye = signIn(api, 'eye.head', 'password-2'), staff = signIn(api, 'staff.a', 'password-3');
  assert.equal((api.gateway.setApptSession(med, { sessionId: session().id, roomId: 'opd-204' }) as R).ok, true);
  assert.equal((api.gateway.setApptSession(med, { sessionId: session().id, status: 'CLOSED' }) as R).code, 'FORBIDDEN');
  assert.equal((api.gateway.setApptSession(eye, { sessionId: session().id, roomId: 'opd-205' }) as R).code, 'FORBIDDEN', 'another clinic');
  assert.equal((api.gateway.setApptSession(staff, { sessionId: session().id, roomId: 'opd-205' }) as R).code, 'FORBIDDEN');
  assert.equal(session().roomId, 'opd-204');
  assert.ok(api.audit.list().some((e) => e.action === 'appointment.session.update' && (e.meta as { room?: string })?.room === 'opd-204'));
});
