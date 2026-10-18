import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { sampleFacility } from '../../api/src/facility-template';
import { DEFAULT_CAPACITY, erBedSpots, erResusSpots, generatePatients, labStationSpots, opdClinics, wardBeds } from '../lib/patients';
import { allStations, everyStation, stationById } from '../lib/queue';
import { buildingStats, buildings, floorRooms, kiosks, type Layout } from '../lib/scene-data';
import { sampleFacility as webSample, setFacility } from '../lib/facility';
import { useLayout } from './facility-helpers';

// The app draws and simulates the hospital from the facility model (lib/facility.ts). These check that what it
// builds from a facility — clinics, queue letters, rooms, queue stations, beds, kiosks, buildings — is exactly what the
// facility says, for the sample hospital as shipped and after the Settings layout changed it; and that the app's own
// copy of the sample (used before the API's facility arrives) is the API's sample.
afterEach(() => useLayout(undefined));

test('the app ships the API\'s sample hospital (run `pnpm --filter api facility:sample` after changing it)', () => {
  const { version: _v, publishedAt: _p, ...web } = webSample();
  assert.deepEqual(JSON.parse(JSON.stringify(web)), JSON.parse(JSON.stringify(sampleFacility())));
});

const LAYOUTS: [string, Layout][] = [
  ['as shipped', {}],
  ['changed in Settings', { depts: [{ name: 'คลินิกโรคไต', level: 2 }, { name: 'คลินิกผิวหนัง', level: 4 }], names: { 'opd-3-0': 'ศัลยกรรมทั่วไป', 'opd-2-0': 'อายุรกรรม' },
    split: { 'opd-2': [2, 1, 1, 2] }, roomNames: { 'opd-201': 'ห้องตรวจพิเศษ' }, off: ['dept:ตา', 'room:opd-202', 'counter:pharmacy:3', 'screen:opd-3-0:2'] }],
];

for (const [what, layout] of LAYOUTS) test(`the facility model has the app's ids (${what})`, () => {
  useLayout(layout);
  const f = sampleFacility(layout);
  const point = new Map(f.points.map((p) => [p.id, p])), group = new Map(f.groups.map((g) => [g.id, g])), dept = new Map(f.departments.map((d) => [d.id, d]));

  // Clinics: the same keys, names, letters and exam rooms.
  for (const c of opdClinics()) {
    const d = dept.get(c.key);
    assert.ok(d, c.key);
    assert.equal(d.name, c.dept, c.key);
    assert.equal(d.queuePrefix, c.letter, c.key);
    assert.deepEqual(f.points.filter((p) => p.groupId === `exam:${c.key}`).map((p) => p.id), c.rooms.map((r) => `room:${r.id}`), c.key);
  }
  assert.equal(f.departments.filter((d) => d.type === 'clinic' && d.features.walkIn).length, opdClinics().length);

  // Every queue station, in its queue group, switched on / off the same.
  const stations = everyStation();
  for (const st of stations) {
    const p = point.get(st.id);
    assert.ok(p, st.id);
    assert.equal(p.groupId, st.group, st.id);
    assert.ok(group.get(st.group)!.steps.every((s) => (st.kinds as string[]).includes(s)), st.id);
  }
  const queueGroups = f.groups.filter((g) => g.steps.length && g.pointKind !== 'bed' && g.pointKind !== 'kiosk');
  assert.equal(f.points.filter((p) => queueGroups.some((g) => g.id === p.groupId)).length, stations.length, 'no stations the app does not have');
  const offIds = new Set(layout.off ?? []);
  for (const st of stations.filter((s) => offIds.has(s.id))) assert.equal(point.get(st.id)!.active, false, st.id);

  // Every room on every floor of every building, with its name.
  for (const b of buildings) for (const fl of buildingStats[b.id]?.floors ?? []) for (const r of floorRooms(b.id, fl.level)) {
    const p = point.get(r.pointId);
    assert.ok(p, r.id);
    assert.equal(p.name || `${group.get(p.groupId)!.pointNoun} ${p.number}`, r.name, r.id);
    assert.equal(f.groups.find((g) => g.id === p.groupId)!.floorId, `${b.id}-${fl.level}`, r.id);
    assert.equal(dept.get(group.get(p.groupId)!.departmentId)!.name, r.dept, r.id);
  }

  // Beds, ER beds, resuscitation bays, blood-draw stations, kiosks.
  for (const bed of wardBeds()) { const p = point.get(bed.id); assert.ok(p, bed.id); assert.equal(p.name, bed.bed, bed.id); assert.equal(dept.get(group.get(p.groupId)!.departmentId)!.name, bed.dept, bed.id); }
  for (const bed of erBedSpots()) assert.equal(point.get(bed.id)?.name, bed.name, bed.id);
  for (const bed of erResusSpots()) assert.equal(`${group.get(point.get(bed.id)!.groupId)!.pointNoun} ${point.get(bed.id)!.number}`, bed.name, bed.id);
  assert.equal(f.points.filter((p) => p.groupId === 'counter:lab').length, labStationSpots().length);
  for (const k of kiosks) { const p = point.get(k.id); assert.ok(p, k.id); assert.equal(p.name, k.name); assert.deepEqual(p.map, { x: k.x, z: k.z }); }

  // Buildings and floors as the map draws them.
  for (const b of buildings) {
    const m = f.buildings.find((x) => x.id === b.id);
    assert.ok(m, b.id);
    assert.deepEqual(m.map, { x: b.x, z: b.z, width: b.width, depth: b.depth, color: b.color });
    assert.equal(f.floors.filter((x) => x.buildingId === b.id).length, b.floors, b.id);
  }
});

