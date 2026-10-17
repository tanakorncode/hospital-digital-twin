import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/errors';
import { ADMIN_PASSWORD, makeApi, patientController, signIn } from './helpers';

const U1 = `U${'a'.repeat(32)}`, U2 = `U${'b'.repeat(32)}`, U3 = `U${'c'.repeat(32)}`;
const codeOf = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as AppError).code; } return undefined; };
type R = { ok: boolean; code?: string; reason?: string; replaced?: boolean; hn?: string; linked?: boolean; since?: string };

function setup() {
  const api = makeApi();
  // LINE's answer, by test token: "id-U…" is a valid ID token for that LINE user.
  api.identity.verifyIdToken = async (t: string) => { if (t.startsWith('id-U')) return t.slice(3); throw new AppError('AUTH_REQUIRED', 'bad token'); };
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  api.gateway.setFeatures(admin, { patch: { accountLinking: true } });
  const ctl = patientController(api);
  const login = async (subject: string) => `Bearer ${(await ctl.session('1.1.1.1', { idToken: `id-${subject}-token` })).token}`;
  return { api, admin, ctl, login };
}

// ---- LINE token verification ------------------------------------------------------------------------------------
test('the LINE ID token is checked with LINE: issuer, audience and expiry', async () => {
  const api = makeApi(), realFetch = globalThis.fetch;
  process.env.LINE_LOGIN_CHANNEL_ID = '1650000000';
  let answer: { status: number; body: Record<string, unknown> } | 'down' = { status: 200, body: {} };
  globalThis.fetch = (async (_url: string, init: { body: URLSearchParams }) => {
    assert.equal(init.body.get('client_id'), '1650000000', 'checked against our channel');
    if (answer === 'down') throw new Error('network');
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  try {
    const exp = Math.floor(Date.now() / 1000) + 600;
    answer = { status: 200, body: { iss: 'https://access.line.me', sub: U1, aud: '1650000000', exp } };
    assert.equal(await api.identity.verifyIdToken('x'.repeat(20)), U1);
    answer = { status: 200, body: { iss: 'https://access.line.me', sub: U1, aud: '9999', exp } };
    assert.equal(await codeOf(() => api.identity.verifyIdToken('x')), 'AUTH_REQUIRED', 'token made for another channel');
    answer = { status: 200, body: { iss: 'https://access.line.me', sub: U1, aud: '1650000000', exp: 1000 } };
    assert.equal(await codeOf(() => api.identity.verifyIdToken('x')), 'AUTH_REQUIRED', 'expired');
    answer = { status: 400, body: { error: 'invalid_request' } };
    assert.equal(await codeOf(() => api.identity.verifyIdToken('x')), 'AUTH_REQUIRED', 'forged / unreadable');
    answer = 'down';
    assert.equal(await codeOf(() => api.identity.verifyIdToken('x')), 'UPSTREAM_UNAVAILABLE');
  } finally { globalThis.fetch = realFetch; delete process.env.LINE_LOGIN_CHANNEL_ID; }
});

test('without LINE Login set up, only an explicit test switch allows a made-up LINE user — never in production', async () => {
  const api = makeApi();
  assert.equal(await codeOf(() => api.identity.verifyIdToken(`dev:${U1}`)), 'FEATURE_DISABLED');
  process.env.PATIENT_DEV_LOGIN = 'on';
  try {
    assert.equal(await api.identity.verifyIdToken(`dev:${U1}`), U1);
    assert.equal(await codeOf(() => api.identity.verifyIdToken('dev:someone')), 'FEATURE_DISABLED');
    process.env.NODE_ENV = 'production';
    assert.equal(await codeOf(() => api.identity.verifyIdToken(`dev:${U1}`)), 'FEATURE_DISABLED');
  } finally { delete process.env.PATIENT_DEV_LOGIN; delete process.env.NODE_ENV; }
});

// ---- sessions -----------------------------------------------------------------------------------------------------
test('a verified LINE user gets an app session; a bad token, no token or an expired session gets nothing', async () => {
  const { api, ctl, login } = setup();
  assert.equal(await codeOf(() => ctl.session('1.1.1.1', { idToken: 'forged-token-123' })), 'AUTH_REQUIRED');
  assert.equal(await codeOf(() => ctl.session('1.1.1.1', {})), 'VALIDATION_ERROR');
  const auth = await login(U1);
  assert.deepEqual(ctl.me('1.1.1.1', auth), { ok: true, linked: false });
  assert.equal(await codeOf(() => ctl.me('1.1.1.1', undefined)), 'AUTH_REQUIRED');
  assert.equal(await codeOf(() => ctl.me('1.1.1.1', 'Bearer made-up')), 'AUTH_REQUIRED');
  const row = api.db.db.prepare('SELECT token_hash FROM patient_sessions').get() as { token_hash: string };
  assert.ok(!auth.includes(row.token_hash), 'only the hash is stored');
  ctl.logout(auth);
  assert.equal(await codeOf(() => ctl.me('1.1.1.1', auth)), 'AUTH_REQUIRED');
  const again = await login(U1);
  api.identity.now = () => new Date(Date.now() + 25 * 3600_000);
  assert.equal(await codeOf(() => ctl.me('1.1.1.1', again)), 'AUTH_REQUIRED', 'sessions end');
});

// ---- linking ------------------------------------------------------------------------------------------------------
test('linking: the patient shows a one-time code, staff check the ID card and confirm with the HN', async () => {
  const { api, admin, ctl, login } = setup();
  const auth = await login(U1);
  const code = ctl.startLink('1.1.1.1', auth);
  assert.match(code.qr, /^HDTLINK:[A-Za-z0-9_-]{20,}$/);
  assert.match(code.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const r = api.gateway.confirmLink(admin, { code: code.code.toLowerCase(), hn: '65-123456' }) as R;
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(ctl.me('1.1.1.1', auth).linked, true);
  assert.equal((ctl.me('1.1.1.1', auth) as { hn: string }).hn, '••3456', 'the patient sees only the last 4 digits');
  assert.equal((api.gateway.confirmLink(admin, { code: code.code, hn: '65-999999' }) as R).code, 'RESOURCE_NOT_FOUND', 'a code works once');
  assert.equal(await codeOf(() => ctl.startLink('1.1.1.1', auth)), 'POLICY_REJECTED', 'already linked');
  const trail = JSON.stringify(api.audit.list());
  assert.ok(!trail.includes(U1) && !trail.includes('123456'), 'neither the LINE id nor the HN is in the audit trail');
});

test('the QR works as well as the short code; codes expire after 10 minutes; one live code at a time', async () => {
  const { api, admin, ctl, login } = setup();
  const a = await login(U1), first = ctl.startLink('1.1.1.1', a), second = ctl.startLink('1.1.1.1', a);
  assert.equal((api.gateway.confirmLink(admin, { code: first.code, hn: '65-1' }) as R).code, 'RESOURCE_NOT_FOUND', 'replaced by the newer code');
  const b = await login(U2), late = ctl.startLink('1.1.1.1', b);
  api.identity.now = () => new Date(Date.now() + 11 * 60_000);
  assert.equal((api.gateway.confirmLink(admin, { code: late.qr, hn: '65-2' }) as R).code, 'RESOURCE_NOT_FOUND', 'expired');
  api.identity.now = () => new Date();
  assert.equal((api.gateway.confirmLink(admin, { code: second.qr, hn: '65-1' }) as R).ok, true);
});

test('a new phone: linking the same patient again ends the old link, and the old phone sees nothing', async () => {
  const { api, admin, ctl, login } = setup();
  const oldPhone = await login(U1);
  api.gateway.confirmLink(admin, { code: ctl.startLink('1.1.1.1', oldPhone).code, hn: '65-1' });
  const newPhone = await login(U2);
  const r = api.gateway.confirmLink(admin, { code: ctl.startLink('1.1.1.1', newPhone).code, hn: '65-1' }) as R;
  assert.equal(r.replaced, true);
  assert.equal(ctl.me('1.1.1.1', newPhone).linked, true);
  assert.equal(ctl.me('1.1.1.1', oldPhone).linked, false);
});

test('one LINE account cannot be linked to a second patient', async () => {
  const { api, admin, ctl, login } = setup();
  const phone = await login(U1);
  const pending = ctl.startLink('1.1.1.1', phone);
  const other = await login(U1); // same LINE user, second session
  api.gateway.confirmLink(admin, { code: pending.code, hn: '65-1' });
  assert.equal(await codeOf(() => ctl.startLink('1.1.1.1', other)), 'POLICY_REJECTED');
});

test('the patient can unlink; staff can end a link with a reason and see link status (never the LINE id)', async () => {
  const { api, admin, ctl, login } = setup();
  const auth = await login(U3);
  api.gateway.confirmLink(admin, { code: ctl.startLink('1.1.1.1', auth).code, hn: '65-77' });
  const st = api.gateway.linkStatus(admin, { hn: '65-77' }) as R;
  assert.equal(st.linked, true);
  assert.ok(!JSON.stringify(st).includes(U3));
  assert.equal((api.gateway.revokeLink(admin, { hn: '65-77' }) as R).code, 'VALIDATION_ERROR');
  assert.equal((api.gateway.revokeLink(admin, { hn: '65-77', reason: 'ผู้ป่วยแจ้งโทรศัพท์หาย' }) as R).ok, true);
  assert.equal(ctl.me('1.1.1.1', auth).linked, false);
  assert.equal((api.gateway.revokeLink(admin, { hn: '65-77', reason: 'x' }) as R).code, 'RESOURCE_NOT_FOUND');
  api.gateway.confirmLink(admin, { code: ctl.startLink('1.1.1.1', auth).code, hn: '65-77' });
  assert.deepEqual(ctl.unlink('1.1.1.1', auth), { ok: true, linked: false });
  assert.equal(ctl.me('1.1.1.1', auth).linked, false);
});

test('linking needs its switch on; codes and requests are rate-limited', async () => {
  const { api, admin, ctl, login } = setup();
  const auth = await login(U1);
  for (let i = 0; i < 4; i++) ctl.startLink('1.1.1.1', auth);
  ctl.startLink('1.1.1.1', auth);
  assert.equal(await codeOf(() => ctl.startLink('1.1.1.1', auth)), 'RATE_LIMITED', 'at most 5 codes an hour');
  api.gateway.setFeatures(admin, { patch: { accountLinking: false } });
  const second = await login(U2);
  assert.equal(await codeOf(() => ctl.startLink('1.1.1.1', second)), 'FEATURE_DISABLED');
  assert.equal((api.gateway.confirmLink(admin, { code: 'AAAA-AAAA', hn: '65-1' }) as R).code, 'FEATURE_DISABLED');
  let limited: string | undefined;
  for (let i = 0; i < 40 && !limited; i++) limited = await codeOf(() => ctl.me('9.9.9.9', auth));
  assert.equal(limited, 'RATE_LIMITED', 'per-address limit on the patient API');
});
