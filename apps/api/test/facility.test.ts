import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localInstant } from '../src/booking.service';
import { DbService } from '../src/db.service';
import { FacilityService } from '../src/facility.service';
import { indexFacility, stationLabel, validateFacility, type FacilityData } from '../src/facility-model';
import { sampleFacility } from '../src/facility-template';
import { FacilityController } from '../src/facility.controller';
import { ADMIN_PASSWORD, makeApi, signIn } from './helpers';

// The facility model (docs/FACILITY-MODEL-DESIGN.md): the sample hospital keeps every id the system used before, the
// Settings layout is folded in, administrators publish versions through checks, and the API validates against it.
type R = { ok?: boolean; code?: string; reason?: string; version?: number; impact?: { ok: boolean; issues: { level: string; at?: string; message: string }[]; changes: { id: string; change: string }[] };
  facility?: FacilityData & { version: number }; versions?: { version: number; source: string }[]; data?: FacilityData; draft?: { data: FacilityData } | null };
let n = 0;
const key = () => `fac-key-${String(++n).padStart(6, '0')}`;
const clone = (f: FacilityData): FacilityData => structuredClone({ buildings: f.buildings, floors: f.floors, departments: f.departments, groups: f.groups, points: f.points, site: f.site });

function setup() {
  const api = makeApi();
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  const live = () => api.gateway.queueSettings(admin, { patch: { dataMode: 'live' }, at: 400, scope: 'system', summary: 'live' });
  return { api, admin, live, data: () => clone(api.facility.current()) };
}

test('the sample hospital keeps the ids the system already uses, and passes its own checks', () => {
  const f = sampleFacility(), ix = indexFacility(f);
  assert.deepEqual(validateFacility(f).issues, []);
  // Clinics with their queue letters, by floor.
  assert.deepEqual(f.departments.filter((d) => d.type === 'clinic').map((d) => `${d.id}=${d.queuePrefix}`), ['opd-2-0=A', 'opd-2-1=B', 'opd-2-2=C', 'opd-3-0=D', 'opd-3-1=E', 'opd-3-2=F', 'opd-4-0=G', 'opd-4-1=H', 'opd-4-2=I']);
  for (const id of ['room:opd-201', 'room:opd-406', 'screen:opd-2-0', 'screen:opd-2-0:3', 'screen:opd-3-0:3', 'screen:opd-4-2:2', 'counter:registration:5', 'counter:pharmacy:3', 'counter:finance:4',
    'counter:lab:3', 'counter:xray:3', 'counter:triage:1', 'bed-1-0', 'bed-5-15', 'er-101-A', 'er-104-B', 'er-resus-2', 'k-main-1', 'k-opd-lobby']) assert.ok(ix.point.has(id), id);
  assert.equal(ix.point.has('screen:opd-2-1:3'), false, 'two screening counters, three for the busiest clinics');
  assert.equal(ix.department.get('er')?.queuePrefix, 'ER');
  assert.equal(ix.department.get('er')?.firstGroupId, 'counter:triage', 'the ER starts at triage (another unit\'s group)');
  // Groups are the queue groups the queue settings already key on.
  for (const id of ['exam:opd-2-0', 'screening:opd-2-0', 'counter:pharmacy', 'counter:xray']) assert.ok(ix.group.has(id), id);
  // Names patients read.
  assert.equal(stationLabel(ix, 'room:opd-302'), 'ห้องตรวจ 302');
  assert.equal(stationLabel(ix, 'counter:pharmacy:2'), 'ช่องจ่ายยา 2');
  assert.equal(stationLabel(ix, 'screen:opd-3-0:2'), 'ซักประวัติศัลยกรรม ช่องบริการ 2');
  assert.equal(stationLabel(ix, 'counter:xray:1'), 'ห้องเอกซเรย์ 201');
  // A group says what its points are called: rooms here, counters there, beds in the wards.
  assert.equal(ix.group.get('exam:opd-3-0')?.pointNoun, 'ห้องตรวจ');
  assert.equal(ix.group.get('screening:opd-3-0')?.pointNoun, 'ช่องบริการ');
  assert.equal(ix.group.get('beds:inpatient-1-0')?.pointNoun, 'เตียง');
  assert.equal(ix.point.get('bed-1-0')?.inRoomId, 'room:inpatient-101', 'a bed in a ward room');
});

