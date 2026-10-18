import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppError } from '../src/errors';
import type { Answer, HelpRequest, TurnResponse } from '../src/reception.service';
import { ADMIN_PASSWORD, fakeSocket, makeApi, receptionController, signIn } from './helpers';

// Digital Reception, Release A (no LLM): a kiosk signs in as a device, a visitor gets answers from rules and approved
// content only, clinical / personal / emergency questions go to a person, and nothing typed is stored.
type R = { ok: boolean; code?: string; reason?: string; credential?: string; device?: { id: string; status: string }; answer?: Answer; kiosks?: unknown[]; rows?: { event: string; intent: string; count: number }[] };
const codeOf = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as AppError).code; } return undefined; };

function setup() {
  const api = makeApi(), admin = signIn(api, 'admin', ADMIN_PASSWORD), ctl = receptionController(api);
  api.gateway.setFeatures(admin, { patch: { reception: true } });
  for (const [code, nameTh, buildingId, level, landmarkTh] of [['OPD-LOBBY', 'โถงหน้า OPD', 'opd', 1, undefined], ['OPD-PHARMACY', 'ห้องยา', 'opd', 1, 'ตรงข้ามลิฟต์'],
    ['DX-LAB', 'ห้องเจาะเลือด', 'diagnostics', 1, undefined], ['OPD-EYE', 'คลินิกตา', 'opd', 4, 'ข้างลิฟต์ฝั่งขวา']] as const)
    api.wayfinding.save({ code, nameTh, buildingId, level, landmarkTh }, 'test');
  const made = api.gateway.saveKiosk(admin, { name: 'ตู้ล็อบบี้ OPD', atCode: 'OPD-LOBBY' }) as R;
  const token = ctl.signIn('10.0.0.5', { credential: made.credential }).token, auth = `Bearer ${token}`;
  const session = () => ctl.start(auth).sessionId;
  const say = (sid: string, input: unknown) => (ctl.turn(sid, { input }, auth) as unknown as TurnResponse & { ok: boolean }).response;
  const answer = (body: Record<string, unknown>, approve = true) => {
    const a = (api.gateway.saveAnswer(admin, { owner: 'งานประชาสัมพันธ์', topic: 'faq', ...body }) as R).answer!;
    return approve ? (api.gateway.approveAnswer(admin, { id: a.id }) as R).answer! : a;
  };
  return { api, admin, ctl, made, auth, session, say, answer };
}

test('a kiosk signs in with its own credential, shown once; revoked or rotated = refused at once', async () => {
  const { api, admin, ctl, made, auth } = setup();
  assert.match(made.credential!, /^k-[a-z0-9]{8}\.[A-Za-z0-9_-]{30,}$/);
  assert.equal(JSON.stringify(api.kiosks.list()).includes(made.credential!.split('.')[1]), false, 'only the hash is kept');
  assert.equal(ctl.capabilities(auth).kiosk.name, 'ตู้ล็อบบี้ OPD');
  assert.deepEqual(ctl.capabilities(auth).capabilities, { wayfinding: true, speech: true, voiceInput: false, ai: false, generalQueueInfo: false, myQueue: false });
  assert.equal(await codeOf(() => ctl.signIn('10.0.0.6', { credential: `${made.device!.id}.wrong-secret` })), 'AUTH_REQUIRED');
  assert.equal(await codeOf(() => ctl.capabilities('Bearer not-a-real-token-at-all-xxxx')), 'AUTH_REQUIRED');
  // Rotation: the old credential and the old session stop; the new credential works.
  const rotated = api.gateway.rotateKiosk(admin, { id: made.device!.id }) as R;
  assert.equal(await codeOf(() => ctl.capabilities(auth)), 'AUTH_REQUIRED');
  assert.equal(await codeOf(() => ctl.signIn('10.0.0.7', { credential: made.credential })), 'AUTH_REQUIRED');
  const fresh = `Bearer ${ctl.signIn('10.0.0.7', { credential: rotated.credential }).token}`;
  assert.ok(ctl.capabilities(fresh).kiosk);
  api.gateway.revokeKiosk(admin, { id: made.device!.id });
  assert.equal(await codeOf(() => ctl.capabilities(fresh)), 'AUTH_REQUIRED');
  // Switched off: every kiosk call says so (the kiosk shows "closed").
  api.gateway.setFeatures(admin, { patch: { reception: false } });
  assert.equal(await codeOf(() => ctl.signIn('10.0.0.8', { credential: rotated.credential })), 'FEATURE_DISABLED');
  // Guessing credentials is rate-limited per address.
  api.gateway.setFeatures(admin, { patch: { reception: true } });
  for (let i = 0; i < 10; i++) await codeOf(() => ctl.signIn('10.0.0.9', { credential: 'k-00000000.x' }));
  assert.equal(await codeOf(() => ctl.signIn('10.0.0.9', { credential: 'k-00000000.x' })), 'RATE_LIMITED');
});

