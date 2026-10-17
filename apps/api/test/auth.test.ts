import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN_PASSWORD, fakeSocket, makeApi, signIn } from './helpers';

test('first start creates the administrator from the environment', () => {
  const api = makeApi();
  const users = api.auth.list();
  assert.equal(users.length, 1);
  assert.equal(users[0].role, 'admin');
  assert.ok(api.auth.login('admin', ADMIN_PASSWORD, 'x').ok);
});

test('wrong password is refused and five failures lock the account for that address', () => {
  const api = makeApi();
  assert.equal(api.auth.login('admin', 'nope', 'ip1').ok, false);
  for (let i = 0; i < 4; i++) api.auth.login('admin', 'nope', 'ip1');
  const locked = api.auth.login('admin', ADMIN_PASSWORD, 'ip1');
  assert.equal(locked.ok, false);
  assert.match((locked as { reason: string }).reason, /รอ 5 นาที/);
  assert.ok(api.auth.login('admin', ADMIN_PASSWORD, 'ip2').ok, 'another address is not locked');
});

test('passwords are hashed, never stored as text', () => {
  const api = makeApi();
  const row = api.db.db.prepare('SELECT pass_hash FROM users').get() as { pass_hash: string };
  assert.ok(row.pass_hash.startsWith('scrypt$'));
  assert.ok(!row.pass_hash.includes(ADMIN_PASSWORD));
});

test('sessions resolve to the user and end on sign-out', () => {
  const api = makeApi();
  const r = api.auth.login('admin', ADMIN_PASSWORD, 'x');
  assert.ok(r.ok);
  assert.equal(api.auth.resolve(r.token)?.username, 'admin');
  api.auth.logout(r.token);
  assert.equal(api.auth.resolve(r.token), null);
  assert.equal(api.auth.resolve('not-a-token'), null);
});

test('account rules: unique usernames, password length, keep one administrator', () => {
  const api = makeApi();
  const me = api.auth.list()[0];
  assert.ok(api.auth.save({ username: 'nurse.a', name: 'พย.เอ', role: 'staff', password: 'password-1' }, me).ok);
  assert.equal(api.auth.save({ username: 'NURSE.A', name: 'x', role: 'staff', password: 'password-1' }, me).ok, false);
  assert.equal(api.auth.save({ username: 'short.pw', name: 'x', role: 'staff', password: '123' }, me).ok, false);
  assert.equal(api.auth.save({ id: me.id, role: 'staff' }, me).ok, false, 'cannot demote the last admin');
  assert.equal(api.auth.save({ id: me.id, active: false }, me).ok, false, 'cannot suspend the last admin');
});

test('suspending a user ends their sessions and blocks sign-in', () => {
  const api = makeApi();
  const me = api.auth.list()[0];
  const created = api.auth.save({ username: 'nurse.b', name: 'พย.บี', role: 'staff', password: 'password-2' }, me);
  assert.ok(created.ok);
  const s = api.auth.login('nurse.b', 'password-2', 'x');
  assert.ok(s.ok);
  api.auth.save({ id: created.user.id, active: false }, me);
  assert.equal(api.auth.resolve(s.token), null);
  assert.equal(api.auth.login('nurse.b', 'password-2', 'x').ok, false);
});

test('gateway: user list and account changes are for administrators only', () => {
  const api = makeApi();
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  assert.equal((api.gateway.users(admin) as { ok: boolean }).ok, true);
  api.gateway.saveUser(admin, { username: 'staff.c', name: 'C', role: 'staff', password: 'password-3' });
  const staff = signIn(api, 'staff.c', 'password-3');
  assert.equal((api.gateway.users(staff) as { ok: boolean }).ok, false);
  assert.equal((api.gateway.users(fakeSocket()) as { ok: boolean }).ok, false);
});
