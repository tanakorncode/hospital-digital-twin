import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { realCounts } from '../lib/live-counts';
import { livePatients, opdClinics, type LiveVisit } from '../lib/patients';
import { buildingStatsAt, floorCountAt, isRealMode, kindPresence, setLiveData, setRealCounts } from '../lib/scene-data';

afterEach(() => { setRealCounts(null); setLiveData(null); });
const c = opdClinics()[0];
const visit = (id: string, arrival: number): LiveVisit => ({ id, queue: `A${id.slice(-3)}`, flow: 'opd', clinicKey: c.key, dept: c.dept, arrival, steps: [{ kind: 'screening', at: arrival }, { kind: 'exam', at: arrival }], status: 'active' });

test('live mode: floor counts are the real patients there; hours to come are unknown, not guessed', () => {
  const patients = livePatients([visit('v-0001', 600), visit('v-0002', 610), visit('v-0003', 700)], []);
  const now = 640; // 10:40 — two patients have arrived, the third comes at 11:40
  setRealCounts(realCounts(patients, now, []));
  assert.ok(isRealMode());
  assert.equal(floorCountAt('opd', c.level, 10), 2, 'both waiting at their clinic now');
  assert.equal(floorCountAt('opd', c.level, 9), 0, 'nobody had arrived at 09:30');
  assert.equal(floorCountAt('opd', c.level, 12), 0, 'the future is not invented');
  assert.equal(floorCountAt('er', 1, 10), 0);
  const st = buildingStatsAt('opd', 10)!;
  assert.equal(st.waiting, 2);
  assert.equal(st.avgWait, 35, '(40 + 30) / 2 minutes waited');
  assert.equal(kindPresence('opd', 10), 0, 'no simulated crowd walking about');
});

test('live mode ignores the demo occupancy feed, but an HIS feed still counts for its hour', () => {
  setRealCounts(realCounts([], 640, []));
  setLiveData({ hour: 10.5, floors: { 'opd:1': 999 }, servicePoints: {}, source: 'demo' });
  assert.equal(floorCountAt('opd', 1, 10), 0, 'demo feed not used');
  setLiveData({ hour: 10.5, floors: { 'opd:1': 37 }, servicePoints: {}, source: 'his-adapter' });
  assert.equal(floorCountAt('opd', 1, 10), 37, 'the HIS knows better for the current hour');
});

test('demo mode is untouched: the daily profile and the demo feed as before', () => {
  const before = floorCountAt('opd', 2, 10);
  assert.ok(before > 0);
  setLiveData({ hour: 10.5, floors: { 'opd:2': 123 }, servicePoints: {}, source: 'demo' });
  assert.equal(floorCountAt('opd', 2, 10), 123);
  assert.ok(kindPresence('opd', 10) > 0);
});
