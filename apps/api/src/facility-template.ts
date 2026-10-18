import type { Building, BuildingKind, Department, FacilityData, Floor, RoomKind, ServiceGroup, ServicePoint, Site, StepKind } from './facility-model';
import type { Layout } from './queue.service';

// The sample hospital: the facility every installation starts from, and what an existing installation is moved to
// the first time it runs with the facility model. It is the layout the system had before the model existed —
// apps/web/lib/scene-data.ts, patients.ts and queue.ts — with every id kept exactly (clinic keys `opd-2-0`, rooms
// `room:opd-201`, counters `screen:opd-2-0:2` / `counter:pharmacy:1`, beds `bed-1-0` / `er-101-A`, kiosks `k-main-1`), so
// bookings, appointments, doctor sessions, visits, QR signs, queue events and staff scopes keep pointing at the same
// places. The Settings "layout" (departments added, renamed, rooms shared out, rooms renamed, things switched off) is
// folded in. apps/web/test/facility-parity.test.ts checks the ids against the web's own lists.

type FloorSpec = { level: number; desc: string; depts: string[] };
const BUILDINGS: { id: string; name: string; shortName: string; kind: BuildingKind; x: number; z: number; width: number; depth: number; color: string; floors: FloorSpec[] }[] = [
  { id: 'opd', name: 'อาคารผู้ป่วยนอก (OPD)', shortName: 'OPD', kind: 'opd', x: -5, z: 2.5, width: 12, depth: 8, color: '#e8eef3', floors: [
    { level: 1, desc: 'ลงทะเบียน / ห้องยา', depts: ['ลงทะเบียน', 'ห้องยา', 'การเงิน'] },
    { level: 2, desc: 'ห้องตรวจอายุรกรรม', depts: ['อายุรกรรมทั่วไป', 'อายุรกรรมเฉพาะทาง', 'คลินิกเบาหวาน'] },
    { level: 3, desc: 'แผนกตรวจรักษา', depts: ['ศัลยกรรม', 'ออร์โธปิดิกส์', 'สูติ-นรีเวช'] },
    { level: 4, desc: 'พิเศษ / คลินิกเฉพาะทาง', depts: ['คลินิกพิเศษ', 'ตา', 'หู คอ จมูก'] }] },
  { id: 'inpatient', name: 'อาคารผู้ป่วยใน', shortName: 'อาคารผู้ป่วยใน', kind: 'inpatient', x: -4, z: -10, width: 10, depth: 5.5, color: '#eef2f5', floors: [
    { level: 1, desc: 'หอผู้ป่วยรับใหม่ / อายุรกรรมรวม', depts: ['หอผู้ป่วยรับใหม่', 'อายุรกรรมรวม'] },
    { level: 2, desc: 'หอผู้ป่วยเด็ก', depts: ['กุมารเวช', 'ทารกแรกเกิด'] },
    { level: 3, desc: 'หอผู้ป่วยอายุรกรรม', depts: ['อายุรกรรมชาย', 'อายุรกรรมหญิง'] },
    { level: 4, desc: 'หอผู้ป่วยศัลยกรรม', depts: ['ศัลยกรรมชาย', 'ศัลยกรรมหญิง'] },
    { level: 5, desc: 'หอผู้ป่วยพิเศษ', depts: ['หอพิเศษ A', 'หอพิเศษ B'] }] },
  { id: 'er', name: 'อาคารฉุกเฉิน', shortName: 'ER', kind: 'er', x: 7.5, z: -12, width: 7, depth: 6, color: '#eef1f4', floors: [
    { level: 1, desc: 'คัดแยก / ห้องฉุกเฉิน', depts: ['คัดแยก (Triage)', 'ห้องฉุกเฉิน', 'ห้องหัตถการ'] },
    { level: 2, desc: 'สังเกตอาการ', depts: ['สังเกตอาการ', 'ICU ฉุกเฉิน'] },
    { level: 3, desc: 'ห้องผ่าตัดฉุกเฉิน', depts: ['ห้องผ่าตัด', 'ห้องพักฟื้น'] }] },
  { id: 'diagnostics', name: 'อาคารศูนย์การแพทย์', shortName: 'ศูนย์การแพทย์', kind: 'diagnostics', x: 11, z: -3.5, width: 6.5, depth: 6.5, color: '#e9eef2', floors: [
    { level: 1, desc: 'ห้องปฏิบัติการ / เจาะเลือด', depts: ['ห้องปฏิบัติการ', 'ห้องเจาะเลือด'] },
    { level: 2, desc: 'รังสีวิทยา (เอกซเรย์)', depts: ['รังสีวิทยา'] },
    { level: 3, desc: 'ศูนย์หัวใจ', depts: ['ศูนย์หัวใจ', 'Echo / EKG'] }] },
  { id: 'support', name: 'อาคารสนับสนุน', shortName: 'อาคารสนับสนุน', kind: 'support', x: 14, z: 5, width: 7, depth: 5, color: '#e4e9ed', floors: [
    { level: 1, desc: 'คลังพัสดุ / ซักฟอก', depts: ['คลังพัสดุ', 'ซักฟอก', 'โรงครัว'] },
    { level: 2, desc: 'สำนักงาน / IT', depts: ['สำนักงาน', 'ศูนย์ IT'] }] },
];
// Shared counters (every department's patients): department, step, group name, what a point is called, how many.
const COUNTERS: { dept: string; kind: StepKind; name: string; noun: string; n: number }[] = [
  { dept: 'opd-1-0', kind: 'registration', name: 'ช่องลงทะเบียน', noun: 'ช่องลงทะเบียน', n: 5 },
  { dept: 'opd-1-1', kind: 'pharmacy', name: 'ช่องจ่ายยา', noun: 'ช่องจ่ายยา', n: 3 },
  { dept: 'opd-1-2', kind: 'finance', name: 'ช่องการเงิน', noun: 'ช่องการเงิน', n: 4 },
  { dept: 'diagnostics-1-1', kind: 'lab', name: 'จุดเจาะเลือด', noun: 'จุดเจาะเลือด', n: 3 },
  { dept: 'er-1-0', kind: 'triage', name: 'จุดคัดแยก', noun: 'จุดคัดแยก', n: 1 },
];
const SCREENING_PER_CLINIC = 2, BEDS_PER_FLOOR = 16;
const KIOSKS: { id: string; name: string; x: number; z: number; floorId?: string }[] = [
  { id: 'k-main-1', name: 'Kiosk ทางเข้าหลัก 1', x: -10.0, z: 7.0 },
  { id: 'k-main-2', name: 'Kiosk ทางเข้าหลัก 2', x: -6.3, z: 7.0 },
  { id: 'k-opd-lobby', name: 'Kiosk โถง OPD ชั้น 1', x: -8.2, z: 3.2, floorId: 'opd-1' },
  { id: 'k-er', name: 'Kiosk หน้าห้องฉุกเฉิน', x: 10.3, z: -8.82 },
  { id: 'k-dx', name: 'Kiosk ศูนย์การแพทย์', x: 12.9, z: 0.2 },
];
export const SAMPLE_SITE: Site = {
  roads: [[-80, 8, 80, 10], [1.9, -80, 3.7, 80], [-80, -5.3, 1.9, -3.7], [3.7, -8.6, 80, -7.2], [-15, -80, -13.2, 80], [20.2, -80, 22, 80]],
  parking: [[-1, 11.2, 11, 17.4], [-24, 11.2, -16.5, 17.4]],
  plazas: [[-12.4, 10.6, -5.5, 16]],
  flows: [
    { id: 'flow-entry', name: 'มาถึง → ทางเข้า OPD', color: '#2563eb', kind: 'opd', points: [[-17, 9.4], [-12.5, 9.4], [-9.5, 7.2]] },
    { id: 'flow-er', name: 'ไปห้องฉุกเฉิน (ER)', color: '#e0368c', kind: 'er', points: [[-11, 13], [-11, 8.6], [-1, 8.6], [2.8, 8.6], [2.8, -5], [2.8, -8.5], [5, -8.5]] },
    { id: 'flow-ipd', name: 'OPD → รับเป็นผู้ป่วยใน', color: '#8b4fe6', kind: 'inpatient', points: [[-3, -1.6], [-3, -5.6], [-1, -5.6], [-1, -7.2]] },
    { id: 'flow-dx', name: 'OPD → ส่งตรวจแล็บ / เอกซเรย์', color: '#0aa5c2', kind: 'diagnostics', points: [[1, 0.5], [2.2, 0.5], [3.6, -0.4], [7.6, -0.4]] },
    { id: 'flow-support', name: 'ศูนย์การแพทย์ → อาคารสนับสนุน', color: '#475569', kind: 'support', points: [[14.2, -0.8], [14.2, 2.4]] }],
  fillers: [
    { id: 'f1', x: -21, z: -9, width: 6, depth: 5, floors: 3, color: '#e6ebef' }, { id: 'f2', x: -22, z: 1, width: 5, depth: 6, floors: 2, color: '#e9edf1' },
    { id: 'f3', x: -6, z: -25, width: 9, depth: 5, floors: 4, color: '#e6ebef' }, { id: 'f4', x: 9, z: -24, width: 7, depth: 6, floors: 3, color: '#e9edf1' },
    { id: 'f5', x: 16, z: -15.5, width: 5, depth: 5, floors: 2, color: '#e4e9ed' }, { id: 'f6', x: 29, z: -6, width: 6, depth: 5, floors: 3, color: '#e9edf1' },
    { id: 'f7', x: 28, z: 3, width: 5, depth: 6, floors: 2, color: '#e6ebef' }, { id: 'f8', x: -30, z: -20, width: 7, depth: 5, floors: 3, color: '#e9edf1' },
    { id: 'f9', x: -4, z: -36, width: 8, depth: 5, floors: 3, color: '#e6ebef' }],
};