test('"where is …" answers with the place and steps from where the kiosk stands', () => {
  const { session, say } = setup();
  const r = say(session(), { type: 'text', text: 'ห้องเจาะเลือดอยู่ไหนครับ' });
  assert.equal(r.intent, 'wayfinding');
  assert.match(r.text, /ห้องเจาะเลือด อยู่ที่อาคารศูนย์การแพทย์ ชั้น 1/);
  const place = r.actions.find((a) => a.type === 'show_place') as Extract<TurnResponse['response']['actions'][number], { type: 'show_place' }>;
  assert.equal(place.place.code, 'DX-LAB');
  assert.deepEqual(place.steps, ['ออกไปทางอาคารศูนย์การแพทย์ ตามป้ายบอกทาง', 'ห้องเจาะเลือด'], 'from the lobby (OPD floor 1), not from the main entrance');
  assert.equal(say(session(), { type: 'place', code: 'OPD-EYE' }).actions.some((a) => a.type === 'show_place'), true);
  assert.equal(say(session(), { type: 'text', text: 'ห้องน้ำอยู่ตรงไหน' }).intent, 'directory', 'a place not on the list: the directory, no guess');
});

test('only approved answers inside their dates are used; an edit needs approval again; similar ones are offered to choose', () => {
  const { api, admin, session, say, answer } = setup();
  const draft = answer({ questionTh: 'จอดรถที่ไหน', keywords: 'จอดรถ,ที่จอด', answerTh: 'ลานจอดรถอยู่ด้านหลังอาคาร OPD' }, false);
  assert.equal(say(session(), { type: 'text', text: 'จอดรถได้ที่ไหน' }).intent, 'unknown', 'a draft is never said');
  api.gateway.approveAnswer(admin, { id: draft.id });
  const r = say(session(), { type: 'text', text: 'จอดรถได้ที่ไหน' });
  assert.deepEqual([r.intent, r.text, r.sources[0].id], ['answer', 'ลานจอดรถอยู่ด้านหลังอาคาร OPD', `${draft.id}@v1`]);
  const edited = (api.gateway.saveAnswer(admin, { id: draft.id, owner: 'งานประชาสัมพันธ์', topic: 'faq', questionTh: 'จอดรถที่ไหน', keywords: 'จอดรถ', answerTh: 'ลานจอดรถใหม่' }) as R).answer!;
  assert.deepEqual([edited.status, edited.version], ['DRAFT', 2]);
  assert.equal(say(session(), { type: 'text', text: 'จอดรถได้ที่ไหน' }).intent, 'unknown', 'not said until approved again');
  // Dates: an answer that has not started yet or has ended is not used.
  answer({ questionTh: 'วันหยุดปีใหม่', keywords: 'ปีใหม่', answerTh: 'ปิด 1 ม.ค.', effectiveFrom: '2099-01-01' });
  assert.equal(say(session(), { type: 'text', text: 'ปีใหม่เปิดไหม' }).intent, 'hours', 'falls through to the service hours');
  // Two answers fit equally: the visitor chooses.
  answer({ questionTh: 'ทำบัตรผู้ป่วยใหม่', keywords: 'บัตร', answerTh: 'ที่เคาน์เตอร์เวชระเบียน' });
  answer({ questionTh: 'บัตรหาย', keywords: 'บัตร', answerTh: 'แจ้งเวชระเบียน' });
  const c = say(session(), { type: 'text', text: 'เรื่องบัตร' });
  assert.equal(c.intent, 'choose');
  assert.equal((c.actions[0] as { options: unknown[] }).options.length, 2);
  // Approved emergency wording only; other content cannot be put in by the visitor.
  assert.equal((api.gateway.saveAnswer(admin, { owner: 'x', topic: 'diagnosis', questionTh: 'q', keywords: 'a', answerTh: 'a' }) as R).code, 'VALIDATION_ERROR');
});

