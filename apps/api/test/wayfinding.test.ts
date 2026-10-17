import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/errors';
import { WayfindingController } from '../src/wayfinding.controller';
import { ADMIN_PASSWORD, makeApi, signIn } from './helpers';

type R = { ok: boolean; code?: string; reason?: string; added?: number; kept?: number };
const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AppError).code; } return undefined; };
const pharmacy = { code: 'opd-pharmacy', nameTh: 'ห้องยา', buildingId: 'opd', level: 1, zoneIndex: 1, landmarkTh: 'ตรงข้ามบันไดเลื่อน' };

function setup() {
  const api = makeApi(), admin = signIn(api, 'admin', ADMIN_PASSWORD);
  api.gateway.setFeatures(admin, { patch: { wayfinding: true } });
  return { api, admin, ctl: new WayfindingController(api.wayfinding, api.features) };
}

test('administrators define places with stable codes; the public sees only places in use', () => {
  const { api, admin, ctl } = setup();
  api.gateway.saveUser(admin, { username: 'staff.a', name: 'A', role: 'staff', password: 'password-1' });
  assert.equal((api.gateway.wayfindingSave(signIn(api, 'staff.a', 'password-1'), pharmacy) as R).code, 'FORBIDDEN');
  assert.equal((api.gateway.wayfindingSave(admin, { ...pharmacy, code: 'ห้องยา' }) as R).code, 'VALIDATION_ERROR', 'codes are printable ASCII');
  assert.equal((api.gateway.wayfindingSave(admin, pharmacy) as R).ok, true);
  api.gateway.wayfindingSave(admin, { code: 'STAFF-ROOM', nameTh: 'ห้องพักเจ้าหน้าที่', buildingId: 'opd', level: 2, isPublic: false });
  assert.deepEqual(ctl.destinations('1.1.1.1').destinations.map((d) => d.code), ['OPD-PHARMACY'], 'upper-cased; staff-only places hidden');
  assert.equal(codeOf(() => ctl.destination('1.1.1.1', 'STAFF-ROOM')), 'RESOURCE_NOT_FOUND');
  const one = ctl.destination('1.1.1.1', 'opd-pharmacy') as { destination: { landmarkTh: string } };
  assert.equal(one.destination.landmarkTh, 'ตรงข้ามบันไดเลื่อน');
  assert.ok(api.audit.list({ targetType: 'destination' }).length >= 2);
});

test('a retired place points to its replacement, so old signs still lead somewhere', () => {
  const { api, admin, ctl } = setup();
  api.gateway.wayfindingSave(admin, pharmacy);
  api.gateway.wayfindingSave(admin, { code: 'PHARMACY-2', nameTh: 'ห้องยา (ชั่วคราว)', buildingId: 'diagnostics', level: 1 });
  assert.equal((api.gateway.wayfindingRetire(admin, { code: 'OPD-PHARMACY', replacedBy: 'OPD-PHARMACY' }) as R).code, 'VALIDATION_ERROR');
  api.gateway.wayfindingRetire(admin, { code: 'OPD-PHARMACY', replacedBy: 'PHARMACY-2' });
  const r = ctl.destination('1.1.1.1', 'OPD-PHARMACY') as { retired: boolean; replacedBy?: { code: string } };
  assert.deepEqual([r.retired, r.replacedBy?.code], [true, 'PHARMACY-2']);
  assert.ok(!ctl.destinations('1.1.1.1').destinations.some((d) => d.code === 'OPD-PHARMACY'));
  assert.equal((api.gateway.wayfindingSave(admin, pharmacy) as R).code, 'INVALID_STATE_TRANSITION', 'a retired code is not reused');
  api.gateway.wayfindingRetire(admin, { code: 'PHARMACY-2' });
  assert.deepEqual(ctl.destination('1.1.1.1', 'OPD-PHARMACY'), { ok: true, retired: true }, 'nowhere to go: says so');
});

test('import from the department directory adds new places and keeps edited ones', () => {
  const { api, admin, ctl } = setup();
  api.gateway.wayfindingSave(admin, { ...pharmacy, landmarkTh: 'แก้ไขแล้ว' });
  const r = api.gateway.wayfindingImport(admin, { list: [pharmacy, { code: 'OPD-FINANCE', nameTh: 'การเงิน', buildingId: 'opd', level: 1, zoneIndex: 2 }] }) as R;
  assert.deepEqual([r.added, r.kept], [1, 1]);
  assert.equal((ctl.destination('1.1.1.1', 'OPD-PHARMACY') as { destination: { landmarkTh: string } }).destination.landmarkTh, 'แก้ไขแล้ว');
});

test('the public endpoints need wayfinding switched on, and are rate-limited', () => {
  const { api, admin, ctl } = setup();
  api.gateway.wayfindingSave(admin, pharmacy);
  let limited: string | undefined;
  for (let i = 0; i < 70 && !limited; i++) limited = codeOf(() => ctl.destinations('9.9.9.9'));
  assert.equal(limited, 'RATE_LIMITED');
  api.gateway.setFeatures(admin, { patch: { wayfinding: false } });
  assert.equal(codeOf(() => ctl.destinations('1.1.1.1')), 'FEATURE_DISABLED');
});