const deptId = (b: string, level: number, i: number) => (b === 'er' && level === 1 && i === 1 ? 'er' : `${b}-${level}-${i}`);
const deptType = (kind: BuildingKind, level: number, name: string): Department['type'] =>
  kind === 'opd' ? (level === 1 ? 'service' : 'clinic') : kind === 'inpatient' ? 'ward' : kind === 'er' ? (level === 1 ? 'emergency' : 'ward')
  : kind === 'diagnostics' ? (name === 'ห้องเจาะเลือด' || name === 'รังสีวิทยา' ? 'service' : 'diagnostic') : 'support';
// Rooms along the back wall of every floor, as many as the building is wide, shared out between the floor's departments.
const roomsPerFloor = (width: number) => Math.max(3, Math.round(width / 2));
function roomLook(kind: BuildingKind, level: number, k: number): { kind: RoomKind; title: string } {
  if (kind === 'opd') return { kind: 'exam', title: 'ห้องตรวจ' };
  if (kind === 'er') return { kind: 'treatment', title: 'ห้องรักษา' };
  if (kind === 'inpatient') return { kind: 'ward', title: 'ห้องพัก' };
  if (kind === 'support') return { kind: 'office', title: 'สำนักงาน' };
  if (level === 1) return { kind: 'lab', title: 'ห้องปฏิบัติการ' };
  if (level === 2) return { kind: 'scan', title: 'ห้องเอกซเรย์' };
  return k % 2 === 0 ? { kind: 'scan', title: 'ห้องสแกน' } : { kind: 'exam', title: 'ห้องตรวจ' };
}
const groupNameOf = (prefix: string, dept: string) => (dept.startsWith(prefix) ? dept : `${prefix} ${dept}`);