test('the Settings layout is folded in: added and renamed departments, rooms shared out and renamed, things switched off', () => {
  const f = sampleFacility({
    depts: [{ name: 'คลินิกโรคไต', level: 2 }], names: { 'opd-3-0': 'ศัลยกรรมทั่วไป' }, split: { 'opd-2': [2, 1, 1, 2] }, roomNames: { 'opd-201': 'ห้องตรวจพิเศษ' },
    off: ['dept:ตา', 'room:opd-202', 'counter:pharmacy:3'],
  });
  const ix = indexFacility(f);
  assert.deepEqual(validateFacility(f).issues.filter((i) => i.level === 'error'), []);
  const added = ix.department.get('opd-2-3')!;
  assert.equal(added.name, 'คลินิกโรคไต');
  assert.equal(added.queuePrefix, 'J', 'a department added in Settings comes after the shipped clinics');
  assert.deepEqual((ix.pointsOf.get('exam:opd-2-3') ?? []).map((p) => p.id), ['room:opd-205', 'room:opd-206']);
  assert.deepEqual((ix.pointsOf.get('exam:opd-2-1') ?? []).map((p) => p.id), ['room:opd-203']);
  assert.equal(ix.department.get('opd-3-0')?.name, 'ศัลยกรรมทั่วไป');
  assert.equal(ix.group.get('exam:opd-3-0')?.name, 'ห้องตรวจศัลยกรรมทั่วไป');
  assert.equal(ix.point.get('room:opd-201')?.name, 'ห้องตรวจพิเศษ');
  assert.equal(ix.department.get('opd-4-1')?.active, false);
  assert.equal(ix.point.get('room:opd-202')?.active, false);
  assert.equal(ix.point.get('counter:pharmacy:3')?.active, false);
});

test('the first start makes version 1 from the stored layout; later starts read the published tables', () => {
  process.env.DB_PATH = ':memory:';
  const db = new DbService();
  db.setKv('queue.settings', { system: {}, groups: {}, stations: {}, layout: { depts: [{ name: 'คลินิกผิวหนัง', level: 4 }], off: ['room:opd-401'] } });
  const a = new FacilityService(db);
  assert.equal(a.version(), 1);
  assert.equal(a.versions()[0].source, 'seed');
  assert.equal(a.department('opd-4-3')?.name, 'คลินิกผิวหนัง');
  const b = new FacilityService(db);
  assert.deepEqual(b.current(), a.current(), 'the same facility back from the tables');
});

test('administrators publish a draft: checked, versioned, audited and sent to every screen', () => {
  const { api, admin, data } = setup();
  api.gateway.saveUser(admin, { username: 'staff.a', name: 'A', role: 'staff', password: 'password-1' });
  const staff = signIn(api, 'staff.a', 'password-1');
  const d = data();
  d.points.find((p) => p.id === 'room:opd-301')!.name = 'ห้องตรวจแผล';
  const g = d.groups.find((x) => x.id === 'counter:pharmacy')!;
  d.points.push({ id: 'p_rx4', groupId: g.id, number: 4, active: true });
  assert.equal((api.gateway.facilityDraftSave(staff, { data: d }) as R).code, 'FORBIDDEN');
  assert.equal((api.gateway.facilityDraftSave(admin, { data: d }) as R).ok, true);
  assert.equal((api.gateway.facilityDraft(admin) as R).draft!.data.points.at(-1)!.id, 'p_rx4', 'the draft is kept');
  const impact = (api.gateway.facilityImpact(admin, {}) as R).impact!;
  assert.equal(impact.ok, true);
  assert.deepEqual(impact.changes.map((c) => `${c.id}:${c.change}`).sort(), ['p_rx4:added', 'room:opd-301:changed']);
  api.emitted.length = 0;
  const r = api.gateway.facilityPublish(admin, { note: 'เพิ่มช่องจ่ายยา' }) as R;
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.version, 2);
  assert.equal(api.facility.stationName('room:opd-301'), 'ห้องตรวจแผล');
  assert.equal((api.gateway.facilityDraft(admin) as R).draft, null, 'publishing uses up the draft');
  const sent = api.emitted.filter((e) => e.event === 'facility:updated');
  assert.equal(sent.length, 2, 'staff and public screens');
  assert.ok(sent.every((e) => (e.data as { version: number }).version === 2));
  assert.ok(api.audit.list().some((e) => e.action === 'facility.publish' && e.targetId === '2'));
  assert.deepEqual((api.gateway.facilityVersions(admin, {}) as R).versions!.map((v) => `${v.version}:${v.source}`), ['2:publish', '1:seed']);
  assert.ok(((api.gateway.facilityVersions(admin, {}) as R).versions![0] as { publishedByName?: string }).publishedByName, 'the publisher by name');
  // Someone else published meanwhile: a draft made from version 1 must start again.
  assert.equal((api.gateway.facilityPublish(admin, { data: d, baseVersion: 1 }) as R).code, 'INVALID_STATE_TRANSITION');
  assert.equal((api.gateway.facilityPublish(admin, { data: data() }) as R).code, 'VALIDATION_ERROR', 'nothing to publish');
});

