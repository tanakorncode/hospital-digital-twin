import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DbService } from '../src/db.service';
import { QueueService } from '../src/queue.service';
import { ADMIN_PASSWORD, fakeSocket, makeApi, signIn } from './helpers';

const call = { at: 600, station: 'room:opd-201', action: 'call' as const, patientId: 'p-0001', step: 3 };

test('queue actions need a signed-in user, and the log names that user', () => {
  const api = makeApi();
  assert.deepEqual((api.gateway.queueCommand(fakeSocket(), call) as { auth?: boolean }).auth, true);
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  assert.equal((api.gateway.queueCommand(admin, { ...call, by: 'ชื่อปลอม' }) as { ok: boolean }).ok, true);
  const last = api.queue.list().at(-1)!;
  assert.equal(last.by, 'ผู้ดูแลระบบ', 'the typed name is replaced by the account name');
  assert.ok(api.emitted.some((e) => e.event === 'queue:event'), 'accepted actions are broadcast');
});

test('two stations cannot call the same patient at once; finished steps cannot be called again', () => {
  const api = makeApi();
  assert.ok(api.queue.apply(call).ok);
  assert.equal(api.queue.apply({ ...call, station: 'room:opd-202' }).ok, false);
  api.queue.apply({ ...call, action: 'start' });
  api.queue.apply({ ...call, action: 'done' });
  assert.equal(api.queue.apply(call).ok, false);
});

test('commands are validated', () => {
  const api = makeApi();
  assert.equal(api.queue.apply({ ...call, action: 'explode' as never }).ok, false);
  assert.equal(api.queue.apply({ at: 600, station: 'x', action: 'call' }).ok, false, 'needs a patient');
  assert.equal(api.queue.apply({ ...call, action: 'transfer' }).ok, false, 'needs a target');
  assert.equal(api.queue.apply({ ...call, key: 'k1' }).ok, true);
  assert.equal(api.queue.apply({ ...call, station: 'room:opd-201', action: 'recall', key: 'k1' }).ok, false, 'same key twice');
});

test('events and settings survive a restart (same database file)', () => {
  const api = makeApi();
  api.queue.apply(call);
  api.queue.setSettings({ patch: { system: { cap: 20 } }, at: 600, scope: 'system', summary: 'cap 20', by: 'test' });
  const again = new QueueService(api.db as DbService);
  assert.equal(again.list().filter((e) => e.action === 'call').length, 1);
  assert.equal(again.getSettings().system.cap, 20);
});

test('settings: staff none, supervisor per-department only, admin everything', () => {
  const api = makeApi();
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  api.gateway.saveUser(admin, { username: 'staff.d', name: 'D', role: 'staff', password: 'password-4' });
  api.gateway.saveUser(admin, { username: 'head.e', name: 'E', role: 'supervisor', password: 'password-5' });
  const staff = signIn(api, 'staff.d', 'password-4'), head = signIn(api, 'head.e', 'password-5');
  const group = { patch: { groups: { 'exam:opd-2-0': { cap: 9 } } }, at: 600, scope: 'exam:opd-2-0', summary: 't' };
  const hours = { patch: { hours: { opdOpen: 8, opdClose: 16 } }, at: 600, scope: 'system', summary: 't' };
  assert.equal((api.gateway.queueSettings(staff, group) as { ok: boolean }).ok, false);
  assert.equal((api.gateway.queueSettings(head, group) as { ok: boolean }).ok, true);
  assert.equal((api.gateway.queueSettings(head, hours) as { ok: boolean }).ok, false);
  assert.equal((api.gateway.queueSettings(admin, hours) as { ok: boolean }).ok, true);
});

test('new service hours restart the day log but keep the settings history', () => {
  const api = makeApi();
  api.queue.apply(call);
  const r = api.queue.setSettings({ patch: { hours: { opdOpen: 8, opdClose: 16 } }, at: 600, scope: 'system', summary: 'hours', by: 'test' });
  assert.ok(r.ok && r.reset);
  assert.deepEqual(api.queue.list().map((e) => e.action), ['config']);
  assert.equal(new QueueService(api.db as DbService).list().length, 1, 'the reset is stored too');
});

test('invalid settings are refused', () => {
  const api = makeApi();
  const bad = (patch: object) => api.queue.setSettings({ patch, at: 0, scope: 'system', summary: 'x' }).ok;
  assert.equal(bad({ system: { mode: 'turbo' } }), false);
  assert.equal(bad({ hours: { opdOpen: 3, opdClose: 9 } }), false);
  assert.equal(bad({ layout: { off: [], depts: [{ name: 'A', level: 7 }] } }), false);
  assert.equal(bad({ layout: { off: [], depts: [{ name: 'A', level: 2 }, { name: 'A', level: 3 }] } }), false);
});