// The sample hospital with a Settings layout folded in (none = as shipped).
export function sampleFacility(layout: Layout = {}): FacilityData {
  const off = new Set(layout.off ?? []), names = layout.names ?? {}, split = layout.split ?? {}, roomNames = layout.roomNames ?? {};
  const buildings: Building[] = [], floors: Floor[] = [], departments: Department[] = [], groups: ServiceGroup[] = [], points: ServicePoint[] = [];
  const clinics: { dept: Department; custom: boolean }[] = [];
  const usedNames = new Set<string>();
  const uniqueName = (name: string, where: string) => { const n = usedNames.has(name) ? `${name} (${where})` : name; usedNames.add(n); return n; };
  const point = (p: Omit<ServicePoint, 'active'>) => { points.push({ ...p, active: !off.has(p.id) }); };

  for (const b of BUILDINGS) {
    buildings.push({ id: b.id, name: b.name, shortName: b.shortName, kind: b.kind, map: { x: b.x, z: b.z, width: b.width, depth: b.depth, color: b.color }, active: true });
    for (const f of b.floors) {
      const floorId = `${b.id}-${f.level}`;
      floors.push({ id: floorId, buildingId: b.id, level: f.level, name: `ชั้น ${f.level}`, description: f.desc, active: true });
      const custom = b.id === 'opd' && f.level >= 2 ? (layout.depts ?? []).filter((d) => d.level === f.level).map((d) => d.name.trim()) : [];
      const deptNames = [...f.depts.map((n, i) => (b.id === 'opd' ? names[`opd-${f.level}-${i}`]?.trim() || n : n)), ...custom];
      // Rooms: as shared out in Settings (only while that still fits the floor), else in even bands.
      const n = roomsPerFloor(b.width), s = split[`${b.id}-${f.level}`];
      const fits = s && s.length === deptNames.length && s.every((x) => x >= 1) && s.reduce((a, x) => a + x, 0) === n;
      const roomDept = (k: number) => fits ? s!.findIndex((_, i) => k < s!.slice(0, i + 1).reduce((a, x) => a + x, 0)) : Math.min(deptNames.length - 1, Math.floor(((k + 0.5) / n) * deptNames.length));
      const rooms = Array.from({ length: n }, (_, k) => ({ k, number: f.level * 100 + k + 1, dept: roomDept(k), ...roomLook(b.kind, f.level, k) }));

      deptNames.forEach((rawName, i) => {
        const id = deptId(b.id, f.level, i), type = deptType(b.kind, f.level, f.depts[i] ?? rawName), mine = rooms.filter((r) => r.dept === i);
        const name = uniqueName(rawName, `${b.name} ชั้น ${f.level}`);
        const dept: Department = { id, name, type, features: { booking: false, appointments: false, walkIn: false }, active: !off.has(`dept:${rawName}`) };
        departments.push(dept);
        const group = (g: Omit<ServiceGroup, 'departmentId' | 'active' | 'serves' | 'minOpen' | 'floorId'> & Partial<Pick<ServiceGroup, 'serves' | 'minOpen' | 'floorId'>>) =>
          groups.push({ departmentId: id, floorId, serves: 'department', minOpen: 0, active: true, ...g });

        if (type === 'clinic') {
          if (mine.length) {
            clinics.push({ dept, custom: i >= f.depts.length });
            dept.features = { booking: true, appointments: true, walkIn: true };
            dept.firstGroupId = `screening:${id}`;
            // Screening counters: the busiest clinics (by their name today) have one more nurse.
            const nScreen = Math.max(1, SCREENING_PER_CLINIC + (rawName === 'ศัลยกรรม' || rawName === 'อายุรกรรมทั่วไป' ? 1 : 0));
            group({ id: `screening:${id}`, name: `ซักประวัติ${name}`, pointKind: 'counter', pointNoun: 'ช่องบริการ', steps: ['screening'], minOpen: 1 });
            for (let c = 0; c < nScreen; c++) point({ id: c === 0 ? `screen:${id}` : `screen:${id}:${c + 1}`, groupId: `screening:${id}`, number: c + 1 });
            group({ id: `exam:${id}`, name: `ห้องตรวจ${name}`, pointKind: 'room', pointNoun: 'ห้องตรวจ', steps: ['exam', 'followup'], minOpen: 1 });
            for (const r of mine) { const rid = `${b.id}-${r.number}`;
              point({ id: `room:${rid}`, groupId: `exam:${id}`, number: r.number, roomCode: String(r.number), roomKind: r.kind, ...(roomNames[rid]?.trim() ? { name: roomNames[rid].trim() } : {}) }); }
          }
          return;
        }
        // Every other department: its counters / beds, and its rooms along the back wall.
        for (const c of COUNTERS.filter((x) => x.dept === id)) {
          group({ id: `counter:${c.kind}`, name: c.name, pointKind: 'counter', pointNoun: c.noun, steps: [c.kind], serves: c.kind === 'triage' ? 'department' : 'all', minOpen: 1,
            ...(c.kind === 'lab' ? { options: { arrange: 'booths' as const } } : {}) });
          for (let k = 0; k < c.n; k++) point({ id: `counter:${c.kind}:${k + 1}`, groupId: `counter:${c.kind}`, number: k + 1 });
        }
        if (b.id === 'diagnostics' && f.level === 2) {
          // The x-ray rooms are the x-ray queue's stations.
          group({ id: 'counter:xray', name: 'ห้องเอกซเรย์', pointKind: 'room', pointNoun: 'ห้องเอกซเรย์', steps: ['xray'], serves: 'all', minOpen: 1 });
          mine.forEach((r, k) => point({ id: `counter:xray:${k + 1}`, groupId: 'counter:xray', number: r.number, roomCode: String(r.number), roomKind: r.kind }));
        } else if (mine.length) {
          const gid = `rooms:${id}`, noun = mine[0].title;
          group({ id: gid, name: groupNameOf('ห้อง', name), pointKind: 'room', pointNoun: noun, steps: [] });
          for (const r of mine) point({ id: `room:${b.id}-${r.number}`, groupId: gid, number: r.number, roomCode: String(r.number), roomKind: r.kind, ...(r.title !== noun ? { name: `${r.title} ${r.number}` } : {}) });
        }
        if (id === 'er') {
          dept.queuePrefix = 'ER';
          dept.features = { booking: false, appointments: false, walkIn: true };
          dept.firstGroupId = 'counter:triage';
          // Two treatment beds in every treatment room of the floor.
          group({ id: 'beds:er', name: 'เตียงรักษา ER', pointKind: 'bed', pointNoun: 'เตียง', steps: ['treatment'], options: { triage: [3, 5] } });
          rooms.flatMap((r) => [0, 1].map((side) => ({ r, side }))).forEach(({ r, side }, k) => {
            const tag = `${r.number}-${side ? 'B' : 'A'}`;
            point({ id: `er-${tag}`, groupId: 'beds:er', number: k + 1, name: `เตียง ER ${tag}`, inRoomId: `room:er-${r.number}` });
          });
        }
        if (id === 'er-1-2') {
          group({ id: 'beds:er-resus', name: 'เตียงกู้ชีพ', pointKind: 'bed', pointNoun: 'เตียงกู้ชีพ', steps: ['treatment'], options: { triage: [1, 2] } });
          [1, 2].forEach((k) => point({ id: `er-resus-${k}`, groupId: 'beds:er-resus', number: k }));
        }
      });

      if (b.kind === 'inpatient') {
        // Two beds in each room along the back wall, the rest in a row in the open ward at the front.
        const inRooms = rooms.flatMap((r) => [0, 1].map((side) => ({ r, side }))).slice(0, BEDS_PER_FLOOR), wardCount = BEDS_PER_FLOOR - inRooms.length;
        const beds = Array.from({ length: BEDS_PER_FLOOR }, (_, i) => {
          if (i < inRooms.length) { const { r, side } = inRooms[i]; return { i, dept: r.dept, name: `${r.number}-${side ? 'B' : 'A'}`, room: `room:${b.id}-${r.number}` }; }
          const j = i - inRooms.length;
          return { i, dept: Math.min(deptNames.length - 1, Math.floor((j / wardCount) * deptNames.length)), name: `${f.level}W-${j + 1}`, room: undefined };
        });
        deptNames.forEach((name, d) => {
          const mine = beds.filter((x) => x.dept === d), gid = `beds:${deptId(b.id, f.level, d)}`;
          if (!mine.length) return;
          groups.push({ id: gid, departmentId: deptId(b.id, f.level, d), name: groupNameOf('เตียง', departments.find((x) => x.id === deptId(b.id, f.level, d))!.name), floorId,
            pointKind: 'bed', pointNoun: 'เตียง', steps: ['ward'], serves: 'department', minOpen: 0, active: true });
          mine.forEach((x, k) => point({ id: `bed-${f.level}-${x.i}`, groupId: gid, number: k + 1, name: x.name, ...(x.room ? { inRoomId: x.room } : {}) }));
        });
      }
    }
  }
  // Queue letters: the clinics as shipped first (A, B, C … by floor), departments added in Settings after them.
  [...clinics.filter((c) => !c.custom), ...clinics.filter((c) => c.custom)].forEach((c, i) => { c.dept.queuePrefix = String.fromCharCode(65 + i); });
  // Queue-ticket kiosks: at the registration department, where they stand on the site.
  groups.push({ id: 'kiosks', departmentId: 'opd-1-0', name: 'ตู้ออกบัตรคิว', floorId: null, pointKind: 'kiosk', pointNoun: 'ตู้คิว', steps: ['kiosk'], serves: 'all', minOpen: 0, active: true });
  KIOSKS.forEach((k, i) => point({ id: k.id, groupId: 'kiosks', number: i + 1, name: k.name, map: { x: k.x, z: k.z }, ...(k.floorId ? { floorId: k.floorId } : {}) }));

  // Order: departments as the floors list them (bottom floor first); groups and points follow their department.
  const order = new Map(departments.map((d, i) => [d.id, i]));
  const gOrder = new Map(groups.map((g, i) => [g.id, (order.get(g.departmentId) ?? 0) * 1000 + i]));
  groups.sort((a, b) => gOrder.get(a.id)! - gOrder.get(b.id)!);
  const pg = new Map(groups.map((g, i) => [g.id, i]));
  points.sort((a, b) => pg.get(a.groupId)! - pg.get(b.groupId)! || a.number - b.number);
  return { buildings, floors, departments, groups, points, site: structuredClone(SAMPLE_SITE) };
}
