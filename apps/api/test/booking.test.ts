import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { BookingService, localInstant, type Booking, type Slot } from '../src/booking.service';
import { DbService } from '../src/db.service';
import type { AppError } from '../src/errors';
import { ADMIN_PASSWORD, fakeSocket, makeApi, signIn } from './helpers';

type R = { ok: boolean; code?: string; reason?: string; booking?: Booking; slots?: Slot[]; bookings?: Booking[]; created?: number; skipped?: number };
// The hospital's "now" for these tests: Monday 2 Nov 2026, 08:00 local time.
const NOW = localInstant('2026-11-02', '08:00');
const MED = 'opd-2-0', EYE = 'opd-4-1';
let n = 0;
const key = () => `book-key-${String(++n).padStart(6, '0')}`;
const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AppError).code; } return undefined; };

function setup(opts: { capacity?: number; cutoff?: number; max?: number; advance?: number } = {}) {
  const api = makeApi();
  api.booking.now = () => NOW;
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  api.gateway.setFeatures(admin, { patch: { generalBooking: true } });
  for (const [code, name] of [[MED, 'อายุรกรรมทั่วไป'], [EYE, 'ตา']])
    assert.equal((api.gateway.setBookingPolicy(admin, { serviceCode: code, displayName: name, enabled: true, cancelCutoffMinutes: opts.cutoff ?? 60, maxActivePerPatient: opts.max ?? 1, advanceDays: opts.advance ?? 14 }) as R).ok, true);
  for (const code of [MED, EYE])
    api.gateway.createBookingSlots(admin, { serviceCode: code, from: '2026-11-02', to: '2026-11-06', weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '12:00', minutes: 60, capacity: opts.capacity ?? 2 });
  api.gateway.saveUser(admin, { username: 'staff.a', name: 'A', role: 'staff', password: 'password-1' });
  api.gateway.saveUser(admin, { username: 'head.b', name: 'B', role: 'supervisor', password: 'password-2' });
  const staff = signIn(api, 'staff.a', 'password-1'), head = signIn(api, 'head.b', 'password-2');
  const slot = (code: string, date: string, time: string) => (api.gateway.bookingSlots(staff, { serviceCode: code, date }) as R).slots!.find((s) => s.startsAt === localInstant(date, time).toISOString())!;
  const book = (hn: string, slotId: string, k = key()) => api.gateway.createBooking(staff, { hn, slotId, key: k }) as R;
  return { api, admin, staff, head, slot, book };
}

// ---- rules and slots ----------------------------------------------------------------------------------------------
test('administrators set the rules and make slots; making them twice is harmless', () => {
  const { api, admin, staff } = setup();
  assert.equal((api.gateway.setBookingPolicy(staff, { serviceCode: MED, enabled: false }) as R).code, 'FORBIDDEN');
  assert.equal((api.gateway.setBookingPolicy(admin, { serviceCode: MED, advanceDays: 999 }) as R).code, 'VALIDATION_ERROR');
  const p = (api.gateway.setBookingPolicy(admin, { serviceCode: MED, cancelCutoffMinutes: 120 }) as { policy: { version: number; cancelCutoffMinutes: number; displayName: string } }).policy;
  assert.equal(p.version, 2, 'every change is a new version');
  assert.equal(p.displayName, 'อายุรกรรมทั่วไป', 'unchanged fields are kept');
  const again = api.gateway.createBookingSlots(admin, { serviceCode: MED, from: '2026-11-02', to: '2026-11-08', weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '12:00', minutes: 60, capacity: 2 }) as R;
  assert.deepEqual([again.created, again.skipped], [0, 15], 'Mon–Fri × 3 slots already there; the weekend is not a working day');
  assert.equal((api.gateway.createBookingSlots(admin, { serviceCode: 'opd-3-0', from: '2026-11-02', to: '2026-11-02', weekdays: [1], start: '09:00', end: '10:00', minutes: 60, capacity: 1 }) as R).code, 'VALIDATION_ERROR', 'no rules for that service yet');
  assert.equal((api.gateway.bookingSlots(staff, { serviceCode: MED, date: '2026-11-03' }) as R).slots!.length, 3);
  assert.deepEqual(api.audit.list({ targetType: 'booking-policy', targetId: MED }).map((e) => e.action).slice(0, 2), ['booking.slots.create', 'booking.policy']);
});

