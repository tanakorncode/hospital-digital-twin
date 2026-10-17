import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DbService } from '../src/db.service';
import { AppError } from '../src/errors';
import { canonical, requestHash } from '../src/idempotency.service';
import { MIGRATIONS } from '../src/migrations';
import { ADMIN_PASSWORD, fakeSocket, makeApi, signIn } from './helpers';

type R = { ok: boolean; code?: string; reason?: string };
const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AppError).code; } return undefined; };

// ---- migrations ------------------------------------------------------------------------------------------------
test('migrations run once, in order, and leave the Phase 1 tables alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hdt-')), file = join(dir, 'h.db');
  try {
    process.env.DB_PATH = file;
    const a = new DbService();
    assert.equal(a.schemaVersion(), MIGRATIONS.at(-1)!.version);
    a.db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('x', '1', 'now')").run();
    a.db.close();
    const b = new DbService(); // restart on the same file
    assert.equal((b.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n, MIGRATIONS.length, 'nothing applied twice');
    assert.equal(b.getKv('x'), 1, 'existing data kept');
    b.migrate([...MIGRATIONS, { version: 99, name: 'later', sql: 'CREATE TABLE later_t (id INTEGER)' }]);
    assert.equal(b.schemaVersion(), 99, 'a later migration is applied on its own');
    b.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failing migration is rolled back and not recorded', () => {
  const { db } = makeApi();
  assert.throws(() => db.migrate([{ version: 50, name: 'broken', sql: 'CREATE TABLE half_done (id INTEGER); CREATE TABLE oops (' }]));
  assert.equal(db.schemaVersion(), MIGRATIONS.at(-1)!.version);
  assert.equal(db.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'half_done'").get(), undefined, 'no half-applied change');
});

// ---- transactions -----------------------------------------------------------------------------------------------
test('tx saves everything or nothing; nested calls join; async work is refused', () => {
  const { db } = makeApi();
  db.db.exec('CREATE TABLE t (n INTEGER)');
  db.tx(() => { db.db.exec('INSERT INTO t VALUES (1)'); db.tx(() => db.db.exec('INSERT INTO t VALUES (2)')); });
  assert.throws(() => db.tx(() => { db.db.exec('INSERT INTO t VALUES (3)'); throw new Error('stop'); }), /stop/);
  assert.throws(() => db.tx(() => { db.db.exec('INSERT INTO t VALUES (4)'); return Promise.resolve(); }), /synchronous/);
  assert.deepEqual((db.db.prepare('SELECT n FROM t ORDER BY n').all() as { n: number }[]).map((r) => r.n), [1, 2]);
  assert.equal(db.db.isTransaction, false);
});

test('a capacity check under tx never over-fills, even from a second connection to the same file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hdt-')), file = join(dir, 'h.db');
  try {
    process.env.DB_PATH = file;
    const a = new DbService(), b = new DbService();
    a.db.exec('CREATE TABLE slot (id TEXT PRIMARY KEY, capacity INTEGER, reserved INTEGER CHECK (reserved <= capacity))');
    a.db.exec("INSERT INTO slot VALUES ('s1', 2, 0)");
    const reserve = (db: DbService) => db.tx(() => {
      if (db.db.prepare("UPDATE slot SET reserved = reserved + 1 WHERE id = 's1' AND reserved < capacity").run().changes !== 1) throw new AppError('SLOT_FULL_OR_CLOSED', 'เต็ม');
    });
    const results = [a, b, a, b, a].map((db) => codeOf(() => reserve(db)) ?? 'ok');
    assert.deepEqual(results.filter((r) => r === 'ok').length, 2, 'never more than the capacity');
    assert.ok(results.every((r) => r === 'ok' || r === 'SLOT_FULL_OR_CLOSED'));
    // While one connection holds the write lock, the other cannot start its own write.
    b.db.exec('PRAGMA busy_timeout = 50');
    a.db.exec('BEGIN IMMEDIATE');
    assert.throws(() => b.tx(() => b.db.exec("UPDATE slot SET reserved = 0")), /locked|busy/i);
    a.db.exec('ROLLBACK');
    assert.equal((a.db.prepare("SELECT reserved FROM slot WHERE id = 's1'").get() as { reserved: number }).reserved, 2);
    a.db.close(); b.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- idempotency ------------------------------------------------------------------------------------------------
test('same key + same request returns the first result without acting again', () => {
  const { idempotency } = makeApi();
  let runs = 0;
  const first = idempotency.run('booking:create:p1', 'key-aaaa-0001', { slotId: 's1', note: 'x' }, () => ({ id: ++runs }));
  const again = idempotency.run('booking:create:p1', 'key-aaaa-0001', { note: 'x', slotId: 's1' }, () => ({ id: ++runs }));
  assert.deepEqual(first, { result: { id: 1 }, replayed: false });
  assert.deepEqual(again, { result: { id: 1 }, replayed: true }, 'key order in the request does not matter');
  assert.equal(runs, 1);
});

test('same key + a different request is a conflict; keys are scoped; failures are not stored', () => {
  const { idempotency } = makeApi();
  idempotency.run('s:p1', 'key-bbbb-0001', { slotId: 's1' }, () => 'done');
  assert.equal(codeOf(() => idempotency.run('s:p1', 'key-bbbb-0001', { slotId: 's2' }, () => 'other')), 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(idempotency.run('s:p2', 'key-bbbb-0001', { slotId: 's2' }, () => 'p2').result, 'p2', 'another caller\'s scope is separate');
  assert.equal(codeOf(() => idempotency.run('s:p1', 'short', {}, () => 1)), 'VALIDATION_ERROR');
  assert.throws(() => idempotency.run('s:p1', 'key-cccc-0001', {}, () => { throw new AppError('SLOT_FULL_OR_CLOSED', 'เต็ม'); }));
  assert.equal(idempotency.run('s:p1', 'key-cccc-0001', {}, () => 'retried').replayed, false, 'a failed attempt can be retried with the same key');
});

test('canonical form and old keys', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
  assert.equal(requestHash({ a: 1, b: 2 }), requestHash({ b: 2, a: 1 }));
  const { idempotency, db } = makeApi();
  idempotency.run('s', 'key-old-00001', {}, () => 1);
  db.db.prepare("UPDATE idempotency_keys SET created_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal(idempotency.purge(), 1);
});

// ---- audit ------------------------------------------------------------------------------------------------------
test('the audit trail never stores secrets or patient identifiers passed by mistake', () => {
  const { audit } = makeApi();
  audit.record({ actorType: 'system', action: 'x', meta: { password: 'p', token: 't', hn: '1', patientName: 'n', phone: '0', count: 3 } });
  assert.deepEqual(audit.list()[0].meta, { count: 3 });
});

test('account changes, settings changes and re-issued slips are audited with an opaque actor', () => {
  const api = makeApi();
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  const made = api.gateway.saveUser(admin, { username: 'staff.a', name: 'A', role: 'staff', password: 'password-1' }) as { user: { id: number } };
  api.gateway.saveUser(admin, { id: made.user.id, password: 'password-2' });
  api.gateway.queueSettings(admin, { patch: { system: { cap: 15 } }, at: 600, scope: 'system', summary: 'เพดาน 15' });
  api.gateway.issueTicket(admin, { patientId: 'p-0001' });
  api.gateway.issueTicket(admin, { patientId: 'p-0001', renew: true });
  const log = api.audit.list();
  assert.deepEqual(log.map((e) => e.action), ['ticket.renew', 'settings.update', 'user.update', 'user.create'], 'the plain re-show of a slip is not logged');
  assert.ok(log.every((e) => e.actorType === 'staff' && /^user:\d+$/.test(e.actorId!)));
  assert.equal(log[2].meta?.signInReset, true);
  assert.ok(!JSON.stringify(log).includes('password-'), 'no password in the trail');
});

// ---- feature switches & error codes -------------------------------------------------------------------------------
test('Phase 2 switches start off, only administrators change them, and every change is audited and broadcast', () => {
  const api = makeApi();
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  const hello = (admin as unknown as { sent: { event: string; data: { line: boolean; phase2: Record<string, boolean> } }[] }).sent.find((e) => e.event === 'features')!;
  assert.equal(hello.data.line, false);
  assert.ok(Object.values(hello.data.phase2).every((v) => v === false), 'all off on a fresh install');
  assert.equal(codeOf(() => api.features.require('generalBooking')), 'FEATURE_DISABLED');

  api.gateway.saveUser(admin, { username: 'head.b', name: 'B', role: 'supervisor', password: 'password-1' });
  const head = signIn(api, 'head.b', 'password-1');
  assert.equal((api.gateway.setFeatures(head, { patch: { generalBooking: true } }) as R).code, 'FORBIDDEN');
  assert.equal((api.gateway.setFeatures(fakeSocket(), { patch: { generalBooking: true } }) as R).code, 'AUTH_REQUIRED');
  assert.equal((api.gateway.setFeatures(admin, { patch: { everything: true } }) as R).code, 'VALIDATION_ERROR');
  assert.equal((api.gateway.setFeatures(admin, { patch: { generalBooking: 'yes' } }) as R).code, 'VALIDATION_ERROR');

  assert.equal((api.gateway.setFeatures(admin, { patch: { generalBooking: true, wayfinding: false } }) as R).ok, true);
  assert.equal(api.features.on('generalBooking'), true);
  assert.doesNotThrow(() => api.features.require('generalBooking'));
  assert.deepEqual(api.audit.list({ targetType: 'feature' }).map((e) => [e.action, e.targetId]), [['feature.enable', 'generalBooking']], 'unchanged switches are not logged');
  assert.ok(api.emitted.some((e) => e.event === 'features'));
  assert.equal((api.gateway.auditList(head, {}) as R).code, 'FORBIDDEN');
  assert.ok((api.gateway.auditList(admin, { targetType: 'feature' }) as { entries: unknown[] }).entries.length === 1);
});

test('Phase 1 refusals keep their Thai reason and now carry a stable code', () => {
  const api = makeApi();
  const r = api.gateway.queueCommand(fakeSocket(), { at: 600, station: 'room:opd-201', action: 'call', patientId: 'p-0001', step: 3 }) as R & { auth?: boolean };
  assert.equal(r.code, 'AUTH_REQUIRED');
  assert.equal(r.auth, true);
  assert.equal(r.reason, 'กรุณาเข้าสู่ระบบก่อน');
});