test('clinical, personal and emergency questions go to a person; an emergency also calls staff to the kiosk', () => {
  const { api, session, say } = setup();
  const clinical = say(session(), { type: 'text', text: 'ปวดหัวมากควรกินยาอะไร' });
  assert.deepEqual([clinical.intent, clinical.handoff], ['clinical', { required: true, reason: 'clinical' }]);
  assert.match(clinical.text, /ไม่สามารถให้คำแนะนำทางการแพทย์/);
  const personal = say(session(), { type: 'text', text: 'ขอดูนัดของฉันหน่อย HN 65-123456' });
  assert.deepEqual([personal.intent, personal.handoff.reason], ['personal', 'personal']);
  assert.equal(JSON.stringify(personal).includes('65-123456'), false, 'never repeats what was typed');
  assert.equal(say(session(), { type: 'text', text: 'ห้องยาอยู่ไหน' }).intent, 'wayfinding', '"ห้องยา" is a place, not a medicine question');
  api.emitted.length = 0;
  const e = say(session(), { type: 'text', text: 'มีคนหมดสติตรงนี้' });
  assert.deepEqual([e.intent, e.handoff.reason], ['emergency', 'emergency']);
  const help = api.emitted.find((x) => x.event === 'reception:help');
  assert.equal(help?.to, 'staff', 'only staff consoles');
  assert.equal((help!.data as HelpRequest[])[0].reason, 'emergency');
  assert.equal((help!.data as HelpRequest[])[0].whereTh, 'โถงหน้า OPD · อาคารผู้ป่วยนอก (OPD) ชั้น 1');
});

test('"call staff": staff consoles see the kiosk and where it is; any staff member takes it', () => {
  const { api, admin, ctl, auth, session } = setup();
  const sid = session();
  ctl.help(sid, auth); ctl.help(sid, auth);
  assert.equal(api.reception.openHelp().length, 1, 'one open call per kiosk');
  api.gateway.saveUser(admin, { username: 'staff.a', name: 'A', role: 'staff', password: 'password-1' });
  const staff = signIn(api, 'staff.a', 'password-1');
  assert.equal((staff as unknown as { sent: { event: string; data: unknown[] }[] }).sent.find((e) => e.event === 'reception:help')!.data.length, 1, 'a console that opens sees it');
  assert.deepEqual(api.gateway.ackKioskHelp(staff, { id: api.reception.openHelp()[0].id }), { ok: true, taken: true });
  assert.equal(api.reception.openHelp().length, 0);
  assert.ok(api.audit.list().some((x) => x.action === 'reception.help.ack'));
});

test('sessions: idle for 5 minutes ends them; a new visitor ends the previous session; unknown inputs are refused', async () => {
  const { api, ctl, auth, session, say } = setup();
  const first = session(), second = session();
  assert.equal(await codeOf(() => say(first, { type: 'menu', id: 'hours' })), 'RESOURCE_NOT_FOUND', 'the previous visitor\'s session is gone');
  const later = new Date(Date.now() + 6 * 60_000);
  api.reception.now = () => later;
  assert.equal(await codeOf(() => say(second, { type: 'menu', id: 'hours' })), 'RESOURCE_NOT_FOUND');
  api.reception.now = () => new Date();
  const sid = session();
  for (const bad of [{ type: 'sql', text: 'DROP TABLE' }, { type: 'text', text: 'x'.repeat(201) }, { type: 'menu', id: 'admin' }, { type: 'answer', id: '../etc' }, null])
    assert.equal(await codeOf(() => say(sid, bad)), 'VALIDATION_ERROR');
  assert.match(say(sid, { type: 'menu', id: 'hours' }).text, /แผนกผู้ป่วยนอก \(OPD\) เปิดรับบริการ 07\.00–16\.00 น\./, 'hours from the queue settings until wording is approved');
  assert.equal(say(sid, { type: 'menu', id: 'queue' }).intent, 'queue_info');
  for (let i = 0; i < 30; i++) await codeOf(() => say(sid, { type: 'menu', id: 'directory' }));
  assert.equal(await codeOf(() => say(sid, { type: 'menu', id: 'directory' })), 'RATE_LIMITED');
  void ctl;
});

test('nothing a visitor types is stored — only daily counts by kind of question', () => {
  const { api, admin, session, say } = setup();
  const sid = session(), secret = 'ข้อความทดสอบเฉพาะ-ZQX9';
  say(sid, { type: 'text', text: secret });
  say(sid, { type: 'text', text: 'ห้องยาอยู่ไหน' });
  say(sid, { type: 'text', text: `ปวดท้อง ${secret}` });
  const tables = (api.db.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);
  for (const t of tables) assert.equal(JSON.stringify(api.db.db.prepare(`SELECT * FROM "${t}"`).all()).includes('ZQX9'), false, `not in ${t}`);
  const rows = (api.gateway.receptionUsage(admin, {}) as R).rows!;
  const n = (event: string, intent: string) => rows.find((r) => r.event === event && r.intent === intent)?.count ?? 0;
  assert.deepEqual([n('session_started', ''), n('turn', 'unknown'), n('turn', 'wayfinding'), n('turn', 'clinical'), n('handoff_offered', 'clinical')], [1, 1, 1, 1, 1]);
});