// ---- booking --------------------------------------------------------------------------------------------------
test('staff book for a patient by HN: a short code, a place taken, the HN masked', () => {
  const { api, slot, book } = setup();
  const s = slot(MED, '2026-11-03', '09:00');
  const r = book('65-123456', s.id);
  assert.equal(r.ok, true);
  assert.match(r.booking!.code, /^BK[A-Z0-9]{6}$/);
  assert.equal(r.booking!.status, 'CONFIRMED');
  assert.equal(r.booking!.hn, '••3456');
  assert.equal(slot(MED, '2026-11-03', '09:00').reserved, 1);
  const again = book('65-123456', slot(EYE, '2026-11-03', '09:00').id);
  assert.equal(again.ok, true, 'another service is a separate quota');
  assert.equal((api.db.db.prepare('SELECT COUNT(*) AS n FROM patient_profiles').get() as { n: number }).n, 1, 'one profile per HN');
});

test('booking needs the switch on and the service open', () => {
  const { api, admin, slot, book } = setup();
  const s = slot(MED, '2026-11-03', '09:00');
  api.gateway.setFeatures(admin, { patch: { generalBooking: false } });
  assert.equal(book('65-1', s.id).code, 'FEATURE_DISABLED');
  api.gateway.setFeatures(admin, { patch: { generalBooking: true } });
  api.gateway.setBookingPolicy(admin, { serviceCode: MED, enabled: false });
  assert.equal(book('65-1', s.id).code, 'POLICY_REJECTED');
  assert.equal((api.gateway.createBooking(fakeSocket(), { hn: '65-1', slotId: s.id, key: key() }) as R).code, 'AUTH_REQUIRED');
});

test('a retried tap returns the same booking and takes one place only', () => {
  const { slot, book } = setup();
  const s = slot(MED, '2026-11-03', '10:00'), k = key();
  const a = book('65-777', s.id, k), b = book('65-777', s.id, k);
  assert.equal(a.booking!.id, b.booking!.id);
  assert.equal(slot(MED, '2026-11-03', '10:00').reserved, 1);
  assert.equal(book('65-888', s.id, k).code, 'IDEMPOTENCY_KEY_REUSED');
});

test('a slot never takes more than its capacity, and one patient one active booking per service', () => {
  const { slot, book } = setup({ capacity: 2 });
  const s = slot(MED, '2026-11-04', '09:00');
  assert.equal(book('65-1', s.id).ok, true);
  assert.equal(book('65-2', s.id).ok, true);
  assert.equal(book('65-3', s.id).code, 'SLOT_FULL_OR_CLOSED');
  assert.equal(slot(MED, '2026-11-04', '09:00').remaining, 0);
  assert.equal(book('65-1', slot(MED, '2026-11-05', '09:00').id).code, 'POLICY_REJECTED', 'already has an active booking for this service');
});

test('slots that have started, or are beyond the booking window, cannot be booked', () => {
  const { api, admin, slot, book } = setup({ advance: 1 });
  api.booking.now = () => localInstant('2026-11-03', '09:30');
  assert.equal(book('65-1', slot(MED, '2026-11-03', '09:00').id).code, 'POLICY_REJECTED', 'started');
  assert.equal(book('65-1', slot(MED, '2026-11-05', '09:00').id).code, 'POLICY_REJECTED', 'two days ahead, window is one');
  assert.equal(book('65-1', slot(MED, '2026-11-04', '11:00').id).ok, true);
  assert.deepEqual(api.booking.bookable(MED, '2026-11-03').map((s) => new Date(s.startsAt).getHours()), [10, 11], 'only what can still be booked');
  assert.deepEqual(api.booking.bookable(MED, '2026-11-05'), []);
  void admin;
});

