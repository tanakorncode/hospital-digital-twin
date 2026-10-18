import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/errors';
import { WayfindingController } from '../src/wayfinding.controller';
import { routeSteps } from '../src/wayfinding.service';
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

// ---- Places and the facility model --------------------------------------------------------------------------------
type D = { code: string; zoneIndex?: number; departmentId?: string; problem?: string };
const listOf = (api: ReturnType<typeof makeApi>, admin: unknown) => (api.gateway.wayfindingList(admin as never) as { destinations: D[] }).destinations;
const facilityData = (api: ReturnType<typeof makeApi>) => { const { version: _v, publishedAt: _p, ...d } = structuredClone(api.facility.current()); return d; };

test('a place for a department follows where the facility puts it, and says when the department has gone from that floor', () => {
  const { api, admin } = setup();
  assert.equal((api.gateway.wayfindingSave(admin, { code: 'ORTHO', nameTh: 'ออร์โธปิดิกส์', buildingId: 'opd', level: 3, departmentId: 'opd-3-1' }) as R).ok, true);
  assert.equal(listOf(api, admin).find((d) => d.code === 'ORTHO')!.zoneIndex, 1, 'its waiting band on the floor');
  // Surgery moves to floor 4: orthopaedics' band becomes the first on floor 3.
  const d = facilityData(api);
  for (const g of d.groups) if (g.departmentId === 'opd-3-0') g.floorId = 'opd-4';
  assert.equal((api.gateway.facilityPublish(admin, { data: d }) as R).ok, true);
  assert.equal(listOf(api, admin).find((x) => x.code === 'ORTHO')!.zoneIndex, 0);
  // Orthopaedics moves away too: the place says so.
  const e = facilityData(api);
  for (const g of e.groups) if (g.departmentId === 'opd-3-1') g.floorId = 'opd-2';
  api.gateway.facilityPublish(admin, { data: e });
  assert.match(listOf(api, admin).find((x) => x.code === 'ORTHO')!.problem ?? '', /ไม่อยู่บนอาคารผู้ป่วยนอก \(OPD\) ชั้น 3แล้ว/);
});

test('places are checked against the facility: its buildings, floors, departments and rooms', () => {
  const { api, admin } = setup();
  const save = (x: Record<string, unknown>) => api.gateway.wayfindingSave(admin, { code: 'X-1', nameTh: 'ทดสอบ', buildingId: 'opd', level: 1, ...x }) as R;
  assert.match(save({ buildingId: 'nowhere' }).reason ?? '', /ระบุอาคาร/);
  assert.match(save({ level: 9 }).reason ?? '', /ระบุชั้น/);
  assert.match(save({ departmentId: 'd_none' }).reason ?? '', /แผนกไม่ถูกต้อง/);
  assert.match(save({ roomId: 'opd-999' }).reason ?? '', /ห้องไม่ถูกต้อง/);
  assert.equal(save({ roomId: 'opd-101', departmentId: 'opd-1-0' }).ok, true);
});

test('places made before departments could be named are linked by name on their floor', () => {
  const { api } = setup();
  api.db.db.prepare(`INSERT INTO destinations (code, name_th, building_id, level, zone_index, is_public, status, updated_at) VALUES ('OPD-3B', 'ออร์โธปิดิกส์', 'opd', 3, 1, 1, 'ACTIVE', ?), ('OPD-9Z', 'ไม่มีแผนกนี้', 'opd', 3, 0, 1, 'ACTIVE', ?)`).run(new Date().toISOString(), new Date().toISOString());
  const again = new (api.wayfinding.constructor as new (...a: unknown[]) => typeof api.wayfinding)(api.db, api.facility);
  assert.equal(again.get('OPD-3B')!.departmentId, 'opd-3-1');
  assert.equal(again.get('OPD-9Z')!.departmentId, undefined);
});

test('import adds a place for every department on a floor that has none, making its code', () => {
  const { api, admin } = setup();
  api.gateway.wayfindingSave(admin, { code: 'OPD-1A', nameTh: 'ลงทะเบียน', buildingId: 'opd', level: 1, departmentId: 'opd-1-0' });
  const r = api.gateway.wayfindingImport(admin, { list: [
    { nameTh: 'ลงทะเบียน', buildingId: 'opd', level: 1, departmentId: 'opd-1-0' },
    { nameTh: 'ห้องยา', buildingId: 'opd', level: 1, departmentId: 'opd-1-1' }] }) as R;
  assert.deepEqual([r.added, r.kept], [1, 1], 'registration already has its place');
  assert.ok(listOf(api, admin).some((d) => d.code === 'OPD-1B' && d.departmentId === 'opd-1-1'), 'next free code');
});

test('directions use the facility: building and floor names, from the building with registration', () => {
  const { api, admin } = setup();
  const d = facilityData(api);
  d.buildings.find((b) => b.id === 'diagnostics')!.name = 'อาคารเฉลิมพระเกียรติ';
  d.floors.find((f) => f.id === 'diagnostics-2')!.name = 'ชั้น 2 (รังสี)';
  api.gateway.facilityPublish(admin, { data: d });
  api.gateway.wayfindingSave(admin, { code: 'XRAY', nameTh: 'รังสีวิทยา', buildingId: 'diagnostics', level: 2, departmentId: 'diagnostics-2-0' });
  const steps = routeSteps(undefined, api.wayfinding.get('XRAY')!);
  assert.equal(steps[0], 'เริ่มจากทางเข้าหลัก อาคารผู้ป่วยนอก (OPD) ชั้น 1');
  assert.ok(steps.includes('ออกไปทางอาคารเฉลิมพระเกียรติ ตามป้ายบอกทาง'));
  assert.ok(steps.includes('ขึ้นลิฟต์หรือบันไดไปชั้น 2 (รังสี)'));
});
