import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localInstant } from '../src/booking.service';
import { ADMIN_PASSWORD, makeApi, signIn } from './helpers';

// How long records are kept (spec §14.3, decision D7): nothing is removed until an administrator sets a period; then
// only finished records older than it go — never a confirmed booking/appointment, an active LINE link, a waiting
// message or today's queue. Expired sessions, retry keys and link codes are always cleaned.
type R = { ok: boolean; code?: string; reason?: string; settings?: Record<string, number>; preview?: Record<string, number>; last?: { removed: Record<string, number> } };
const MED = 'opd-2-0';
let n = 0;
const key = () => `ret-key-${String(++n).padStart(6, '0')}`;
const count = (api: ReturnType<typeof makeApi>, table: string, where = '1') => (api.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

// January: three bookings (one cancelled, one still confirmed, one checked-in-like), an appointment, LINE links,
// messages and an old queue day. Then "now" is moved to October.
function setup() {
  const api = makeApi(), jan = localInstant('2026-01-05', '08:00');
  api.booking.now = () => jan; api.appts.now = () => jan;
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  api.gateway.setFeatures(admin, { patch: { generalBooking: true, appointments: true } });
  api.gateway.setBookingPolicy(admin, { serviceCode: MED, displayName: 'อายุรกรรม', enabled: true, cancelCutoffMinutes: 0, maxActivePerPatient: 5 });
  api.gateway.createBookingSlots(admin, { serviceCode: MED, from: '2026-01-06', to: '2026-01-06', weekdays: [2], start: '09:00', end: '12:00', minutes: 60, capacity: 5 });
  const slots = api.booking.slots(MED, '2026-01-06');
  const book = (hn: string, i: number) => (api.gateway.createBooking(admin, { hn, slotId: slots[i].id, key: key() }) as { booking: { id: string } }).booking.id;
  const cancelled = book('65-000001', 0), confirmed = book('65-000002', 1);
  api.gateway.cancelBooking(admin, { bookingId: cancelled, reason: 'ผู้ป่วยขอยกเลิก' });
  api.gateway.setApptPolicy(admin, { clinicCode: MED, displayName: 'อายุรกรรม', enabled: true, cancelCutoffMinutes: 0 });
  api.gateway.createApptSessions(admin, { clinicCode: MED, providerCode: 'D1', providerName: 'นพ.เอ', from: '2026-01-07', to: '2026-01-07', weekdays: [3], start: '09:00', end: '10:00', minutes: 30, capacity: 2 });
  const appt = (api.gateway.createAppt(admin, { hn: '65-000003', slotId: api.appts.slots(MED, '2026-01-07')[0].id, key: key() }) as { appointment: { id: string } }).appointment.id;
  api.gateway.cancelAppt(admin, { appointmentId: appt, reason: 'ผู้ป่วยขอยกเลิก' });
  // A finished and a current LINE link; messages sent and waiting; a queue day in January and one today.
  const db = api.db.db, old = '2026-01-06T02:00:00.000Z';
  const p1 = api.booking.profileForHN('65-000001'), p4 = api.booking.profileForHN('65-000004');
  db.prepare(`INSERT INTO line_patient_links (id, patient_profile_id, line_subject, status, method, verified_at, ended_at, created_at) VALUES ('l1', ?, 'U1', 'REVOKED', 'STAFF_ASSISTED', ?, ?, ?)`).run(p1, old, old, old);
  db.prepare(`INSERT INTO line_patient_links (id, patient_profile_id, line_subject, status, method, verified_at, created_at) VALUES ('l2', ?, 'U2', 'ACTIVE', 'STAFF_ASSISTED', ?, ?)`).run(p4, old, old);
  for (const [id, status] of [['j1', 'SENT'], ['j2', 'PENDING']])
    db.prepare(`INSERT INTO notification_jobs (id, template, payload_json, target_type, target_id, scheduled_at, status, dedupe_key, created_at, updated_at) VALUES (?, 'T', '{}', 'LINE_USER', 'U9', ?, ?, ?, ?, ?)`).run(id, old, status, id, old, old);
  db.prepare(`INSERT INTO notification_logs (job_id, outcome, created_at) VALUES ('j1', 'SENT', ?)`).run(old);
  const today = new Date().toLocaleDateString('sv-SE');
  for (const day of ['2026-01-06', today]) {
    db.prepare(`INSERT INTO queue_events (day, seq, id, body) VALUES (?, 1, 'e1', '{}')`).run(day);
    db.prepare(`INSERT INTO visits (day, id, queue, flow, dept, arrival, steps_json, created_at) VALUES (?, 'v-0001', 'A001', 'opd', 'อายุรกรรม', 500, '[]', ?)`).run(day, old);
  }
  const oct = localInstant('2026-10-18', '09:00');
  api.retention.now = () => oct;
  return { api, admin, cancelled, confirmed, appt };
}

test('by default nothing is removed — the hospital has not decided yet (D7)', () => {
  const { api } = setup();
  const tables = ['bookings', 'appointments', 'line_patient_links', 'notification_jobs', 'visits', 'queue_events', 'patient_profiles'];
  const before = tables.map((t) => count(api, t)), audit = count(api, 'audit_log');
  const r = api.retention.run();
  // Only housekeeping may run (e.g. a staff session that has expired by the test's "now", depending on the time zone).
  const housekeeping = ['retry keys', 'staff sessions', 'patient sessions', 'link codes', 'LINE codes', 'LINE queue subscriptions', 'queue-slip links'];
  assert.deepEqual(Object.keys(r.removed).filter((k) => !housekeeping.includes(k)), []);
  assert.deepEqual(tables.map((t) => count(api, t)), before);
  assert.ok(count(api, 'audit_log') >= audit, 'the audit trail is never shortened by default');
});

test('once set, only finished records past the period go; confirmed, active, waiting and today stay', () => {
  const { api, admin, cancelled, confirmed } = setup();
  const s = api.gateway.retentionSet(admin, { patch: { bookings: 180, appointments: 180, queue: 90, lineLinks: 180, notifications: 90 } }) as R;
  assert.equal(s.ok, true, s.reason);
  const preview = (api.gateway.retentionGet(admin, {}) as R).preview!;
  assert.deepEqual([preview.bookings, preview.appointments, preview.visits, preview['ended LINE links'], preview.messages], [1, 1, 1, 1, 1], 'a preview counts without removing');
  assert.equal(count(api, 'bookings'), 2);
  const r = api.gateway.retentionRun(admin) as R;
  assert.equal(r.ok, true);
  assert.equal(api.booking.get(cancelled), undefined, 'cancelled booking from January removed');
  assert.equal(api.booking.get(confirmed)?.status, 'CONFIRMED', 'a confirmed booking is never removed');
  assert.equal(count(api, 'booking_slots'), 1, 'only the slot still holding a booking is kept');
  assert.equal(count(api, 'appointments'), 0);
  assert.equal(count(api, 'provider_schedules'), 0, 'the doctor session went with its last slot');
  assert.deepEqual(api.db.db.prepare('SELECT id FROM line_patient_links').all().map((x) => (x as { id: string }).id), ['l2'], 'the active link stays');
  assert.deepEqual(api.db.db.prepare('SELECT id FROM notification_jobs').all().map((x) => (x as { id: string }).id), ['j2'], 'a waiting message stays');
  assert.equal(count(api, 'notification_logs'), 0);
  assert.deepEqual([count(api, 'visits'), count(api, 'queue_events')], [1, 1], "today's queue stays");
  // HN records nothing points to any more are gone; those still used stay.
  const hns = (api.db.db.prepare('SELECT external_patient_id AS hn FROM patient_profiles ORDER BY hn').all() as { hn: string }[]).map((x) => x.hn);
  assert.deepEqual(hns, ['65-000002', '65-000004']);
  assert.ok(api.audit.list().some((e) => e.action === 'retention.purge'), 'the clean-up is in the audit trail (counts only)');
  assert.ok(api.audit.list().some((e) => e.action === 'retention.update'));
});

test('settings: 0 or 30–3650 days, administrators only, and the audit trail outlives the records it describes', () => {
  const { api, admin } = setup();
  api.gateway.saveUser(admin, { username: 'head.b', name: 'B', role: 'supervisor', password: 'password-2' });
  const head = signIn(api, 'head.b', 'password-2');
  assert.equal((api.gateway.retentionSet(head, { patch: { bookings: 90 } }) as R).code, 'FORBIDDEN');
  assert.equal((api.gateway.retentionGet(head, {}) as R).code, 'FORBIDDEN');
  assert.equal((api.gateway.retentionSet(admin, { patch: { bookings: 7 } }) as R).code, 'VALIDATION_ERROR');
  assert.equal((api.gateway.retentionSet(admin, { patch: { visits: 90 } }) as R).code, 'VALIDATION_ERROR');
  assert.equal((api.gateway.retentionSet(admin, { patch: { bookings: 400, audit: 365 } }) as R).code, 'POLICY_REJECTED');
  assert.equal((api.gateway.retentionSet(admin, { patch: { bookings: 365, audit: 730 } }) as R).ok, true);
  assert.equal((api.gateway.retentionSet(admin, { patch: { appointments: 800 } }) as R).code, 'POLICY_REJECTED');
  // A preview of other settings, without saving them.
  const p = api.gateway.retentionGet(admin, { proposed: { bookings: 90 } }) as R;
  assert.equal(p.preview!.bookings, 1);
  assert.equal(p.settings!.bookings, 365);
});

test('housekeeping always runs: expired sessions, old retry keys and link codes', () => {
  const { api } = setup();
  const db = api.db.db, long = '2025-01-01T00:00:00.000Z';
  db.prepare(`INSERT INTO patient_sessions (token_hash, line_subject, created_at, expires_at) VALUES ('h1', 'U1', ?, ?)`).run(long, long);
  db.prepare(`INSERT INTO idempotency_keys (scope, key, request_hash, result_json, created_at) VALUES ('s', 'k', 'h', 'null', ?)`).run(long);
  db.prepare(`INSERT INTO link_requests (id, line_subject, token_hash, short_code, expires_at, created_at) VALUES ('r1', 'U1', 'th', 'ABCD2345', ?, ?)`).run(long, long);
  const r = api.retention.run();
  assert.deepEqual([r.removed['patient sessions'], r.removed['retry keys'], r.removed['link codes']], [1, 1, 1]);
  assert.equal(count(api, 'idempotency_keys', `created_at = '${long}'`), 0);
});