// ---- concurrency: real threads, real database file -------------------------------------------------------------
test('ten people racing for the last three places: exactly three get one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hdt-book-')), file = join(dir, 'h.db');
  try {
    process.env.DB_PATH = file;
    const db = new DbService(), booking = new BookingService(db);
    booking.now = () => NOW;
    booking.setPolicy({ serviceCode: MED, displayName: 'อายุรกรรมทั่วไป', enabled: true, maxActivePerPatient: 1 }, 'test');
    booking.createSlots({ serviceCode: MED, from: '2026-11-03', to: '2026-11-03', weekdays: [2], start: '09:00', end: '10:00', minutes: 60, capacity: 3 });
    const slotId = booking.slots(MED, '2026-11-03')[0].id;
    db.db.close();
    const go = new Int32Array(new SharedArrayBuffer(4));
    // Each thread loads the TypeScript fixture through tsx, like the test runner does.
    const boot = `require(${JSON.stringify(require.resolve('tsx/cjs/api'))}).register(); require(${JSON.stringify(join(__dirname, 'fixtures', 'book-worker.ts'))});`;
    const workers = Array.from({ length: 10 }, (_, i) => new Worker(boot, { eval: true, workerData: { file, slotId, hn: `65-${1000 + i}`, now: NOW.toISOString(), go } }));
    const results = workers.map((w) => new Promise<string>((res, rej) => { w.once('message', res); w.once('error', rej); }));
    await new Promise((r) => setTimeout(r, 1500)); // let every thread open the database and wait at the start line
    Atomics.store(go, 0, 1); Atomics.notify(go, 0);
    const out = await Promise.all(results);
    assert.equal(out.filter((x) => x === 'ok').length, 3, out.join(','));
    assert.ok(out.every((x) => x === 'ok' || x === 'SLOT_FULL_OR_CLOSED'), out.join(','));
    const check = new DatabaseCheck(file);
    assert.deepEqual(check.counts(slotId), { reserved: 3, bookings: 3 });
    check.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
class DatabaseCheck {
  private db: DbService;
  constructor(file: string) { process.env.DB_PATH = file; this.db = new DbService(); }
  counts(slotId: string) {
    return { reserved: (this.db.db.prepare('SELECT reserved_count AS n FROM booking_slots WHERE id = ?').get(slotId) as { n: number }).n,
      bookings: (this.db.db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE slot_id = ? AND status = 'CONFIRMED'").get(slotId) as { n: number }).n };
  }
  close() { this.db.db.close(); }
}

// ---- cancelling ---------------------------------------------------------------------------------------------------
test('cancelling needs a reason, gives the place back once, and repeating it changes nothing', () => {
  const { api, staff, slot, book } = setup({ capacity: 1 });
  const s = slot(MED, '2026-11-03', '09:00'), b = book('65-1', s.id).booking!;
  assert.equal((api.gateway.cancelBooking(staff, { bookingId: b.id }) as R).code, 'VALIDATION_ERROR');
  assert.equal((api.gateway.cancelBooking(staff, { bookingId: b.id, reason: 'ผู้ป่วยขอยกเลิก' }) as R).booking!.status, 'CANCELLED');
  assert.equal(slot(MED, '2026-11-03', '09:00').reserved, 0);
  assert.equal((api.gateway.cancelBooking(staff, { bookingId: b.id, reason: 'ซ้ำ' }) as R).ok, true);
  assert.equal(slot(MED, '2026-11-03', '09:00').reserved, 0, 'not released twice');
  assert.equal(api.audit.list({ targetType: 'booking', targetId: b.id }).filter((e) => e.action === 'booking.cancel').length, 1);
  assert.equal(book('65-2', s.id).ok, true, 'the freed place can be booked again');
  assert.equal(book('65-1', slot(MED, '2026-11-04', '09:00').id).ok, true, 'a cancelled booking no longer counts as active');
});

test('after the cut-off only a supervisor with overrides switched on can cancel', () => {
  const { api, admin, staff, head, slot, book } = setup({ cutoff: 120 });
  const b = book('65-1', slot(MED, '2026-11-02', '09:00').id).booking!; // starts in 1 h, cut-off is 2 h
  assert.equal((api.gateway.cancelBooking(staff, { bookingId: b.id, reason: 'ขอยกเลิก' }) as R).code, 'POLICY_REJECTED');
  assert.equal((api.gateway.cancelBooking(head, { bookingId: b.id, reason: 'ขอยกเลิก' }) as R).code, 'POLICY_REJECTED', 'overrides are off');
  api.gateway.setFeatures(admin, { patch: { staffOverrides: true } });
  assert.equal((api.gateway.cancelBooking(head, { bookingId: b.id, reason: 'ผู้ป่วยป่วยกะทันหัน' }) as R).ok, true);
  assert.equal(api.audit.list({ targetType: 'booking', targetId: b.id })[0].meta?.override, true);
});

test('patients can only cancel their own bookings (checked on the server, not by the screen)', () => {
  const { api, slot, book } = setup();
  const b = book('65-1', slot(MED, '2026-11-03', '09:00').id).booking!;
  const other = api.booking.profileForHN('65-2');
  assert.equal(codeOf(() => api.booking.cancel(b.id, 'x', { kind: 'patient', profileId: other })), 'RESOURCE_NOT_FOUND', 'looks like "no such booking" — reveals nothing');
  const owner = api.booking.profileForHN('65-1');
  assert.equal(api.booking.cancel(b.id, 'ไม่สะดวก', { kind: 'patient', profileId: owner }).booking.status, 'CANCELLED');
});

// ---- slot changes -------------------------------------------------------------------------------------------------
test('closing a slot stops new bookings; cancelling it cancels its bookings; places cannot drop below those booked', () => {
  const { api, admin, staff, slot, book } = setup({ capacity: 3 });
  const s = slot(MED, '2026-11-03', '09:00');
  book('65-1', s.id); book('65-2', s.id);
  assert.equal((api.gateway.setBookingSlot(admin, { slotId: s.id, capacity: 1 }) as R).code, 'POLICY_REJECTED');
  assert.equal((api.gateway.setBookingSlot(staff, { slotId: s.id, status: 'CLOSED' }) as R).code, 'FORBIDDEN');
  api.gateway.setBookingSlot(admin, { slotId: s.id, status: 'CLOSED' });
  assert.equal(book('65-3', s.id).code, 'SLOT_FULL_OR_CLOSED');
  assert.equal((api.gateway.setBookingSlot(admin, { slotId: s.id, status: 'CANCELLED' }) as R).code, 'VALIDATION_ERROR', 'needs a reason');
  const r = api.gateway.setBookingSlot(admin, { slotId: s.id, status: 'CANCELLED', reason: 'แพทย์ติดประชุม' }) as R & { cancelled: number };
  assert.equal(r.cancelled, 2);
  assert.ok((api.gateway.listBookings(staff, { date: '2026-11-03' }) as R).bookings!.every((b) => b.status === 'CANCELLED' && b.cancellationReason === 'แพทย์ติดประชุม'));
  assert.equal(slot(MED, '2026-11-03', '09:00').reserved, 0);
});

test('bookings from past days that nobody checked in for expire', () => {
  const { api, slot, book } = setup();
  const b = book('65-1', slot(MED, '2026-11-03', '09:00').id).booking!;
  api.booking.now = () => localInstant('2026-11-04', '07:00');
  assert.equal(api.booking.expire(), 1);
  assert.equal(api.booking.get(b.id)!.status, 'EXPIRED');
  assert.equal(codeOf(() => api.booking.cancel(b.id, 'x', { kind: 'staff', id: 1, name: 'x', canOverride: true })), 'INVALID_STATE_TRANSITION');
});

// ---- finding bookings -----------------------------------------------------------------------------------------------
test('staff find bookings by day, by code or by HN; an HN search is audited without the HN', () => {
  const { api, staff, slot, book } = setup();
  const b = book('65-424242', slot(MED, '2026-11-03', '09:00').id).booking!;
  book('65-1', slot(EYE, '2026-11-03', '10:00').id);
  assert.equal((api.gateway.listBookings(staff, { date: '2026-11-03' }) as R).bookings!.length, 2);
  assert.equal((api.gateway.listBookings(staff, { date: '2026-11-03', serviceCode: EYE }) as R).bookings!.length, 1);
  assert.equal((api.gateway.listBookings(staff, { code: b.code.toLowerCase() }) as R).bookings![0].id, b.id);
  assert.equal((api.gateway.listBookings(staff, { hn: '65-424242' }) as R).bookings!.length, 1);
  const trail = api.audit.list({ targetType: 'patient-search' });
  assert.equal(trail.length, 1);
  assert.ok(!JSON.stringify(trail).includes('424242'));
  assert.equal((api.gateway.listBookings(fakeSocket(), { date: '2026-11-03' }) as R).code, 'AUTH_REQUIRED');
  assert.ok(api.emitted.some((e) => e.event === 'booking:changed' && e.to === 'staff'), 'screens refresh; nothing goes to public screens');
  assert.ok(!api.emitted.some((e) => e.event === 'booking:changed' && !e.to));
});
