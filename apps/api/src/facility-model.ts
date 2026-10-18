// The hospital's facility model (docs/FACILITY-MODEL-DESIGN.md): one data set that every screen and service reads.
// Two axes meet at the service group — place (building › floor) and unit (department):
//   Building ─ Floor                         where things are
//   Department (not tied to a floor)         who: name, queue letter, booking / appointments, staff scope, reports
//    └─ Service group @ floor               one step, one queue: "ห้องตรวจศัลยกรรม", "ซักประวัติศัลยกรรม", "ช่องจ่ายยา"
//        └─ Service point (= queue station)  "ห้องตรวจ 1", "ช่องบริการ 2", "เตียง 3" — may sit on another floor
// Ids are stable: made once when a thing is added, never derived from its position, so renaming / moving / reordering
// keeps every booking, appointment, doctor session, QR sign and queue event pointing at the same place.
// Arrays are in display order. Retired things stay in the data (history still reads them) but are not used.

export type BuildingKind = 'opd' | 'er' | 'inpatient' | 'diagnostics' | 'support' | 'other';
export type DepartmentType = 'clinic' | 'ward' | 'emergency' | 'diagnostic' | 'service' | 'support';
export type PointKind = 'room' | 'counter' | 'bed' | 'kiosk';
export type RoomKind = 'exam' | 'scan' | 'treatment' | 'ward' | 'office' | 'lab';
// The visit steps a group serves (mirrors StepKind in apps/web/lib/patients.ts).
export const STEP_KINDS = ['kiosk', 'registration', 'screening', 'exam', 'lab', 'labResult', 'xray', 'followup', 'pharmacy', 'finance', 'triage', 'treatment', 'admit', 'ward', 'leave'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export type MapBox = { x: number; z: number; width: number; depth: number; color: string };
export type Building = { id: string; name: string; shortName: string; kind: BuildingKind; map: MapBox; active: boolean; retiredAt?: string };
// level: 1, 2 … (the hospital has no basement; the map draws floors from 1 up) · name is what signs show ("ชั้น 2", editable).
export type Floor = { id: string; buildingId: string; level: number; name: string; description: string; layout?: FloorLayout; active: boolean; retiredAt?: string };
// How a floor is set out (apps/web/lib/floor-layout.ts draws it; nothing set = automatic). Coordinates are metres-ish
// map units from the building's centre: x across (−width/2 … width/2), z from the back wall (−depth/2) to the front.
//   automatic: rooms along the back wall, a corridor, one waiting area per department at the front —
//     roomDepth: share of the depth the rooms take · bandOrder / roomOrder: left → right (department / point ids; the
//     rest follow in their usual order) · bandWeights / roomWeights: relative widths (1 = the usual share)
//   manual: every room and waiting area where it was put (rooms: point id → rectangle + the wall its door is in;
//     areas: department id → rectangle); anything not placed yet stands where the automatic layout puts it.
//   background: a floor-plan picture (facility image id) laid under the plan, stretched over x0…x1 × z0…z1.
export type FloorRect = { x0: number; z0: number; x1: number; z1: number };
export type DoorSide = 'n' | 's' | 'e' | 'w';
export type FloorLayout = { mode?: 'auto' | 'manual'; roomDepth?: number; bandOrder?: string[]; bandWeights?: Record<string, number>; roomOrder?: string[];
  roomWeights?: Record<string, number>; rooms?: Record<string, FloorRect & { door: DoorSide }>; areas?: Record<string, FloorRect>;
  background?: FloorRect & { imageId: string; opacity: number } };
export type Features = { booking: boolean; appointments: boolean; walkIn: boolean };
// queuePrefix: the letter(s) of the department's queue numbers (unique). firstGroupId: where a patient waits after
// registering / checking in (the department's first step).
export type Department = { id: string; name: string; shortName?: string; type: DepartmentType; queuePrefix?: string; features: Features;
  firstGroupId?: string; active: boolean; retiredAt?: string };
// pointNoun: what the group's points are called — ห้องตรวจ · ห้อง · ช่องบริการ · ช่อง · เตียง · จุด · โต๊ะ … (a point
// without its own name is "<pointNoun> <number>"). serves: this department's patients, or everyone (shared counters).
// floorId null = outdoors on the site (kiosks at the gate). minOpen: open points the group needs while the department is open.
// options.arrange: counters as one long counter (staff side by side, the default) or separate booths spread across the
// area · options.triage: the ER triage levels [from, to] a treatment group takes (resuscitation bays: [1, 2]) ·
// options.seats: waiting chairs for the group's patients (0 = none; not set = as the building type usually has).
export type GroupOptions = { arrange?: 'counter' | 'booths'; triage?: [number, number]; seats?: number };
export type ServiceGroup = { id: string; departmentId: string; name: string; floorId: string | null; pointKind: PointKind; pointNoun: string;
  steps: StepKind[]; serves: 'department' | 'all'; minOpen: number; options?: GroupOptions; active: boolean; retiredAt?: string };
// roomCode: the number on the door (announcements, signs). floorId: only when the point is on another floor than its
// group. inRoomId: a bed inside a room. map: a fixed spot (kiosks; drag-to-place later) — none = laid out automatically.
export type ServicePoint = { id: string; groupId: string; number: number; name?: string; roomCode?: string; floorId?: string; roomKind?: RoomKind;
  inRoomId?: string; map?: { x: number; z: number }; active: boolean; retiredAt?: string };
// Scenery around the buildings: roads, car parks, paved plazas (besides the one around each building), unlabelled
// neighbouring blocks, and the walking routes the map draws (kind = the building type whose hours the route follows).
export type Rect = [number, number, number, number];
export type Flow = { id: string; name: string; color: string; kind: BuildingKind; points: [number, number][] };
export type Site = { roads: Rect[]; parking: Rect[]; plazas?: Rect[]; fillers: { id: string; x: number; z: number; width: number; depth: number; floors: number; color: string }[]; flows?: Flow[] };

export type FacilityData = { buildings: Building[]; floors: Floor[]; departments: Department[]; groups: ServiceGroup[]; points: ServicePoint[]; site: Site };
export type Facility = FacilityData & { version: number; publishedAt: string };

// ---- Lookups --------------------------------------------------------------------------------------------------
export type FacilityIndex = {
  data: FacilityData;
  building: Map<string, Building>; floor: Map<string, Floor>; department: Map<string, Department>; group: Map<string, ServiceGroup>; point: Map<string, ServicePoint>;
  groupsOf: Map<string, ServiceGroup[]>; pointsOf: Map<string, ServicePoint[]>;
};
export function indexFacility(data: FacilityData): FacilityIndex {
  const by = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));
  const groupsOf = new Map<string, ServiceGroup[]>(), pointsOf = new Map<string, ServicePoint[]>();
  for (const g of data.groups) groupsOf.set(g.departmentId, [...(groupsOf.get(g.departmentId) ?? []), g]);
  for (const p of data.points) pointsOf.set(p.groupId, [...(pointsOf.get(p.groupId) ?? []), p]);
  return { data, building: by(data.buildings), floor: by(data.floors), department: by(data.departments), group: by(data.groups), point: by(data.points), groupsOf, pointsOf };
}
// In use: switched on, not retired, and everything above it is too.
export const usable = (x: { active: boolean; retiredAt?: string } | undefined) => !!x && x.active && !x.retiredAt;
export function floorInUse(ix: FacilityIndex, floorId: string | null | undefined): boolean {
  if (!floorId) return true; // outdoors
  const f = ix.floor.get(floorId);
  return usable(f) && usable(ix.building.get(f!.buildingId));
}
export function departmentInUse(ix: FacilityIndex, id: string): boolean { return usable(ix.department.get(id)); }
export function groupInUse(ix: FacilityIndex, id: string): boolean {
  const g = ix.group.get(id);
  return usable(g) && departmentInUse(ix, g!.departmentId) && floorInUse(ix, g!.floorId);
}
export function pointInUse(ix: FacilityIndex, id: string): boolean {
  const p = ix.point.get(id);
  return usable(p) && groupInUse(ix, p!.groupId) && floorInUse(ix, p!.floorId);
}
// A room as other records name it: existing rooms by their room id ("opd-201" for the point "room:opd-201"), any
// other point by its own id.
export const roomRef = (p: ServicePoint) => (p.id.startsWith('room:') ? p.id.slice(5) : p.id);
export const pointByRoomRef = (ix: FacilityIndex, ref: string) => ix.point.get(ref) ?? ix.point.get(`room:${ref}`);
// The name patients read: the point's own name, else "<noun> <number>".
export const pointName = (ix: FacilityIndex, p: ServicePoint) => p.name || `${ix.group.get(p.groupId)?.pointNoun ?? 'จุดบริการ'} ${p.number}`;
// The rooms a department's doctors can sit in: room points of its groups that serve the exam step.
export function doctorRooms(ix: FacilityIndex, departmentId: string): ServicePoint[] {
  return (ix.groupsOf.get(departmentId) ?? []).filter((g) => g.pointKind === 'room' && g.steps.includes('exam')).flatMap((g) => ix.pointsOf.get(g.id) ?? []);
}
// A queue station as patients read it on a sign or in a LINE message: the point's own name, or "<noun> <number>" — a
// counter with the group's name in front when the noun alone does not say where ("ห้องตรวจ 302", "ช่องจ่ายยา 2",
// "ซักประวัติศัลยกรรม ช่องบริการ 2"); rooms and beds go by their sign.
export function stationLabel(ix: FacilityIndex, id: string): string | undefined {
  const p = ix.point.get(id), g = p && ix.group.get(p.groupId);
  if (!p || !g) return undefined;
  if (p.name) return p.name;
  return g.pointKind !== 'counter' || g.name.includes(g.pointNoun) ? `${g.pointNoun} ${p.number}` : `${g.name} ${g.pointNoun} ${p.number}`;
}
export const departmentOfPoint = (ix: FacilityIndex, p: ServicePoint) => ix.group.get(p.groupId)?.departmentId;

