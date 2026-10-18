import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { opdClinics } from '../lib/patients';
import { floorRooms } from '../lib/scene-data';
import { useLayout } from './facility-helpers';

// Settings → แผนกและจุดบริการ: renamed departments, exam rooms shared out by hand, and room names reach the layout every
// screen uses — while clinic keys and room ids stay the same.
afterEach(() => useLayout(undefined));

test('a renamed department keeps its clinic key; rooms follow the split; room names show', () => {
  const before = opdClinics().find((c) => c.key === 'opd-2-0')!;
  assert.deepEqual(before.rooms.map((r) => r.id), ['opd-201', 'opd-202']);
  useLayout({ names: { 'opd-2-0': 'อายุรกรรม 1' }, split: { 'opd-2': [3, 2, 1] }, roomNames: { 'opd-203': 'ห้องตรวจพิเศษ' } });
  const after = opdClinics().filter((c) => c.level === 2);
  assert.equal(after[0].key, 'opd-2-0');
  assert.equal(after[0].dept, 'อายุรกรรม 1');
  assert.deepEqual(after.map((c) => c.rooms.length), [3, 2, 1]);
  assert.deepEqual(after[0].rooms.map((r) => r.id), ['opd-201', 'opd-202', 'opd-203']);
  assert.equal(floorRooms('opd', 2)[2].name, 'ห้องตรวจพิเศษ');
  assert.equal(floorRooms('opd', 2)[3].name, 'ห้องตรวจ 204', 'others keep their name');
});

test('a split that no longer fits the floor (a department added) falls back to the even split', () => {
  useLayout({ split: { 'opd-2': [3, 2, 1] }, depts: [{ name: 'ผิวหนัง', level: 2 }] });
  const floor = opdClinics().filter((c) => c.level === 2);
  assert.equal(floor.length, 4);
  assert.ok(floor.every((c) => c.rooms.length >= 1));
  assert.equal(floor.reduce((a, c) => a + c.rooms.length, 0), 6);
});
