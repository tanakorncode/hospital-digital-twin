import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { sampleFacility } from '../../api/src/facility-template';
import { erBedSpots, erResusSpots, labStationSpots, opdClinics, wardBeds } from '../lib/patients';
import { everyStation } from '../lib/queue';
import { buildingStats, buildings, floorRooms, kiosks, setLayout, type Layout } from '../lib/scene-data';

// The API's facility model starts from the sample hospital (apps/api/src/facility-template.ts). It must hold exactly
// the ids this app already makes from its own constants and the Settings layout — clinic keys, queue letters, rooms,
// queue stations, beds, kiosks — or bookings, appointments, doctor sessions, visits and queue events would lose their place.
afterEach(() => setLayout(undefined));

const LAYOUTS: [string, Layout][] = [
  ['as shipped', {}],
  ['changed in Settings', { depts: [{ name: 'คลินิกโรคไต', level: 2 }, { name: 'คลินิกผิวหนัง', level: 4 }], names: { 'opd-3-0': 'ศัลยกรรมทั่วไป', 'opd-2-0': 'อายุรกรรม' },
    split: { 'opd-2': [2, 1, 1, 2] }, roomNames: { 'opd-201': 'ห้องตรวจพิเศษ' }, off: ['dept:ตา', 'room:opd-202', 'counter:pharmacy:3', 'screen:opd-3-0:2'] }],
];

for (const [what, layout] of LAYOUTS) test(`the facility model has the app's ids (${what})`, () => {
  setLayout(layout);
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
    const p = point.get(`room:${r.id}`) ?? f.points.find((x) => x.groupId === 'counter:xray' && x.roomCode === String(r.number));
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
