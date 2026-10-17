import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { answer, richMenuBody, toMessage } from '../src/line-bot';
import type { Destination } from '../src/wayfinding.service';
import { ADMIN_PASSWORD, makeApi, signIn } from './helpers';

const place = (code: string, nameTh: string, buildingId: string, level: number, landmarkTh?: string): Destination =>
  ({ code, nameTh, buildingId, level, landmarkTh, isPublic: true, status: 'ACTIVE', updatedAt: '' });
const places = [place('OPD-1B', 'ห้องยา', 'opd', 1, 'ตรงข้ามลิฟต์ฝั่งซ้าย'), place('OPD-1C', 'การเงิน', 'opd', 1), place('DIAGNOSTICS-1B', 'ห้องเจาะเลือด', 'diagnostics', 1)];
let calls: { url: string; method: string; body?: unknown; headers: Record<string, string> }[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.LINE_LIFF_ID = '1650000000-AbCdEfGh'; process.env.PUBLIC_URL = 'https://queue.example.go.th/'; process.env.HOSPITAL_CONTACT = 'โทร 043-000-000 ต่อ 1234';
  calls = [];
});
afterEach(() => { globalThis.fetch = realFetch; for (const k of ['LINE_LIFF_ID', 'PUBLIC_URL', 'HOSPITAL_CONTACT', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'LINE_OA_ID']) delete process.env[k]; });

test('the bot answers common questions with buttons into the patient\'s own pages — never with personal data', () => {
  const q = answer('คิวถึงไหนแล้ว', places);
  assert.match(q.text, /คิวของฉัน/);
  assert.equal(q.quick.find((x) => x.label === 'คิวของฉัน')?.uri, 'https://liff.line.me/1650000000-AbCdEfGh?view=queue');
  assert.match(answer('อยากจองคิวพรุ่งนี้', places).text, /จองคิว/, '"จอง" wins over "คิว"');
  assert.match(answer('ขอเลื่อนนัดหมอ', places).text, /นัดหมาย/);
  assert.match(answer('ผูกบัญชียังไง', places).text, /บัตรประชาชน/);
  assert.match(answer('ติดต่อเจ้าหน้าที่', places).text, /043-000-000/);
  assert.match(answer('สวัสดีครับ', places).text, /พิมพ์ได้เช่น/);
});

test('"where is …" finds the place, its floor, its landmark and a link to the route', () => {
  const a = answer('ห้องยาอยู่ไหนครับ', places);
  assert.match(a.text, /ห้องยา อยู่ที่อาคารผู้ป่วยนอก \(OPD\) ชั้น 1\nตรงข้ามลิฟต์ฝั่งซ้าย\nดูเส้นทาง: https:\/\/queue\.example\.go\.th\/wayfinding\?to=OPD-1B/);
  assert.match(answer('ไปห้องเจาะเลือดยังไง', places).text, /อาคารศูนย์การแพทย์ ชั้น 1/);
  assert.match(answer('ห้องตรวจตาอยู่ไหน', places).text, /เมนู "แผนที่"/, 'unknown place: points to the map');
});

test('without LIFF or a public address the bot says the page is not open yet, and offers no dead buttons', () => {
  delete process.env.LINE_LIFF_ID; delete process.env.PUBLIC_URL;
  const a = answer('คิว', places);
  assert.match(a.text, /ยังไม่ได้เปิดหน้านี้/);
  assert.deepEqual(a.quick.map((q) => q.label), ['ติดต่อเจ้าหน้าที่']);
  const m = toMessage(answer('คิว', [])) as { quickReply: { items: { action: { type: string } }[] } };
  assert.equal(m.quickReply.items[0].action.type, 'message');
});