test('publishing refuses a facility that does not hold together', () => {
  const { api, admin, data } = setup();
  const bad = (change: (d: FacilityData) => void) => { const d = data(); change(d); return api.gateway.facilityPublish(admin, { data: d }) as R; };
  assert.match(bad((d) => { d.departments.find((x) => x.id === 'opd-2-1')!.queuePrefix = 'A'; }).reason!, /อักษรคิว A ซ้ำ/);
  assert.match(bad((d) => { d.groups.find((x) => x.id === 'exam:opd-2-0')!.floorId = 'nowhere'; }).reason!, /ชั้นที่ไม่มีในผัง/);
  assert.match(bad((d) => { d.points.push({ ...d.points[0] }); }).reason!, /รหัสจุดบริการซ้ำ/);
  assert.match(bad((d) => { d.departments.find((x) => x.id === 'opd-2-1')!.name = 'ศัลยกรรม'; }).reason!, /ชื่อแผนกซ้ำ/);
  assert.match(bad((d) => { d.points.find((x) => x.id === 'room:opd-201')!.number = 202; }).reason!, /เลขจุดซ้ำ/);
  assert.equal(bad((d) => { d.floors = d.floors.filter((x) => x.id !== 'opd-3'); }).code, 'VALIDATION_ERROR', 'a floor that still has groups on it');
  assert.equal(api.facility.version(), 1);
  // Warnings do not block: a group with fewer open points than it needs.
  const d = data();
  for (const p of d.points) if (p.groupId === 'exam:opd-4-2') p.active = false;
  const impact = (api.gateway.facilityImpact(admin, { data: d }) as R).impact!;
  assert.equal(impact.ok, true);
  assert.ok(impact.issues.some((i) => i.level === 'warning' && i.at === 'exam:opd-4-2'));
});