// ---- Validation -----------------------------------------------------------------------------------------------
// An issue: `error` blocks publishing, `warning` is shown before it. `at` = the id it is about.
export type Issue = { level: 'error' | 'warning'; at?: string; message: string };
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
const PREFIX_RE = /^[A-Z]{1,3}$/;
const BUILDING_KINDS: BuildingKind[] = ['opd', 'er', 'inpatient', 'diagnostics', 'support', 'other'];
const DEPT_TYPES: DepartmentType[] = ['clinic', 'ward', 'emergency', 'diagnostic', 'service', 'support'];
const POINT_KINDS: PointKind[] = ['room', 'counter', 'bed', 'kiosk'];
const ROOM_KINDS: RoomKind[] = ['exam', 'scan', 'treatment', 'ward', 'office', 'lab'];
export const LIMITS = { buildings: 40, floors: 400, departments: 400, groups: 1500, points: 8000, name: 60, noun: 20, roads: 60, fillers: 60 };
const isStr = (v: unknown, max: number, empty = false): v is string => typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0);
const isNum = (v: unknown, lo = -1e4, hi = 1e4): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isRetired = (v: unknown) => v === undefined || (typeof v === 'string' && v.length <= 40);
const isColor = (v: unknown) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const isRect = (r: unknown) => Array.isArray(r) && r.length === 4 && r.every((n) => isNum(n, -500, 500));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const LAYOUT_KEYS = ['mode', 'roomDepth', 'bandOrder', 'bandWeights', 'roomOrder', 'roomWeights', 'rooms', 'areas', 'background'];
// A floor's layout: its shape, and every rectangle inside the building (min 0.8 across). Unknown ids are left alone —
// a department or room taken out of the draft must not make the floor unpublishable; the layout just skips it.
function layoutProblem(l: unknown, w: number, d: number): string | undefined {
  if (!isObj(l) || Object.keys(l).some((k) => !LAYOUT_KEYS.includes(k))) return 'การจัดผังชั้นไม่ถูกต้อง';
  const ids = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= 400 && v.every((x) => typeof x === 'string' && ID_RE.test(x)));
  const weights = (v: unknown) => v === undefined || (isObj(v) && Object.keys(v).length <= 400 && Object.entries(v).every(([k, n]) => ID_RE.test(k) && isNum(n, 0.2, 10)));
  const e = 1e-6, inside = (r: unknown) => isObj(r) && isNum(r.x0) && isNum(r.x1) && isNum(r.z0) && isNum(r.z1)
    && r.x1 - r.x0 >= 0.8 - e && r.z1 - r.z0 >= 0.8 - e && r.x0 >= -w / 2 - e && r.x1 <= w / 2 + e && r.z0 >= -d / 2 - e && r.z1 <= d / 2 + e;
  const rects = (v: unknown, door: boolean) => v === undefined || (isObj(v) && Object.keys(v).length <= 400
    && Object.entries(v).every(([k, r]) => ID_RE.test(k) && inside(r) && (!door || ['n', 's', 'e', 'w'].includes((r as { door?: string }).door ?? ''))));
  if (l.mode !== undefined && l.mode !== 'auto' && l.mode !== 'manual') return 'การจัดผังชั้นไม่ถูกต้อง';
  if (l.roomDepth !== undefined && !isNum(l.roomDepth, 0.2, 0.7)) return 'ความลึกของแถวห้องต้องอยู่ระหว่าง 20–70% ของความลึกอาคาร';
  if (!ids(l.bandOrder) || !ids(l.roomOrder) || !weights(l.bandWeights) || !weights(l.roomWeights)) return 'ลำดับ/สัดส่วนความกว้างในผังชั้นไม่ถูกต้อง';
  if (!rects(l.rooms, true) || !rects(l.areas, false)) return 'ห้องหรือพื้นที่รอต้องอยู่ในอาคาร และกว้างอย่างน้อย 0.8';
  const bg = l.background;
  if (bg !== undefined && !(isObj(bg) && typeof bg.imageId === 'string' && ID_RE.test(bg.imageId) && isNum(bg.opacity, 0.1, 1)
    && isNum(bg.x0, -500, 500) && isNum(bg.x1, -500, 500) && isNum(bg.z0, -500, 500) && isNum(bg.z1, -500, 500) && (bg.x1 as number) > (bg.x0 as number) && (bg.z1 as number) > (bg.z0 as number)))
    return 'ภาพผังพื้นหลังไม่ถูกต้อง';
  return undefined;
}

