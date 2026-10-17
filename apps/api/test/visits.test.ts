import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { test } from 'node:test';
import { IngestController } from '../src/ingest.controller';
import { LiveFeedService } from '../src/live-feed.service';
import type { Visit } from '../src/visits.service';
import { ADMIN_PASSWORD, fakeSocket, makeApi, signIn } from './helpers';

type R = { ok: boolean; code?: string; reason?: string; visit?: Visit };
const opd = { flow: 'opd', clinicKey: 'opd-2-0', dept: 'อายุรกรรมทั่วไป', prefix: 'A', at: 480 };
let n = 0;
const key = () => `test-key-${String(++n).padStart(6, '0')}`;

function liveApi() {
  const api = makeApi();
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  assert.equal((api.gateway.queueSettings(admin, { patch: { dataMode: 'live' }, at: 470, scope: 'system', summary: 'ข้อมูลจริง' }) as R).ok, true);
  return { api, admin };
}

test('real patients can only be taken in once an administrator switches on live data', () => {
  const api = makeApi();
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  assert.equal((api.gateway.enterVisit(admin, { ...opd, key: key() }) as R).code, 'POLICY_REJECTED', 'demo mode by default');
  api.gateway.saveUser(admin, { username: 'head.a', name: 'A', role: 'supervisor', password: 'password-1' });
  const head = signIn(api, 'head.a', 'password-1');
  assert.equal((api.gateway.queueSettings(head, { patch: { dataMode: 'live' }, at: 470, scope: 'system', summary: 'x' }) as R).ok, false, 'hospital-wide: admin only');
  assert.equal((api.gateway.queueSettings(admin, { patch: { dataMode: 'nonsense' as never }, at: 470, scope: 'system', summary: 'x' }) as R).ok, false);
  assert.equal((api.gateway.queueSettings(admin, { patch: { dataMode: 'live' }, at: 470, scope: 'system', summary: 'x' }) as R).ok, true);
  assert.equal(api.queue.getSettings().dataMode, 'live');
  assert.equal((api.gateway.enterVisit(fakeSocket(), { ...opd, key: key() }) as R).code, 'AUTH_REQUIRED');
});

test('queue numbers come from the server, run per prefix, and never repeat', () => {
  const { api, admin } = liveApi();
  const a = api.gateway.enterVisit(admin, { ...opd, key: key() }) as R;
  const b = api.gateway.enterVisit(admin, { ...opd, priority: 'elderly', key: key() }) as R;
  const e = api.gateway.enterVisit(admin, { flow: 'er', triage: 3, at: 481, key: key() }) as R;
  assert.deepEqual([a.visit!.queue, b.visit!.queue, e.visit!.queue], ['A001', 'A002', 'ER001']);
  assert.deepEqual([a.visit!.id, b.visit!.id, e.visit!.id], ['v-0001', 'v-0002', 'v-0003']);
  assert.deepEqual(a.visit!.steps.map((s) => s.kind), ['screening', 'exam'], 'the usual opening of an OPD visit');
  assert.deepEqual(e.visit!.steps.map((s) => s.kind), ['triage', 'treatment']);
  assert.equal(e.visit!.dept, 'ห้องฉุกเฉิน');
  assert.equal(api.visits.list().length, 3);
  assert.ok(api.emitted.filter((x) => x.event === 'visit').length === 3, 'every screen hears about a new patient');
  assert.deepEqual(api.audit.list({ targetType: 'visit' }).map((x) => x.action), ['visit.enter', 'visit.enter', 'visit.enter']);
});