test('what still points at a department or a room: removing it is refused (retire instead), switching it off warns', () => {
  const { api, admin, data, live } = setup();
  const now = localInstant('2026-11-02', '08:00');
  api.booking.now = () => now; api.appts.now = () => now; api.facility.now = () => now;
  api.gateway.setFeatures(admin, { patch: { generalBooking: true, appointments: true } });
  api.gateway.setBookingPolicy(admin, { serviceCode: 'opd-3-1', displayName: 'ออร์โธ', enabled: true, advanceDays: 14 });
  api.gateway.createBookingSlots(admin, { serviceCode: 'opd-3-1', from: '2026-11-03', to: '2026-11-03', weekdays: [2], start: '09:00', end: '10:00', minutes: 60, capacity: 2 });
  const slot = (api.gateway.bookingSlots(admin, { serviceCode: 'opd-3-1', date: '2026-11-03' }) as { slots: { id: string }[] }).slots[0];
  assert.equal((api.gateway.createBooking(admin, { hn: '65-000001', slotId: slot.id, key: key() }) as R).ok, true);
  api.gateway.setApptPolicy(admin, { clinicCode: 'opd-3-1', displayName: 'ออร์โธ', enabled: true, queuePrefix: 'E' });
  api.gateway.createApptSessions(admin, { clinicCode: 'opd-3-1', providerCode: 'D1', providerName: 'นพ.เอ', from: '2026-11-03', to: '2026-11-03', weekdays: [2], start: '13:00', end: '14:00', minutes: 30, capacity: 1, roomId: 'opd-303' });

  // The settings page can show what uses them.
  const usage = (api.gateway.facilityUsage(admin, { ids: ['opd-3-1', 'room:opd-303', 'room:opd-301'] }) as { usage: Record<string, { what: string; count: number }[]> }).usage;
  assert.deepEqual(usage['opd-3-1'].map((u) => `${u.what}:${u.count}`), ['การจองล่วงหน้า:1', 'ตารางออกตรวจ:1']);
  assert.deepEqual(usage['room:opd-303'].map((u) => u.what), ['ตารางออกตรวจที่ระบุห้องนี้']);
  assert.equal(usage['room:opd-301'], undefined, 'nothing uses it');
  const removed = data();
  removed.departments = removed.departments.filter((x) => x.id !== 'opd-3-1');
  removed.groups = removed.groups.filter((g) => g.departmentId !== 'opd-3-1');
  removed.points = removed.points.filter((p) => !p.groupId.endsWith(':opd-3-1'));
  const a = (api.gateway.facilityImpact(admin, { data: removed }) as R).impact!;
  assert.equal(a.ok, false);
  const deptIssue = a.issues.find((i) => i.at === 'opd-3-1')!;
  assert.equal(deptIssue.level, 'error');
  assert.match(deptIssue.message, /การจองล่วงหน้า 1 รายการ/);
  assert.match(deptIssue.message, /ตารางออกตรวจ 1 รายการ/);
  assert.match(deptIssue.message, /เลิกใช้/);
  assert.equal(a.issues.find((i) => i.at === 'room:opd-303')?.level, 'error', 'the doctor\'s room');
  assert.equal((api.gateway.facilityPublish(admin, { data: removed }) as R).code, 'VALIDATION_ERROR');

  const retired = data();
  retired.departments.find((x) => x.id === 'opd-3-1')!.retiredAt = now.toISOString();
  const b = (api.gateway.facilityImpact(admin, { data: retired }) as R).impact!;
  assert.equal(b.ok, true, 'retiring keeps the records readable');
  assert.equal(b.issues.find((i) => i.at === 'opd-3-1')?.level, 'warning');
  assert.equal((api.gateway.facilityPublish(admin, { data: retired }) as R).ok, true);
  assert.equal((api.gateway.setBookingPolicy(admin, { serviceCode: 'opd-3-1', enabled: true }) as R).ok, true, 'its rules can still be read and changed');
  live();
  assert.equal((api.gateway.enterVisit(admin, { flow: 'opd', clinicKey: 'opd-3-1', dept: 'ออร์โธปิดิกส์', prefix: 'E', at: 500, key: key() }) as R).code, 'VALIDATION_ERROR', 'but it takes no new patients');
});