test('the webhook welcomes new friends and answers messages through the bot', async () => {
  process.env.LINE_CHANNEL_SECRET = 's'; process.env.LINE_CHANNEL_ACCESS_TOKEN = 't'; process.env.LINE_OA_ID = '@h';
  globalThis.fetch = (async (url: string, init: { body: string; method?: string; headers: Record<string, string> }) => { calls.push({ url, method: init.method ?? 'GET', body: JSON.parse(init.body), headers: init.headers }); return new Response('{}'); }) as typeof fetch;
  const api = makeApi(), admin = signIn(api, 'admin', ADMIN_PASSWORD);
  api.gateway.setFeatures(admin, { patch: { wayfinding: true } });
  api.gateway.wayfindingSave(admin, { code: 'OPD-1B', nameTh: 'ห้องยา', buildingId: 'opd', level: 1, landmarkTh: 'ตรงข้ามลิฟต์' });
  await api.line.handleWebhook({ events: [{ type: 'follow', replyToken: 'r0', source: { userId: 'U1' } }] });
  await api.line.handleWebhook({ events: [{ type: 'message', replyToken: 'r1', source: { userId: 'U1' }, message: { type: 'text', text: 'ห้องยาอยู่ไหน' } }] });
  const [welcome, place] = calls.map((c) => (c.body as { messages: { text: string; quickReply?: unknown }[] }).messages[0]);
  assert.match(welcome.text, /ยินดีต้อนรับ/);
  assert.ok(welcome.quickReply);
  assert.match(place.text, /ห้องยา อยู่ที่อาคารผู้ป่วยนอก \(OPD\) ชั้น 1\nตรงข้ามลิฟต์/);
  assert.equal((api.gateway.lineTry(admin, { text: 'ห้องยาอยู่ไหน' }) as { answer: { text: string } }).answer.text, place.text, 'Settings can try the bot without LINE');
});

test('rich menu: six tiles opening the patient pages; installing replaces our older menu and needs a valid PNG', async () => {
  const body = richMenuBody();
  assert.equal(body.areas.length, 6);
  assert.equal(body.areas.reduce((a, x) => a + x.bounds.width * x.bounds.height, 0), 2500 * 1686, 'the tiles cover the whole image');
  assert.equal((body.areas[0].action as { uri: string }).uri, 'https://liff.line.me/1650000000-AbCdEfGh?view=queue');
  assert.deepEqual(body.areas[5].action, { type: 'message', label: 'ติดต่อเจ้าหน้าที่', text: 'ติดต่อเจ้าหน้าที่' });

  const api = makeApi(), admin = signIn(api, 'admin', ADMIN_PASSWORD);
  const png = Buffer.alloc(64); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(2500, 16); png.writeUInt32BE(1686, 20);
  assert.equal((await api.gateway.lineRichMenu(admin, { png }) as { code: string }).code, 'FEATURE_DISABLED', 'no LINE token yet');
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 't';
  globalThis.fetch = (async (url: string, init: { method?: string; headers: Record<string, string> } = { headers: {} }) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers });
    if (url.endsWith('/richmenu/list')) return new Response(JSON.stringify({ richmenus: [{ richMenuId: 'old-ours', name: 'HDT เมนูผู้ป่วย' }, { richMenuId: 'theirs', name: 'โปรโมชัน' }] }));
    if (url.endsWith('/richmenu')) return new Response(JSON.stringify({ richMenuId: 'new-1' }));
    return new Response('{}');
  }) as typeof fetch;
  assert.equal((await api.gateway.lineRichMenu(admin, { png: Buffer.from('not a png') }) as { code: string }).code, 'VALIDATION_ERROR');
  assert.equal((await api.gateway.lineRichMenu(admin, { png }) as { ok: boolean }).ok, true);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace(/^https:\/\/api(-data)?\.line\.me\/v2\/bot/, '')}`),
    ['GET /richmenu/list', 'POST /richmenu', 'POST /richmenu/new-1/content', 'POST /user/all/richmenu/new-1', 'DELETE /richmenu/old-ours']);
  assert.equal(calls[2].headers['content-type'], 'image/png');
  assert.equal(api.audit.list()[0].action, 'line.richmenu');
  const st = api.gateway.lineStatus(admin) as Record<string, boolean>;
  assert.deepEqual([st.messaging, st.liff, st.login], [true, true, false], 'status says what is set up — never the values');
});