test('a retried tap returns the same patient and number; a reused key with other data is refused', () => {
  const { api, admin } = liveApi();
  const k = key();
  const first = api.gateway.enterVisit(admin, { ...opd, key: k }) as R;
  const again = api.gateway.enterVisit(admin, { ...opd, key: k }) as R;
  assert.equal(again.visit!.queue, first.visit!.queue);
  assert.equal(api.visits.list().length, 1);
  assert.equal((api.gateway.enterVisit(admin, { ...opd, prefix: 'B', key: k }) as R).code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((api.gateway.enterVisit(admin, { ...opd }) as R).code, 'VALIDATION_ERROR', 'a key is required');
});

test('visit details are validated', () => {
  const { api, admin } = liveApi();
  const bad = (x: Record<string, unknown>) => (api.gateway.enterVisit(admin, { ...opd, ...x, key: key() } as never) as R).code;
  assert.equal(bad({ flow: 'ward' }), 'VALIDATION_ERROR');
  assert.equal(bad({ clinicKey: 'room-1' }), 'VALIDATION_ERROR');
  assert.equal(bad({ prefix: 'a1' }), 'VALIDATION_ERROR');
  assert.equal(bad({ priority: 'vip' }), 'VALIDATION_ERROR');
  assert.equal(bad({ triage: 2 }), 'VALIDATION_ERROR', 'triage is for ER patients');
  assert.equal(bad({ steps: ['exam', 'surgery'] }), 'VALIDATION_ERROR');
  assert.equal(bad({ at: 99999 }), 'VALIDATION_ERROR');
  assert.equal(api.visits.list().length, 0, 'nothing half-made');
});

test('queue actions on a real patient must name a step they were sent to; steps are added at the end', () => {
  const { api, admin } = liveApi();
  const v = (api.gateway.enterVisit(admin, { ...opd, key: key() }) as R).visit!;
  const cmd = (step: number, patientId = v.id) => api.gateway.queueCommand(admin, { at: 500, station: 'screen:opd-2-0', action: 'call', patientId, step }) as R;
  assert.equal(cmd(0).ok, true);
  assert.equal(cmd(2).ok, false, 'no third step yet');
  assert.equal(cmd(0, 'v-0099').ok, false, 'not in today\'s queue');
  const sent = api.gateway.addVisitStep(admin, { visitId: v.id, kind: 'lab', at: 530, key: key() }) as R;
  assert.deepEqual(sent.visit!.steps.map((s) => s.kind), ['screening', 'exam', 'lab']);
  assert.equal(api.queue.apply({ at: 540, station: 'counter:lab:1', action: 'call', patientId: v.id, step: 2 }).ok, true);
  assert.equal((api.gateway.addVisitStep(admin, { visitId: v.id, kind: 'treatment', at: 530, key: key() }) as R).code, 'VALIDATION_ERROR', 'an ER step for an OPD patient');
  assert.equal((api.gateway.addVisitStep(admin, { visitId: 'v-0042', kind: 'lab', at: 530, key: key() }) as R).code, 'RESOURCE_NOT_FOUND');
  assert.ok(api.queue.apply({ at: 500, station: 'room:opd-201', action: 'call', patientId: 'p-0001', step: 3 }).ok, 'simulated patients are unaffected');
});

test('cancelling needs a reason, is audited once, and stops further queue actions', () => {
  const { api, admin } = liveApi();
  const v = (api.gateway.enterVisit(admin, { ...opd, key: key() }) as R).visit!;
  assert.equal((api.gateway.cancelVisit(admin, { visitId: v.id }) as R).code, 'VALIDATION_ERROR');
  assert.equal((api.gateway.cancelVisit(admin, { visitId: v.id, reason: 'ลงทะเบียนผิด' }) as R).visit!.status, 'cancelled');
  assert.equal((api.gateway.cancelVisit(admin, { visitId: v.id, reason: 'ซ้ำ' }) as R).ok, true, 'repeating is harmless');
  assert.equal(api.audit.list({ targetType: 'visit', targetId: v.id }).filter((x) => x.action === 'visit.cancel').length, 1);
  assert.equal(api.queue.apply({ at: 500, station: 'screen:opd-2-0', action: 'call', patientId: v.id, step: 0 }).ok, false);
  assert.equal((api.gateway.addVisitStep(admin, { visitId: v.id, kind: 'lab', at: 530, key: key() }) as R).code, 'INVALID_STATE_TRANSITION');
});

test('a visit carries no name, HN or source reference to the screens', () => {
  const { api, admin } = liveApi();
  const v = (api.gateway.enterVisit(admin, { ...opd, key: key() }) as R).visit!;
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(v))).sort(), ['arrival', 'clinicKey', 'dept', 'flow', 'id', 'queue', 'status', 'steps']);
  const s = fakeSocket();
  api.gateway.handleConnection(s);
  assert.ok((s as unknown as { sent: { event: string }[] }).sent.some((x) => x.event === 'visits'), 'screens get today\'s visits on connect');
});