test('a department added to the facility works everywhere at once: booking, appointments, rooms, staff scope, the queue', () => {
  const { api, admin, data, live } = setup();
  const d = data();
  d.departments.push({ id: 'd_kidney', name: 'คลินิกโรคไต', type: 'clinic', queuePrefix: 'K', features: { booking: true, appointments: true, walkIn: true }, firstGroupId: 'g_kidney_screen', active: true });
  d.groups.push({ id: 'g_kidney_screen', departmentId: 'd_kidney', name: 'ซักประวัติโรคไต', floorId: 'opd-4', pointKind: 'counter', pointNoun: 'ช่องบริการ', steps: ['screening'], serves: 'department', minOpen: 1, active: true },
    { id: 'g_kidney_exam', departmentId: 'd_kidney', name: 'ห้องตรวจโรคไต', floorId: 'opd-4', pointKind: 'room', pointNoun: 'ห้องตรวจ', steps: ['exam', 'followup'], serves: 'department', minOpen: 1, active: true });
  d.points.push({ id: 'p_k_s1', groupId: 'g_kidney_screen', number: 1, active: true },
    { id: 'p_k_r1', groupId: 'g_kidney_exam', number: 1, roomCode: '410', active: true }, { id: 'p_k_r2', groupId: 'g_kidney_exam', number: 2, floorId: 'opd-3', active: true });
  const r = api.gateway.facilityPublish(admin, { data: d }) as R;
  assert.equal(r.ok, true, r.reason);
  api.gateway.setFeatures(admin, { patch: { generalBooking: true, appointments: true } });
  assert.equal((api.gateway.setBookingPolicy(admin, { serviceCode: 'd_kidney', displayName: 'โรคไต', enabled: true }) as R).ok, true);
  assert.equal((api.gateway.setApptPolicy(admin, { clinicCode: 'd_kidney', displayName: 'โรคไต', enabled: true, queuePrefix: 'K' }) as R).ok, true);
  const sessions = api.gateway.createApptSessions(admin, { clinicCode: 'd_kidney', providerCode: 'D9', providerName: 'นพ.ไต', from: '2026-11-04', to: '2026-11-04', weekdays: [3], start: '09:00', end: '10:00', minutes: 30, capacity: 1, roomId: 'p_k_r2' }) as R & { sessions?: number };
  assert.equal(sessions.sessions, 1, sessions.reason);
  assert.equal((api.gateway.saveUser(admin, { username: 'kidney.head', name: 'หัวหน้าไต', role: 'supervisor', password: 'password-9', clinics: ['d_kidney'] }) as R).ok, true);
  assert.equal((api.gateway.saveUser(admin, { username: 'nobody', name: 'x', role: 'staff', password: 'password-8', clinics: ['opd-9-9'] }) as R).ok, false, 'not in the facility');
  live();
  const v = api.gateway.enterVisit(admin, { flow: 'opd', clinicKey: 'd_kidney', dept: 'คลินิกโรคไต', prefix: 'K', at: 500, key: key() }) as R & { visit?: { clinicKey: string } };
  assert.equal(v.visit?.clinicKey, 'd_kidney', v.reason);
  assert.equal(api.facility.stationName('p_k_r1'), 'ห้องตรวจ 1');
  assert.equal(api.facility.stationName('p_k_s1'), 'ซักประวัติโรคไต ช่องบริการ 1');
});

test('rolling back publishes an earlier version again, as a new version', () => {
  const { api, admin, data } = setup();
  const d = data();
  d.buildings.find((b) => b.id === 'support')!.active = false;
  assert.equal((api.gateway.facilityPublish(admin, { data: d }) as R).version, 2);
  const r = api.gateway.facilityRollback(admin, { version: 1 }) as R;
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.version, 3);
  assert.equal(api.facility.current().buildings.find((b) => b.id === 'support')!.active, true);
  assert.deepEqual(clone(api.facility.current()), (api.gateway.facilityVersions(admin, { version: 1 }) as R).data);
  assert.equal((api.gateway.facilityRollback(admin, { version: 3 }) as R).code, 'VALIDATION_ERROR', 'already current');
  assert.equal((api.gateway.facilityRollback(admin, { version: 99 }) as R).code, 'RESOURCE_NOT_FOUND');
});

