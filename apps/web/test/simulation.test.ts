import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { fmtDur, fmtDurRange, generatePatients, opdClinics, patientAt } from '../lib/patients';
import { findDepts, findDoctors, setLayout, setServiceHours } from '../lib/scene-data';

afterEach(() => { setLayout(undefined); setServiceHours(undefined); });
const stations = (ps: ReturnType<typeof generatePatients>) => new Set(ps.flatMap((p) => p.steps.map((s) => s.stationId).filter(Boolean)));

test('the simulated day is deterministic (every screen sees the same patients)', () => {
  const a = generatePatients('demo-day'), b = generatePatients('demo-day');
  assert.ok(a.length > 400);
  assert.deepEqual(a.map((p) => [p.id, p.queue, p.arrival]), b.map((p) => [p.id, p.queue, p.arrival]));
});

test('every journey runs forward in time and stays inside the day', () => {
  for (const p of generatePatients('demo-day')) {
    let prev = p.arrival - 1e-6;
    for (const s of p.steps) {
      assert.ok(s.start <= s.called + 1e-9 && s.called <= s.end + 1e-9, `${p.id} ${s.kind}`);
      assert.ok(s.start >= prev - 1e-6, `${p.id} step order`);
      assert.ok(s.end <= 24 * 60);
      prev = s.start;
    }
  }
});

test('patientAt gives a state during the visit and nothing before arrival', () => {
  const p = generatePatients('demo-day').find((x) => x.flow === 'opd')!;
  assert.equal(patientAt(p, p.arrival - 5), null);
  const st = patientAt(p, p.steps[1].start + 0.5);
  assert.ok(st && st.index >= 1);
});

test('a room switched off in Settings gets no patients; other departments keep their queue numbers', () => {
  const before = generatePatients('demo-day');
  const room = opdClinics()[0].rooms[0];
  setLayout({ off: [`room:${room.id}`] });
  const after = generatePatients('demo-day');
  assert.ok(stations(before).has(`room:${room.id}`));
  assert.ok(!stations(after).has(`room:${room.id}`));
  const byId = new Map(before.map((p) => [p.id, p]));
  assert.ok(after.every((p) => byId.get(p.id)?.queue === p.queue));
});

test('a closed department has no patients and does not renumber the others', () => {
  const before = generatePatients('demo-day');
  setLayout({ off: ['dept:ตา'] });
  const after = generatePatients('demo-day');
  assert.ok(before.some((p) => p.dept === 'ตา'));
  assert.ok(!after.some((p) => p.dept === 'ตา'));
  const byId = new Map(before.map((p) => [p.id, p.queue]));
  assert.ok(after.every((p) => byId.get(p.id) === p.queue));
});

test('an added department gets rooms, a new letter and patients', () => {
  setLayout({ depts: [{ name: 'ผิวหนัง', level: 3 }] });
  const c = opdClinics().find((x) => x.dept === 'ผิวหนัง')!;
  assert.ok(c && c.rooms.length >= 1);
  assert.equal(c.letter, 'J', 'letters of existing clinics stay A–I');
  assert.ok(generatePatients('demo-day').some((p) => p.dept === 'ผิวหนัง' && p.queue.startsWith('J')));
});

test('service hours move the arrivals', () => {
  setServiceHours({ opdOpen: 9, opdClose: 17 });
  const opd = generatePatients('demo-day').filter((p) => p.flow === 'opd');
  assert.ok(Math.min(...opd.map((p) => p.arrival)) >= 7 * 60, 'nobody comes more than 2 h before opening');
});

test('durations read as hours and minutes', () => {
  assert.equal(fmtDur(45), '45 นาที');
  assert.equal(fmtDur(60), '1 ชม.');
  assert.equal(fmtDur(272), '4 ชม. 32 นาที');
  assert.equal(fmtDur(90, true), '1 ชม. 30 น.');
  assert.equal(fmtDurRange(10, 25), '10–25 นาที');
});

test('map search finds departments by name and doctors on duty', () => {
  const eye = findDepts('ตา');
  assert.equal(eye[0].name, 'ตา');
  assert.match(eye[0].place, /OPD ชั้น 4/);
  assert.ok(findDepts('เอกซเรย์').some((d) => d.name === 'รังสีวิทยา'));
  const docs = findDoctors('หมอวรรณา', 10);
  assert.ok(docs.length > 0);
  assert.ok(docs.every((d) => !(d.place.startsWith('OPD ชั้น 1'))), 'no clinics on OPD floor 1');
  assert.equal(findDoctors('x', 10).length, 0, 'needs at least two characters');
});