test('a published facility reaches the map, the queue and the simulator at once', () => {
  const f = structuredClone(sampleFacility()) as ReturnType<typeof sampleFacility>;
  // A new building with one floor, a clinic on it (2 screening counters, 3 exam rooms, one switched off) and an extra
  // pharmacy counter on OPD floor 1; ห้องตา retired.
  f.buildings.push({ id: 'b_new', name: 'อาคารเฉลิมพระเกียรติ', shortName: 'อาคารใหม่', kind: 'opd', map: { x: -20, z: 20, width: 10, depth: 8, color: '#e8eef3' }, active: true });
  f.floors.push({ id: 'b_new-1', buildingId: 'b_new', level: 1, name: 'ชั้น 1', description: 'คลินิกโรคไต', active: true });
  f.departments.push({ id: 'd_kidney', name: 'คลินิกโรคไต', type: 'clinic', queuePrefix: 'K', features: { booking: true, appointments: true, walkIn: true }, firstGroupId: 'g_ks', active: true });
  f.groups.push({ id: 'g_ks', departmentId: 'd_kidney', name: 'ซักประวัติโรคไต', floorId: 'b_new-1', pointKind: 'counter', pointNoun: 'ช่องบริการ', steps: ['screening'], serves: 'department', minOpen: 1, active: true },
    { id: 'g_ke', departmentId: 'd_kidney', name: 'ห้องตรวจโรคไต', floorId: 'b_new-1', pointKind: 'room', pointNoun: 'ห้องตรวจ', steps: ['exam', 'followup'], serves: 'department', minOpen: 1, active: true });
  f.points.push({ id: 'p_ks1', groupId: 'g_ks', number: 1, active: true }, { id: 'p_ks2', groupId: 'g_ks', number: 2, active: true },
    { id: 'p_ke1', groupId: 'g_ke', number: 1, roomCode: '101', active: true }, { id: 'p_ke2', groupId: 'g_ke', number: 2, roomCode: '102', active: true },
    { id: 'p_ke3', groupId: 'g_ke', number: 3, roomCode: '103', active: false }, { id: 'p_rx4', groupId: 'counter:pharmacy', number: 4, active: true });
  f.departments.find((d) => d.id === 'opd-4-1')!.retiredAt = '2026-10-18T00:00:00.000Z';
  assert.equal(setFacility({ ...f, version: 9001, publishedAt: 'test-published' }), true);

  assert.ok(buildings.some((b) => b.id === 'b_new'), 'the new building is on the map');
  assert.deepEqual(buildingStats.b_new.floors.map((x) => x.depts), [['คลินิกโรคไต']]);
  assert.deepEqual(floorRooms('b_new', 1).map((r) => [r.id, r.name, r.number]), [['p_ke1', 'ห้องตรวจ 1', 101], ['p_ke2', 'ห้องตรวจ 2', 102], ['p_ke3', 'ห้องตรวจ 3', 103]], 'a new room goes by its point id, as the API names it');
  const kidney = opdClinics().find((c) => c.key === 'd_kidney')!;
  assert.equal(kidney.letter, 'K');
  assert.equal(kidney.buildingId, 'b_new');
  assert.equal(opdClinics().some((c) => c.key === 'opd-4-1'), false, 'a retired department is gone');
  const ids = allStations().map((s) => s.id);
  for (const id of ['p_ks1', 'p_ks2', 'p_ke1', 'p_ke2', 'p_rx4']) assert.ok(ids.includes(id), id);
  assert.equal(ids.includes('p_ke3'), false, 'a room switched off takes no queue');
  assert.equal(stationById('p_ks2')?.label, 'ซักประวัติโรคไต ช่องบริการ 2');
  assert.equal(DEFAULT_CAPACITY.pharmacy, 4);
  const day = generatePatients('facility-test');
  assert.ok(day.some((p) => p.clinicKey === 'd_kidney' && p.queue.startsWith('K')), 'the simulator sends patients to the new clinic');
  assert.ok(day.some((p) => p.steps.some((s) => s.stationId === 'p_rx4')), 'and to the new counter');
  assert.equal(day.some((p) => p.clinicKey === 'opd-4-1'), false);
});
