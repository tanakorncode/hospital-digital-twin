// The hospital's facility model as this app sees it (docs/FACILITY-MODEL-DESIGN.md). One data set for every screen:
// the map, the queue, the boards, the simulator and the settings all read it from here. It mirrors
// apps/api/src/facility-model.ts; the API publishes it ('facility:updated' on the socket, GET /api/v1/facility).
// Until the API's facility arrives — and on a screen running without the API — the sample hospital is used
// (facility-sample.json, written from the API's template: `pnpm --filter api facility:sample`).
import SAMPLE from './facility-sample.json';

export type BuildingKind = 'opd'|'er'|'inpatient'|'diagnostics'|'support'|'other';
export type DepartmentType = 'clinic'|'ward'|'emergency'|'diagnostic'|'service'|'support';
export type PointKind = 'room'|'counter'|'bed'|'kiosk';
export type FRoomKind = 'exam'|'scan'|'treatment'|'ward'|'office'|'lab';
export type FBuilding = {id:string; name:string; shortName:string; kind:BuildingKind; map:{x:number; z:number; width:number; depth:number; color:string}; active:boolean; retiredAt?:string};
export type FFloor = {id:string; buildingId:string; level:number; name:string; description:string; active:boolean; retiredAt?:string};
export type FDepartment = {id:string; name:string; shortName?:string; type:DepartmentType; queuePrefix?:string; features:{booking:boolean; appointments:boolean; walkIn:boolean};
  firstGroupId?:string; active:boolean; retiredAt?:string};
export type GroupOptions = {arrange?:'counter'|'booths'; triage?:[number,number]};
export type FGroup = {id:string; departmentId:string; name:string; floorId:string|null; pointKind:PointKind; pointNoun:string; steps:string[]; serves:'department'|'all';
  minOpen:number; options?:GroupOptions; active:boolean; retiredAt?:string};
export type FPoint = {id:string; groupId:string; number:number; name?:string; roomCode?:string; floorId?:string; roomKind?:FRoomKind; inRoomId?:string; map?:{x:number; z:number};
  active:boolean; retiredAt?:string};
export type Rect = [x0:number,z0:number,x1:number,z1:number];
export type Flow = {id:string; name:string; color:string; kind:BuildingKind; points:[number,number][]};
export type Site = {roads:Rect[]; parking:Rect[]; plazas?:Rect[]; fillers:{id:string; x:number; z:number; width:number; depth:number; floors:number; color:string}[]; flows?:Flow[]};
export type Facility = {version:number; publishedAt:string; buildings:FBuilding[]; floors:FFloor[]; departments:FDepartment[]; groups:FGroup[]; points:FPoint[]; site:Site};

// ---- The current facility -------------------------------------------------------------------------------------
let current = SAMPLE as unknown as Facility, revision = 0, ix = indexOf(current);
const listeners = new Set<()=>void>();
const looksRight = (f:unknown):f is Facility => { const x = f as Facility|null;
  return !!x && typeof x==='object' && typeof x.version==='number' && ['buildings','floors','departments','groups','points'].every(k=>Array.isArray((x as Record<string,unknown>)[k])) && !!x.site; };
// A facility from the API (or this browser's copy of the last one). Same version again changes nothing.
export function setFacility(f:unknown):boolean {
  if (!looksRight(f) || (f.version===current.version && f.publishedAt===current.publishedAt)) return false;
  current = f; ix = indexOf(f); revision++;
  listeners.forEach(fn=>fn());
  return true;
}
export const facility = () => current;
// Bumps on every new facility: memoised lists (rooms, stations, clinics …) key on it.
export const facilityRevision = () => revision;
export const onFacility = (fn:()=>void) => { listeners.add(fn); return ()=>{ listeners.delete(fn); }; };
export const sampleFacility = () => SAMPLE as unknown as Facility;
// This browser's copy of the last facility, so a reload without the API still shows the hospital it last saw.
const storeKey = 'hdt.facility';
export function loadStoredFacility() { try { const raw = localStorage.getItem(storeKey); if (raw) setFacility(JSON.parse(raw)); } catch { /* ignore */ } }
export function storeFacility(f:unknown) { if (!setFacility(f)) return; try { localStorage.setItem(storeKey,JSON.stringify(f)); } catch { /* ignore */ } }

// ---- Lookups --------------------------------------------------------------------------------------------------
type Index = {building:Map<string,FBuilding>; floor:Map<string,FFloor>; department:Map<string,FDepartment>; group:Map<string,FGroup>; point:Map<string,FPoint>;
  groupsOf:Map<string,FGroup[]>; pointsOf:Map<string,FPoint[]>; floorAt:Map<string,FFloor>};