// Shape and consistency of a whole facility (what a publish would make current). Never throws on bad input.
export function validateFacility(input: unknown): { data?: FacilityData; issues: Issue[] } {
  const issues: Issue[] = [];
  const err = (message: string, at?: string) => issues.push({ level: 'error', at, message });
  const warn = (message: string, at?: string) => issues.push({ level: 'warning', at, message });
  const d = input as Partial<FacilityData> | null;
  if (!d || typeof d !== 'object' || !Array.isArray(d.buildings) || !Array.isArray(d.floors) || !Array.isArray(d.departments) || !Array.isArray(d.groups) || !Array.isArray(d.points)) {
    err('ข้อมูลผังไม่ครบ (อาคาร ชั้น แผนก กลุ่มบริการ จุดบริการ)');
    return { issues };
  }
  for (const k of ['buildings', 'floors', 'departments', 'groups', 'points'] as const) if (d[k]!.length > LIMITS[k]) err(`จำนวน${({ buildings: 'อาคาร', floors: 'ชั้น', departments: 'แผนก', groups: 'กลุ่มบริการ', points: 'จุดบริการ' })[k]}เกินที่รองรับ (${LIMITS[k]})`);
  if (issues.length) return { issues };
  // Every id unique within its level; point ids are queue station ids, so unique across all points.
  const seen = (list: { id?: unknown }[], what: string) => {
    const ids = new Set<string>();
    for (const x of list) {
      if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !ID_RE.test(x.id)) { err(`รหัส${what}ไม่ถูกต้อง (A–Z a–z 0–9 : _ . - ไม่เกิน 64 ตัว)`, typeof x?.id === 'string' ? x.id : undefined); continue; }
      if (ids.has(x.id)) err(`รหัส${what}ซ้ำ: ${x.id}`, x.id);
      ids.add(x.id);
    }
    return ids;
  };
  const bIds = seen(d.buildings, 'อาคาร'), fIds = seen(d.floors, 'ชั้น'), dIds = seen(d.departments, 'แผนก'), gIds = seen(d.groups, 'กลุ่มบริการ'), pIds = seen(d.points, 'จุดบริการ');
  if (issues.length) return { issues };

  for (const b of d.buildings) {
    if (!isStr(b.name, LIMITS.name) || !isStr(b.shortName ?? '', LIMITS.name, true)) err('ระบุชื่ออาคาร', b.id);
    if (!BUILDING_KINDS.includes(b.kind)) err('ชนิดอาคารไม่ถูกต้อง', b.id);
    const m = b.map as Partial<MapBox> | undefined;
    if (!m || !isNum(m.x, -500, 500) || !isNum(m.z, -500, 500) || !isNum(m.width, 1, 200) || !isNum(m.depth, 1, 200) || !isColor(m.color)) err('ตำแหน่ง/ขนาดอาคารบนแผนที่ไม่ถูกต้อง', b.id);
    if (!isBool(b.active) || !isRetired(b.retiredAt)) err('สถานะอาคารไม่ถูกต้อง', b.id);
  }
  const levels = new Set<string>();
  for (const f of d.floors) {
    if (!bIds.has(f.buildingId)) err('ชั้นนี้ไม่อยู่ในอาคารใด', f.id);
    if (!Number.isInteger(f.level) || f.level < 1 || f.level > 99) err('เลขชั้นต้องเป็น 1 ขึ้นไป (ไม่มีชั้นใต้ดิน)', f.id);
    if (levels.has(`${f.buildingId}:${f.level}`)) err(`อาคารเดียวกันมีชั้น ${f.level} ซ้ำ`, f.id);
    levels.add(`${f.buildingId}:${f.level}`);
    if (!isStr(f.name, LIMITS.name) || !isStr(f.description ?? '', 120, true)) err('ระบุชื่อชั้น', f.id);
    const bm = d.buildings.find((b) => b.id === f.buildingId)?.map;
    if (f.layout !== undefined && bm) { const problem = layoutProblem(f.layout, bm.width, bm.depth); if (problem) err(problem, f.id); }
    if (!isBool(f.active) || !isRetired(f.retiredAt)) err('สถานะชั้นไม่ถูกต้อง', f.id);
  }
  const prefixes = new Map<string, string>(), deptNames = new Set<string>();
  for (const x of d.departments) {
    if (!isStr(x.name, LIMITS.name) || (x.shortName !== undefined && !isStr(x.shortName, LIMITS.name, true))) err('ระบุชื่อแผนก', x.id);
    else if (deptNames.has(x.name.trim())) err(`ชื่อแผนกซ้ำ: ${x.name}`, x.id);
    else deptNames.add(x.name.trim());
    if (!DEPT_TYPES.includes(x.type)) err('ประเภทแผนกไม่ถูกต้อง', x.id);
    if (x.queuePrefix !== undefined) {
      if (!PREFIX_RE.test(x.queuePrefix)) err('อักษรคิวใช้ A–Z 1–3 ตัว', x.id);
      else if (prefixes.has(x.queuePrefix)) err(`อักษรคิว ${x.queuePrefix} ซ้ำกับแผนกอื่น`, x.id);
      else prefixes.set(x.queuePrefix, x.id);
    }
    const ft = x.features as Partial<Features> | undefined;
    if (!ft || !isBool(ft.booking) || !isBool(ft.appointments) || !isBool(ft.walkIn)) err('การรับจอง/นัดของแผนกไม่ถูกต้อง', x.id);
    if (!isBool(x.active) || !isRetired(x.retiredAt)) err('สถานะแผนกไม่ถูกต้อง', x.id);
  }
  const groupName = new Set<string>();
  for (const g of d.groups) {
    if (!dIds.has(g.departmentId)) err('กลุ่มบริการไม่อยู่ในแผนกใด', g.id);
    if (!isStr(g.name, LIMITS.name)) err('ระบุชื่อกลุ่มบริการ', g.id);
    else if (groupName.has(`${g.departmentId}:${g.name.trim()}`)) err(`ชื่อกลุ่มบริการซ้ำในแผนกเดียวกัน: ${g.name}`, g.id);
    else groupName.add(`${g.departmentId}:${g.name.trim()}`);
    if (g.floorId !== null && !fIds.has(g.floorId)) err('กลุ่มบริการอยู่บนชั้นที่ไม่มีในผัง', g.id);
    if (!POINT_KINDS.includes(g.pointKind)) err('"แสดงบนผังเป็น" ไม่ถูกต้อง', g.id);
    if (!isStr(g.pointNoun, LIMITS.noun)) err('ระบุชื่อที่ผู้ป่วยเห็น เช่น ห้องตรวจ ช่องบริการ เตียง', g.id);
    if (!Array.isArray(g.steps) || g.steps.length > 6 || g.steps.some((s) => !STEP_KINDS.includes(s))) err('ขั้นตอนที่กลุ่มให้บริการไม่ถูกต้อง', g.id);
    if (g.serves !== 'department' && g.serves !== 'all') err('กลุ่มนี้ให้บริการใครไม่ถูกต้อง', g.id);
    if (!Number.isInteger(g.minOpen) || g.minOpen < 0 || g.minOpen > 50) err('จำนวนที่ต้องเปิดอย่างน้อยไม่ถูกต้อง', g.id);
    const o = g.options as GroupOptions | undefined;
    if (o !== undefined && (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some((k) => k !== 'arrange' && k !== 'triage' && k !== 'seats')
      || (o.arrange !== undefined && o.arrange !== 'counter' && o.arrange !== 'booths')
      || (o.triage !== undefined && !(Array.isArray(o.triage) && o.triage.length === 2 && o.triage.every((n) => Number.isInteger(n) && n >= 1 && n <= 5) && o.triage[0] <= o.triage[1]))
      || (o.seats !== undefined && !(Number.isInteger(o.seats) && o.seats >= 0 && o.seats <= 500))))
      err('ตัวเลือกของกลุ่มบริการไม่ถูกต้อง', g.id);
    if (!isBool(g.active) || !isRetired(g.retiredAt)) err('สถานะกลุ่มบริการไม่ถูกต้อง', g.id);
  }
  const groupKind = new Map(d.groups.map((g) => [g.id, g.pointKind]));
  const pointGroup = new Map(d.points.map((p) => [p.id, p.groupId]));
  const numbers = new Set<string>();
  for (const p of d.points) {
    if (!gIds.has(p.groupId)) err('จุดบริการไม่อยู่ในกลุ่มใด', p.id);
    if (!Number.isInteger(p.number) || p.number < 0 || p.number > 9999) err('เลขจุดบริการไม่ถูกต้อง', p.id);
    else if (numbers.has(`${p.groupId}:${p.number}`)) err(`เลขห้อง/ช่องซ้ำในกลุ่มเดียวกัน: ${p.number}`, p.id);
    else numbers.add(`${p.groupId}:${p.number}`);
    if (p.name !== undefined && !isStr(p.name, LIMITS.name)) err('ชื่อจุดบริการไม่ถูกต้อง', p.id);
    if (p.roomCode !== undefined && !(typeof p.roomCode === 'string' && /^[A-Za-z0-9ก-๙/._-]{1,12}$/.test(p.roomCode))) err('เลขห้องไม่ถูกต้อง', p.id);
    if (p.floorId !== undefined && !fIds.has(p.floorId)) err('จุดบริการอยู่บนชั้นที่ไม่มีในผัง', p.id);
    if (p.roomKind !== undefined && !ROOM_KINDS.includes(p.roomKind)) err('ชนิดห้องไม่ถูกต้อง', p.id);
    if (p.inRoomId !== undefined && (!pIds.has(p.inRoomId) || groupKind.get(pointGroup.get(p.inRoomId) ?? '') !== 'room')) err('เตียงนี้อ้างถึงห้องที่ไม่มีในผัง', p.id);
    if (p.map !== undefined && !(p.map && isNum(p.map.x, -500, 500) && isNum(p.map.z, -500, 500))) err('ตำแหน่งบนแผนที่ไม่ถูกต้อง', p.id);
    if (!isBool(p.active) || !isRetired(p.retiredAt)) err('สถานะจุดบริการไม่ถูกต้อง', p.id);
  }
  // The first step may be another department's group (the ER starts at triage).
  for (const x of d.departments) if (x.firstGroupId !== undefined && !gIds.has(x.firstGroupId)) err('ขั้นแรกของแผนกต้องเป็นกลุ่มบริการที่มีในผัง', x.id);
  const site = (d.site ?? { roads: [], parking: [], fillers: [] }) as Partial<Site>;
  if (!Array.isArray(site.roads) || site.roads.length > LIMITS.roads || !site.roads.every(isRect) || !Array.isArray(site.parking) || site.parking.length > LIMITS.roads || !site.parking.every(isRect)
    || !Array.isArray(site.fillers) || site.fillers.length > LIMITS.fillers
    || !site.fillers.every((f) => f && ID_RE.test(f.id) && isNum(f.x, -500, 500) && isNum(f.z, -500, 500) && isNum(f.width, 1, 200) && isNum(f.depth, 1, 200) && Number.isInteger(f.floors) && f.floors >= 1 && f.floors <= 60 && isColor(f.color))
    || (site.plazas !== undefined && !(Array.isArray(site.plazas) && site.plazas.length <= LIMITS.roads && site.plazas.every(isRect)))
    || (site.flows !== undefined && !(Array.isArray(site.flows) && site.flows.length <= 20 && site.flows.every((f) => f && ID_RE.test(f.id) && isStr(f.name, LIMITS.name) && isColor(f.color)
      && BUILDING_KINDS.includes(f.kind) && Array.isArray(f.points) && f.points.length >= 2 && f.points.length <= 40 && f.points.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => isNum(n, -500, 500)))))))
    err('ผังพื้นที่รอบอาคาร (ถนน ลานจอดรถ อาคารประกอบ) ไม่ถูกต้อง');
  if (issues.length) return { issues };

  const data: FacilityData = { buildings: d.buildings, floors: d.floors, departments: d.departments, groups: d.groups, points: d.points, site: site as Site };
  // Things in use must stand somewhere in use; an open department needs its groups' minimum of open points.
  const ix = indexFacility(data);
  for (const g of data.groups) if (usable(g) && departmentInUse(ix, g.departmentId) && !floorInUse(ix, g.floorId)) warn(`"${g.name}" อยู่บนชั้นหรืออาคารที่ปิดอยู่`, g.id);
  // Rooms placed by hand on top of each other.
  for (const f of data.floors) {
    const placed = Object.entries(f.layout?.mode === 'manual' ? f.layout.rooms ?? {} : {}).filter(([id]) => ix.point.has(id) && !ix.point.get(id)!.retiredAt);
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      const [ia, a] = placed[i], [, c] = placed[j];
      if (Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0) > 0.05 && Math.min(a.z1, c.z1) - Math.max(a.z0, c.z0) > 0.05) { warn(`มีห้องวางทับกันบน${f.name}`, ia); break; }
    }
  }
  // Buildings drawn on top of each other on the map.
  const blds = data.buildings.filter((b) => !b.retiredAt);
  for (let i = 0; i < blds.length; i++) for (let j = i + 1; j < blds.length; j++) {
    const a = blds[i].map, c = blds[j].map;
    if (Math.abs(a.x - c.x) < (a.width + c.width) / 2 && Math.abs(a.z - c.z) < (a.depth + c.depth) / 2) warn(`${blds[i].name} ทับกับ${blds[j].name}บนแผนที่ — ขยับออกจากกัน`, blds[i].id);
  }
  for (const x of data.departments) {
    if (!usable(x)) continue;
    for (const g of ix.groupsOf.get(x.id) ?? []) {
      if (!usable(g) || !g.minOpen) continue;
      const open = (ix.pointsOf.get(g.id) ?? []).filter((p) => pointInUse(ix, p.id)).length;
      if (open < g.minOpen) warn(`"${g.name}" เปิดอยู่ ${open} ${g.pointNoun} — ต้องเปิดอย่างน้อย ${g.minOpen} ${g.pointNoun} แผนก${x.name}จึงจะรับผู้ป่วยได้`, g.id);
    }
    if ((x.features.booking || x.features.appointments) && !doctorRooms(ix, x.id).some((p) => pointInUse(ix, p.id))) warn(`แผนก${x.name}เปิดรับจอง/นัด แต่ไม่มีห้องตรวจที่เปิดอยู่`, x.id);
  }
  return { data, issues };
}