test('administrators only: kiosks, answers, use', async () => {
  const { api, admin } = setup();
  api.gateway.saveUser(admin, { username: 'head.b', name: 'B', role: 'supervisor', password: 'password-2' });
  const head = signIn(api, 'head.b', 'password-2');
  for (const r of [api.gateway.receptionKiosks(head), api.gateway.saveKiosk(head, { name: 'x' }), api.gateway.receptionAnswers(head), api.gateway.saveAnswer(head, {}), api.gateway.receptionUsage(head, {})])
    assert.equal((r as R).code, 'FORBIDDEN');
  assert.equal((api.gateway.saveKiosk(admin, { name: 'x', atCode: 'not a code!' }) as R).code, 'VALIDATION_ERROR');
  assert.ok(api.audit.list().some((e) => e.action === 'reception.kiosk.create'));
});

test(`queue: off until an administrator allows it; then the board and "my queue" (by the slip's QR) — never personal details`, async () => {
  const { api, admin, ctl, auth, session, say } = setup();
  const sid = session();
  // Off: the queue button and questions about one's own queue say where to look instead.
  assert.deepEqual(say(sid, { type: 'menu', id: 'queue' }).actions, []);
  assert.equal(say(sid, { type: 'text', text: 'คิวของฉันถึงไหนแล้ว' }).intent, 'personal');
  // Administrators only, audited.
  api.gateway.saveUser(admin, { username: 'head.b', name: 'B', role: 'supervisor', password: 'password-2' });
  assert.equal((api.gateway.receptionSettings(signIn(api, 'head.b', 'password-2'), { patch: { queueInfo: true } }) as R).code, 'FORBIDDEN');
  assert.equal((api.gateway.receptionSettings(admin, { patch: { queueInfo: 'yes' } }) as R).code, 'VALIDATION_ERROR');
  assert.equal((api.gateway.receptionSettings(admin, { patch: { queueInfo: true, myQueue: true } }) as R).ok, true);
  assert.ok(api.audit.list().some((e) => e.action === 'reception.settings'));
  const caps = ctl.capabilities(auth).capabilities;
  assert.deepEqual([caps.generalQueueInfo, caps.myQueue], [true, true]);
  // On: the board, and "my queue" asks for the slip's QR.
  assert.deepEqual(say(sid, { type: 'menu', id: 'queue' }).actions.map((a) => a.type), ['show_queue', 'my_queue']);
  const mine = say(sid, { type: 'text', text: 'คิวของฉันถึงไหนแล้ว' });
  assert.deepEqual([mine.intent, mine.actions.map((a) => a.type)], ['my_queue', ['my_queue']]);
  assert.match(mine.text, /สแกน QR บนบัตรคิว/);
  assert.equal(say(sid, { type: 'text', text: 'คิวห้องยายาวไหม' }).intent, 'queue_info', 'about the queue, not the way to the pharmacy');
  assert.equal(say(sid, { type: 'text', text: 'ห้องยาอยู่ไหน' }).intent, 'wayfinding', 'the way there is unchanged');
  assert.equal(say(sid, { type: 'text', text: 'ขอดูนัดของฉัน' }).intent, 'personal', 'other personal things still go to staff');
  void codeOf;
});

test('the dashboard: kiosks on / off by when they were last heard from, calls for staff and use today — counts only', () => {
  const { api, admin, ctl, made, auth, session } = setup();
  const other = api.gateway.saveKiosk(admin, { name: 'ตู้ห้องยา', atCode: 'OPD-PHARMACY' }) as R; // registered, never switched on
  const sid = session(); ctl.help(sid, auth);
  type K = { id: string; name: string; place?: string; online: boolean; helpPending: boolean; sessionsToday: number; handoffsToday: number; lastSeenAt?: string };
  type S = { ok: boolean; reception: { kiosks: K[] }; appointments: { total: number }; messages: { waiting: number; failed24h: number } };
  const sum = () => api.gateway.dashboardSummary(admin) as unknown as S;
  const k = (id: string) => sum().reception.kiosks.find((x) => x.id === id)!;
  assert.deepEqual([k(made.device!.id).online, k(made.device!.id).place, k(made.device!.id).helpPending, k(made.device!.id).sessionsToday, k(made.device!.id).handoffsToday], [true, 'โถงหน้า OPD', true, 1, 1]);
  assert.deepEqual([k(other.device!.id).online, k(other.device!.id).lastSeenAt], [false, undefined], 'never heard from');
  // Quiet for 13 minutes (its session renews every 10): off.
  const later = new Date(Date.now() + 13 * 60_000); api.kiosks.now = () => later;
  assert.equal(k(made.device!.id).online, false);
  // Heard from again (a call with its session): on.
  api.kiosks.now = () => new Date(later.getTime() + 1000); ctl.start(`Bearer ${ctl.signIn('10.0.0.5', { credential: made.credential }).token}`);
  assert.equal(k(made.device!.id).online, true);
  const raw = JSON.stringify(sum());
  assert.ok(!/hn|HN|profile|line/i.test(raw.replace(/online|helpPending|handoffs/g, '')), 'nothing about any patient');
  assert.equal((api.gateway.dashboardSummary(fakeSocket()) as { code?: string }).code, 'AUTH_REQUIRED');
});

