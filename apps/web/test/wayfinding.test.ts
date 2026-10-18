import assert from 'node:assert/strict';
import { test } from 'node:test';
import { directions, directoryPlaces, type Destination } from '../lib/wayfinding';

const place = (o: Partial<Destination>): Destination => ({ code: 'X', nameTh: 'ที่ไหนสักแห่ง', buildingId: 'opd', level: 1, isPublic: true, status: 'ACTIVE', ...o });
const pharmacy = place({ code: 'OPD-1B', nameTh: 'ห้องยา', landmarkTh: 'ตรงข้ามลิฟต์' });
const eye = place({ code: 'OPD-4C', nameTh: 'ตา', level: 4 });
const lab = place({ code: 'DIAGNOSTICS-1A', nameTh: 'ห้องเจาะเลือด', buildingId: 'diagnostics', level: 1 });

test('directions: same floor, another floor, another building — lifts named, the landmark last', () => {
  assert.deepEqual(directions(place({ code: 'OPD-1A', nameTh: 'ลงทะเบียน' }), pharmacy), ['อยู่ชั้นเดียวกัน เดินตามทางเดินกลาง', 'ห้องยา · ตรงข้ามลิฟต์']);
  assert.deepEqual(directions(pharmacy, eye), ['ขึ้นลิฟต์หรือบันไดไปชั้น 4', 'ตา']);
  assert.deepEqual(directions(eye, lab), ['ใช้ลิฟต์หรือบันไดลงไปชั้น 1 ของอาคารผู้ป่วยนอก (OPD)', 'ออกไปทางอาคารศูนย์การแพทย์ ตามป้ายบอกทาง', 'ห้องเจาะเลือด']);
  assert.equal(directions(undefined, eye)[0], 'เริ่มจากทางเข้าหลัก อาคารผู้ป่วยนอก (OPD) ชั้น 1', 'no sign scanned: from the main entrance');
  assert.deepEqual(directions(eye, eye), ['คุณอยู่ที่นี่แล้ว']);
});

test('the department directory becomes one place per department per floor, each naming its department', () => {
  const list = directoryPlaces();
  assert.ok(list.length > 10);
  assert.ok(list.every((d) => d.departmentId), 'linked to the facility (the server makes the printable codes)');
  assert.equal(new Set(list.map((d) => `${d.departmentId}@${d.buildingId}:${d.level}`)).size, list.length, 'no department twice on a floor');
});
