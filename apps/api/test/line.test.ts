import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { placeOf } from '../src/line.service';
import { ADMIN_PASSWORD, makeApi, signIn } from './helpers';

const SECRET = 'line-channel-secret-for-tests';
let sent: { url: string; body: { to?: string; messages: { text: string }[] } }[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.LINE_CHANNEL_SECRET = SECRET; process.env.LINE_CHANNEL_ACCESS_TOKEN = 'token'; process.env.LINE_OA_ID = '@hospital';
  sent = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response('{}'); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; delete process.env.LINE_CHANNEL_SECRET; delete process.env.LINE_CHANNEL_ACCESS_TOKEN; delete process.env.LINE_OA_ID; });
const message = (userId: string, text: string) => ({ events: [{ type: 'message', replyToken: 'r1', source: { userId }, message: { type: 'text', text } }] });

test('switched off until the three LINE settings are present', () => {
  delete process.env.LINE_OA_ID;
  const api = makeApi();
  const r = api.line.startLink(api.tickets.issue('p-0010', 't').token, 'A012');
  assert.equal(r.ok, false);
  assert.equal((r as { disabled?: boolean }).disabled, true);
});

test('webhook signatures are checked against the channel secret', () => {
  const api = makeApi(), raw = Buffer.from('{"events":[]}');
  assert.ok(api.line.verify(raw, createHmac('sha256', SECRET).update(raw).digest('base64')));
  assert.equal(api.line.verify(raw, createHmac('sha256', 'other').update(raw).digest('base64')), false);
  assert.equal(api.line.verify(raw, undefined), false);
});

test('link → code in the OA chat → notified when called, moved and helped; "หยุด" stops it', async () => {
  const api = makeApi();
  const t = api.tickets.issue('p-0010', 'test');
  const start = api.line.startLink(t.token, 'A012');
  assert.ok(start.ok);
  assert.match(start.url, /^https:\/\/line\.me\/R\/oaMessage\/%40hospital\/\?/);
  await api.line.handleWebhook(message('U1', `รับแจ้งเตือนคิว ${start.code}`));
  assert.match(sent.at(-1)!.body.messages[0].text, /เปิดการแจ้งเตือนคิว A012/);
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  api.gateway.queueCommand(admin, { at: 600, station: 'room:opd-204', action: 'call', patientId: 'p-0010', step: 3 });
  await new Promise((r) => setTimeout(r, 10));
  const push = sent.at(-1)!;
  assert.match(push.url, /\/push$/);
  assert.equal(push.body.to, 'U1');
  assert.match(push.body.messages[0].text, /ถึงคิว A012.*\n.*ห้องตรวจ 204/);
  assert.ok(!/HN|นาย|นาง/.test(push.body.messages[0].text), 'queue number and place only');
  await api.line.handleWebhook(message('U1', 'หยุด'));
  const before = sent.length;
  api.gateway.queueCommand(admin, { at: 601, station: 'room:opd-204', action: 'recall', patientId: 'p-0010', step: 3 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, before, 'no messages after stopping');
});

test('family links cannot subscribe; codes expire; a re-issued slip ends the subscription', async () => {
  const api = makeApi();
  const t = api.tickets.issue('p-0010', 'test'), fam = api.tickets.family(t.token);
  assert.ok(fam.ok);
  assert.equal(api.line.startLink(fam.ticket.token, 'A012').ok, false);
  await api.line.handleWebhook(message('U2', 'รับแจ้งเตือนคิว 000000'));
  assert.match(sent.at(-1)!.body.messages[0].text, /หมดอายุหรือไม่ถูกต้อง/);
  const s = api.line.startLink(t.token, 'A012'); assert.ok(s.ok);
  await api.line.handleWebhook(message('U2', s.code));
  api.tickets.issue('p-0010', 'test', true); // slip lost → re-issued
  const before = sent.length;
  await api.line.onQueueEvent({ id: 'x', at: 600, station: 'room:opd-201', action: 'call', patientId: 'p-0010', step: 3 });
  assert.equal(sent.length, before);
});

test('places read like the hospital signs', () => {
  assert.equal(placeOf('room:opd-302'), 'ห้องตรวจ 302');
  assert.equal(placeOf('counter:pharmacy:2'), 'ช่องจ่ายยา 2');
  assert.equal(placeOf('screen:opd-2-0:3'), 'จุดซักประวัติ ชั้น 2 ช่อง 3');
});