test('until the facility is published by hand, the old departments page re-makes it', () => {
  const { api, admin, data } = setup();
  api.emitted.length = 0;
  api.gateway.queueSettings(admin, { patch: { layout: { depts: [{ name: 'คลินิกโรคไต', level: 2 }], off: [] } }, at: 400, scope: 'system', summary: 'เพิ่มแผนก' });
  assert.equal(api.facility.version(), 2);
  assert.equal(api.facility.department('opd-2-3')?.name, 'คลินิกโรคไต');
  assert.ok(api.emitted.some((e) => e.event === 'facility:updated'));
  // A layout change that changes nothing in the model makes no version.
  api.gateway.queueSettings(admin, { patch: { layout: { depts: [{ name: 'คลินิกโรคไต', level: 2 }], off: [] } }, at: 401, scope: 'system', summary: 'อีกครั้ง' });
  assert.equal(api.facility.version(), 2);
  const d = data();
  d.departments.find((x) => x.id === 'opd-2-3')!.name = 'คลินิกไตเทียม';
  assert.equal((api.gateway.facilityPublish(admin, { data: d }) as R).ok, true);
  api.gateway.queueSettings(admin, { patch: { layout: { depts: [], off: [] } }, at: 402, scope: 'system', summary: 'ลบแผนก' });
  assert.equal(api.facility.version(), 3, 'published by hand: the model is no longer re-made from the layout');
  assert.equal(api.facility.department('opd-2-3')?.name, 'คลินิกไตเทียม');
});

test('public screens get the facility without retired things; staff get all of it', () => {
  const { api, admin, data } = setup();
  const d = data();
  d.points.find((p) => p.id === 'k-main-2')!.retiredAt = '2026-10-18T00:00:00.000Z';
  api.gateway.facilityPublish(admin, { data: d });
  const pub = (api.gateway.facilityGet({ data: {} } as never) as R).facility!;
  assert.equal(pub.points.some((p) => p.id === 'k-main-2'), false);
  assert.equal((api.gateway.facilityGet(admin) as R).facility!.points.some((p) => p.id === 'k-main-2'), true);
  assert.equal((api.gateway.facilityDraft({ data: {} } as never) as R).code, 'AUTH_REQUIRED');
});

test('the sample comes with how groups are set out: blood-draw booths, resuscitation bays for triage 1–2', () => {
  const ix = indexFacility(sampleFacility());
  assert.deepEqual(ix.group.get('counter:lab')?.options, { arrange: 'booths' });
  assert.deepEqual(ix.group.get('beds:er-resus')?.options, { triage: [1, 2] });
  assert.deepEqual(ix.group.get('beds:er')?.options, { triage: [3, 5] });
  const bad = sampleFacility();
  bad.groups.find((g) => g.id === 'beds:er')!.options = { triage: [4, 2] };
  assert.match(validateFacility(bad).issues[0].message, /ตัวเลือกของกลุ่มบริการ/);
});

test('an installation nobody has edited follows a newer sample on the next start; an edited one keeps its facility', () => {
  process.env.DB_PATH = ':memory:';
  const db = new DbService();
  const a = new FacilityService(db);
  assert.equal(a.version(), 1);
  // As if version 1 had been made by an older sample without the group options.
  db.db.prepare('UPDATE facility_service_groups SET options_json = NULL').run();
  assert.equal(new FacilityService(db).version(), 2, 're-made from the sample');
  assert.deepEqual(new FacilityService(db).index().group.get('counter:lab')?.options, { arrange: 'booths' });
  const c = new FacilityService(db), d = structuredClone(c.current());
  d.departments[0].name = 'ลงทะเบียนผู้ป่วย';
  c.publish('user:1', d);
  db.db.prepare('UPDATE facility_service_groups SET options_json = NULL').run();
  assert.equal(new FacilityService(db).version(), 3, 'published by hand: left as it is');
});

test('screens without a socket read the facility over REST (public view)', () => {
  const { api } = setup();
  const r = new FacilityController(api.facility).get();
  assert.equal(r.facility.version, 1);
  assert.ok(r.facility.points.some((p) => p.id === 'room:opd-201'));
});

test('the ground around the buildings is part of the facility: changing it is a change to publish', () => {
  const { api, admin, data } = setup();
  const d = data();
  d.site.roads.push([-80, 30, 80, 32]);
  const impact = (api.gateway.facilityImpact(admin, { data: d }) as R).impact!;
  assert.deepEqual(impact.changes.map((c) => `${c.id}:${c.change}`), ['site:changed']);
  assert.equal((api.gateway.facilityPublish(admin, { data: d }) as R).ok, true);
  assert.equal(api.facility.current().site.roads.length, 7);
  assert.ok(api.facility.current().site.flows?.length, 'walking routes come with the sample');
});