function indexOf(f:Facility):Index {
  const by = <T extends {id:string; retiredAt?:string}>(l:T[]) => new Map(l.filter(x=>!x.retiredAt).map(x=>[x.id,x]));
  const groupsOf = new Map<string,FGroup[]>(), pointsOf = new Map<string,FPoint[]>();
  for (const g of f.groups) if (!g.retiredAt) groupsOf.set(g.departmentId,[...(groupsOf.get(g.departmentId) ?? []),g]);
  for (const p of f.points) if (!p.retiredAt) pointsOf.set(p.groupId,[...(pointsOf.get(p.groupId) ?? []),p]);
  return {building:by(f.buildings),floor:by(f.floors),department:by(f.departments),group:by(f.groups),point:by(f.points),groupsOf,pointsOf,
    floorAt:new Map(f.floors.filter(x=>!x.retiredAt).map(x=>[`${x.buildingId}:${x.level}`,x]))};
}
// Retired things are left out of every list below (history keeps their ids).
export const fBuildings = () => current.buildings.filter(b=>!b.retiredAt);
export const fFloors = (buildingId?:string) => current.floors.filter(x=>!x.retiredAt && (!buildingId || x.buildingId===buildingId)).sort((a,b)=>a.level-b.level);
export const fDepartments = () => current.departments.filter(d=>!d.retiredAt);
export const fGroups = () => current.groups.filter(g=>!g.retiredAt && ix.department.has(g.departmentId));
export const fPoints = () => current.points.filter(p=>!p.retiredAt && ix.group.has(p.groupId));
export const fBuilding = (id?:string|null) => id ? ix.building.get(id) : undefined;
export const fFloor = (id?:string|null) => id ? ix.floor.get(id) : undefined;
export const floorAt = (buildingId:string, level:number) => ix.floorAt.get(`${buildingId}:${level}`);
export const fDepartment = (id?:string|null) => id ? ix.department.get(id) : undefined;
export const fGroup = (id?:string|null) => id ? ix.group.get(id) : undefined;
export const fPoint = (id?:string|null) => id ? ix.point.get(id) : undefined;
export const groupsOf = (departmentId:string) => ix.groupsOf.get(departmentId) ?? [];
export const pointsOf = (groupId:string) => (ix.pointsOf.get(groupId) ?? []).slice().sort((a,b)=>a.number-b.number);
// Where a point is: its own floor, else its group's (null = outdoors).
export const pointFloor = (p:FPoint) => fFloor(p.floorId ?? fGroup(p.groupId)?.floorId);
// Switched on (each thing on its own, not counting what it sits in).
export const isActive = (x?:{active:boolean; retiredAt?:string}) => !!x && x.active && !x.retiredAt;
// In use: the thing and everything it sits in (department, group, floor, building) switched on.
export function floorInUse(floorId?:string|null) { if (!floorId) return true; const f = fFloor(floorId); return isActive(f) && isActive(fBuilding(f!.buildingId)); }
export function groupInUse(g?:FGroup) { return !!g && isActive(g) && isActive(fDepartment(g.departmentId)) && floorInUse(g.floorId); }
export function pointInUse(p?:FPoint) { return !!p && isActive(p) && groupInUse(fGroup(p.groupId)) && floorInUse(p.floorId); }
// The name patients read (same rule as the API's stationLabel): the point's own name, else "<noun> <number>" — a
// counter with the group's name in front when the noun alone does not say where (rooms and beds go by their sign).
export function pointLabel(p:FPoint) {
  if (p.name) return p.name;
  const g = fGroup(p.groupId);
  if (!g) return String(p.number);
  return g.pointKind!=='counter' || g.name.includes(g.pointNoun) ? `${g.pointNoun} ${p.number}` : `${g.name} ${g.pointNoun} ${p.number}`;
}
// The groups serving a visit step (shared counters, triage …), usable ones first.
export function groupsForStep(step:string, opts:{shared?:boolean}={}) {
  const list = fGroups().filter(g=>g.steps.includes(step) && (g.pointKind==='room' || g.pointKind==='counter' || g.pointKind==='bed')
    && (!opts.shared || fDepartment(g.departmentId)?.type!=='clinic'));
  return [...list.filter(groupInUse),...list.filter(g=>!groupInUse(g))];
}
// The emergency department: takes ER patients (its own queue letter).
export const erDepartment = () => fDepartments().find(d=>d.type==='emergency' && d.queuePrefix) ?? fDepartments().find(d=>d.type==='emergency');
export const buildingShort = (id?:string) => { const b = fBuilding(id); return b ? b.shortName || b.name : id ?? ''; };