// ---- the public stream ----------------------------------------------------------------------------------------
test('public screens get the queue log without staff names; staff get it in full', () => {
  const api = makeApi();
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  api.gateway.queueCommand(admin, { at: 600, station: 'room:opd-201', action: 'call', patientId: 'p-0001', step: 3 });
  const tv = fakeSocket();
  api.gateway.handleConnection(tv);
  const log = (sock: unknown) => ((sock as { sent: { event: string; data: { by?: string }[] }[] }).sent.filter((x) => x.event === 'queue:events').at(-1)!.data);
  assert.equal(log(tv)[0].by, undefined, 'TV / patient page: no names');
  const staff = signIn(api, 'admin', ADMIN_PASSWORD);
  assert.equal(log(staff)[0].by, 'ผู้ดูแลระบบ');
  const live = api.emitted.filter((x) => x.event === 'queue:event');
  assert.equal((live.find((x) => x.to === 'staff')!.data as { by?: string }).by, 'ผู้ดูแลระบบ');
  assert.equal((live.find((x) => x.except === 'staff')!.data as { by?: string }).by, undefined);
  assert.ok(!live.some((x) => !x.to && !x.except), 'never one unredacted broadcast to everyone');
});

test('signing in on an open screen joins the staff stream and resends the full log; signing out leaves it', () => {
  const api = makeApi();
  const s = fakeSocket() as unknown as { rooms: Set<string>; sent: { event: string }[] };
  api.gateway.handleConnection(s as never);
  assert.equal(s.rooms.has('staff'), false);
  const before = s.sent.length;
  assert.equal((api.gateway.login(s as never, { username: 'admin', password: ADMIN_PASSWORD }) as R).ok, true);
  assert.ok(s.rooms.has('staff'));
  assert.ok(s.sent.slice(before).some((x) => x.event === 'queue:events'));
  api.gateway.logout(s as never);
  assert.equal(s.rooms.has('staff'), false);
});

test('in live mode a settings change never clears the day\'s queue log', () => {
  const { api, admin } = liveApi();
  const v = (api.gateway.enterVisit(admin, { ...opd, key: key() }) as R).visit!;
  api.queue.apply({ at: 500, station: 'screen:opd-2-0', action: 'call', patientId: v.id, step: 0 });
  const r = api.queue.setSettings({ patch: { hours: { opdOpen: 8, opdClose: 16 } }, at: 501, scope: 'system', summary: 'เวลา', by: 'x' });
  assert.equal(r.ok && r.reset, false);
  assert.ok(api.queue.list().some((e) => e.patientId === v.id && e.action === 'call'));
});

// ---- from the HIS -----------------------------------------------------------------------------------------------
test('the HIS adds registered patients (once per visit number) and sends them on', () => {
  process.env.INGEST_TOKEN = 'his-test-token';
  try {
    const { api } = liveApi();
    const ctl = new IngestController(new LiveFeedService(), api.queue, api.gateway, api.visits, api.audit), auth = 'Bearer his-test-token';
    const a = ctl.visit(auth, { ...opd, sourceId: 'VN-6810170001' });
    const b = ctl.visit(auth, { ...opd, sourceId: 'VN-6810170001' });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.visit.queue, a.visit.queue, 'same visit number → same queue number');
    assert.equal(ctl.queueEvent(auth, { at: 500, station: 'screen:opd-2-0', action: 'call', patientId: a.visit.id, step: 0 }).ok, true);
    assert.deepEqual(ctl.visitStep(auth, { sourceId: 'VN-6810170001', kind: 'pharmacy' }).visit.steps.map((s) => s.kind), ['screening', 'exam', 'pharmacy']);
    assert.throws(() => ctl.visitStep(auth, { sourceId: 'VN-unknown', kind: 'lab' }), (e: HttpException) => e.getStatus() === 404);
    assert.throws(() => ctl.visit('Bearer wrong', { ...opd, sourceId: 'VN-2' }), (e: HttpException) => e.getStatus() === 401);
    assert.deepEqual(api.audit.list({ targetType: 'visit' }).map((x) => x.actorType), ['his']);
  } finally { delete process.env.INGEST_TOKEN; }
});

test('the HIS cannot add patients while the hospital runs the demo', () => {
  process.env.INGEST_TOKEN = 'his-test-token';
  try {
    const api = makeApi();
    const ctl = new IngestController(new LiveFeedService(), api.queue, api.gateway, api.visits, api.audit);
    assert.throws(() => ctl.visit('Bearer his-test-token', { ...opd, sourceId: 'VN-1' }), (e: HttpException) => e.getStatus() === 409);
  } finally { delete process.env.INGEST_TOKEN; }
});