test('set up on the kiosk itself: an administrator signs in there, picks the kiosk (or adds it), the credential goes straight in', async () => {
  const { api, admin, ctl, made } = setup();
  api.gateway.saveUser(admin, { username: 'staff.k', name: 'เค', role: 'staff', password: 'password-7' });
  // Only administrators; the wrong password is refused like any sign-in.
  assert.equal(await codeOf(() => ctl.pairStart('10.1.0.1', { username: 'staff.k', password: 'password-7' })), 'FORBIDDEN');
  assert.equal(await codeOf(() => ctl.pairStart('10.1.0.1', { username: 'admin', password: 'wrong-password' })), 'AUTH_REQUIRED');
  const sessions = () => (api.db.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, before = sessions();
  const start = ctl.pairStart('10.1.0.2', { username: 'admin', password: ADMIN_PASSWORD }) as unknown as { ticket: string; kiosks: { id: string; name: string }[]; places: { code: string }[] };
  assert.equal(sessions(), before, 'the administrator\'s session ends at once — the kiosk keeps no account');
  assert.deepEqual(start.kiosks.map((k) => k.name), ['ตู้ล็อบบี้ OPD']);
  assert.ok(start.places.some((p) => p.code === 'OPD-LOBBY'));
  // Pick the registered kiosk: a fresh credential for it; the old one stops working.
  const picked = ctl.pairFinish('10.1.0.2', { ticket: start.ticket, kioskId: made.device!.id }) as unknown as { credential: string; kiosk: { id: string } };
  assert.equal(picked.kiosk.id, made.device!.id);
  assert.ok(ctl.signIn('10.1.0.3', { credential: picked.credential }).token);
  assert.equal(await codeOf(() => ctl.signIn('10.1.0.3', { credential: made.credential })), 'AUTH_REQUIRED', 'the earlier credential is replaced');
  // A ticket works once.
  assert.equal(await codeOf(() => ctl.pairFinish('10.1.0.2', { ticket: start.ticket, kioskId: made.device!.id })), 'AUTH_REQUIRED');
  // Add a new kiosk from the kiosk itself.
  const t2 = (ctl.pairStart('10.1.0.4', { username: 'admin', password: ADMIN_PASSWORD }) as unknown as { ticket: string }).ticket;
  const added = ctl.pairFinish('10.1.0.4', { ticket: t2, name: 'ตู้ห้องยา', atCode: 'OPD-PHARMACY' }) as unknown as { credential: string; kiosk: { name: string } };
  assert.equal(added.kiosk.name, 'ตู้ห้องยา');
  assert.ok(ctl.signIn('10.1.0.5', { credential: added.credential }).token);
  // A ticket is good for 10 minutes.
  const t3 = (ctl.pairStart('10.1.0.6', { username: 'admin', password: ADMIN_PASSWORD }) as unknown as { ticket: string }).ticket;
  const later = new Date(Date.now() + 11 * 60_000); api.kiosks.now = () => later;
  assert.equal(await codeOf(() => ctl.pairFinish('10.1.0.6', { ticket: t3, kioskId: made.device!.id })), 'AUTH_REQUIRED');
  const logged = (api.db.db.prepare(`SELECT action FROM audit_log WHERE action LIKE 'reception.kiosk.pair.%' ORDER BY id`).all() as { action: string }[]).map((r) => r.action);
  assert.deepEqual(logged, ['reception.kiosk.pair.start', 'reception.kiosk.pair.rotate', 'reception.kiosk.pair.start', 'reception.kiosk.pair.create', 'reception.kiosk.pair.start'], 'each step is in the audit log');
});
