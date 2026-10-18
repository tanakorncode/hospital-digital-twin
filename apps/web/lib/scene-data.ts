import { facility, facilityRevision, fBuildings, fDepartment, fFloors, fGroup, fPoint, fPoints, floorAt, fGroups, isActive, onFacility, pointLabel,
  type FBuilding, type FPoint } from './facility';

// The hospital as drawn and simulated comes from the facility model (lib/facility.ts) — buildings, floors, the
// departments on each floor, rooms, kiosks and the ground around the buildings. The lists below are rebuilt in place
// whenever a new facility arrives, so modules that imported them keep reading the current hospital.
export type BuildingKind = 'opd' | 'er' | 'inpatient' | 'diagnostics' | 'support';
export type BuildingSpec = { id:string; name:string; kind:BuildingKind; x:number; z:number; width:number; depth:number; floors:number; color:string; };
// World units; the camera looks from +x/+z, so smaller x+z sits further back on screen.
export const buildings: BuildingSpec[] = [];
export type FloorInfo = { level:number; desc:string; count:number; depts:string[] };
export type BuildingStats = { waiting:number; avgWait:number; rooms:[number,number]; floors:FloorInfo[] };
// floors: every floor with its departments in band order (a department is on a floor when one of its groups — or a
// room / counter / bed of it — is there). waiting / avgWait / rooms / count are demo figures (the busiest hour) for the
// sample hospital; a building or floor added later starts from a plain estimate. Real counts replace them in live mode.
export const buildingStats: Record<string,BuildingStats> = {};
const DEMO_BUILDING:Record<string,[number,number,[number,number]]> = {opd:[396,52,[21,30]],inpatient:[48,15,[212,240]],er:[27,12,[9,12]],diagnostics:[84,24,[11,16]],support:[0,0,[0,0]]};
const DEMO_FLOOR:Record<string,number> = {'opd-4':120,'opd-3':186,'opd-2':243,'opd-1':396,'inpatient-5':38,'inpatient-4':52,'inpatient-3':61,'inpatient-2':34,'inpatient-1':48,
  'er-3':6,'er-2':18,'er-1':27,'diagnostics-3':22,'diagnostics-2':31,'diagnostics-1':84,'support-2':42,'support-1':18};
const kindFor = (b:FBuilding):BuildingKind => b.kind==='other' ? 'support' : b.kind;
// The departments on a floor, in band order (department order).
type Band = {deptId:string; name:string};
const bandsOf = new Map<string,Band[]>(); // floor id → bands
export const floorBands = (buildingId:string, level:number) => bandsOf.get(floorAt(buildingId,level)?.id ?? '') ?? [];
// Band index of a department on a floor (−1: not there).
export const bandIndex = (buildingId:string, level:number, deptId:string) => floorBands(buildingId,level).findIndex(x=>x.deptId===deptId);
function rebuildPlan() {
  const f = facility(), order = new Map(f.departments.map((d,i)=>[d.id,i]));
  bandsOf.clear();
  const on = new Map<string,Set<string>>();
  const add = (floorId:string|null|undefined, deptId:string) => { if (!floorId) return; if (!on.has(floorId)) on.set(floorId,new Set()); on.get(floorId)!.add(deptId); };
  for (const g of fGroups()) if (g.pointKind!=='kiosk') add(g.floorId,g.departmentId);
  for (const p of fPoints()) { const g = fGroup(p.groupId)!; if (g.pointKind!=='kiosk' && p.floorId) add(p.floorId,g.departmentId); }
  for (const [floorId,ids] of on) bandsOf.set(floorId,[...ids].filter(id=>fDepartment(id)).sort((a,b)=>order.get(a)!-order.get(b)!).map(id=>({deptId:id,name:fDepartment(id)!.name})));
  buildings.splice(0,buildings.length,...fBuildings().map(b=>({id:b.id,name:b.name,kind:kindFor(b),x:b.map.x,z:b.map.z,width:b.map.width,depth:b.map.depth,
    floors:Math.max(1,...fFloors(b.id).map(x=>x.level)),color:b.map.color})));
  for (const k of Object.keys(buildingStats)) delete buildingStats[k];
  for (const b of fBuildings()) {
    const floors = fFloors(b.id).slice().reverse().map(x=>{ const bands = bandsOf.get(x.id) ?? [];
      return {level:x.level,desc:x.description,count:DEMO_FLOOR[x.id] ?? 20*Math.max(1,bands.length),depts:bands.map(d=>d.name)}; });
    const [waiting,avgWait,rooms] = DEMO_BUILDING[b.id] ?? [0,0,[0,0] as [number,number]];
    buildingStats[b.id] = {waiting,avgWait,rooms,floors};
  }
  roads.splice(0,roads.length,...f.site.roads.map(r=>[...r] as Rect));
  parkingLots.splice(0,parkingLots.length,...f.site.parking.map(r=>[...r] as Rect));
  plazas.splice(0,plazas.length,...buildings.map(b=>[b.x-b.width/2-1.1,b.z-b.depth/2-1.1,b.x+b.width/2+1.1,b.z+b.depth/2+1.1] as Rect),...(f.site.plazas ?? []).map(r=>[...r] as Rect));
  demoFlows.splice(0,demoFlows.length,...(f.site.flows ?? []).map(x=>({...x,kind:x.kind==='other' ? 'support' as BuildingKind : x.kind,points:x.points.map(p=>[p[0],p[1]] as [number,number])})));
  fillerBuildings.splice(0,fillerBuildings.length,...f.site.fillers.map(x=>({id:x.id,name:'',kind:'diagnostics' as BuildingKind,x:x.x,z:x.z,width:x.width,depth:x.depth,floors:x.floors,color:x.color})));
  rebuildRooms(); rebuildKiosks();
}
// Density = number of people in one area (a floor or a department zone), on one scale everywhere.
// Demo thresholds; the hospital should set real ones (e.g. per m² or against each zone's capacity).
export const DENSITY_LOW = 100, DENSITY_HIGH = 200, DENSITY_MAX = 300;
export type DensityLevel = 'normal'|'busy'|'critical';
export const densityLevel = (n:number):DensityLevel => n>DENSITY_HIGH?'critical':n>=DENSITY_LOW?'busy':'normal';
// Gradient stops sit at 0, LOW, mid, HIGH, MAX so the legend's thirds line up with the thresholds.
const densityStops:[number,number[]][] = [[0,[0x22,0xc5,0x8b]],[DENSITY_LOW,[0xa3,0xd6,0x3c]],[150,[0xf5,0xa5,0x24]],[DENSITY_HIGH,[0xf2,0x71,0x1c]],[DENSITY_MAX,[0xef,0x44,0x44]]];
export function densityColor(n:number) {
  const v = Math.max(0,Math.min(DENSITY_MAX,n));
  const i = Math.max(1,densityStops.findIndex(([at])=>at>=v));
  const [a0,c0] = densityStops[i-1], [a1,c1] = densityStops[i], t = (v-a0)/(a1-a0||1);
  return '#'+c0.map((c,k)=>Math.round(c+(c1[k]-c)*t).toString(16).padStart(2,'0')).join('');
}
export const deptColors = ['#3b82f6','#a855f7','#14b8a6','#f59e0b','#ec4899','#64748b'];
export type Department = { name:string; queue:number; status:DensityLevel; color:string };
// Demo split of a floor's headcount across its departments.
export function floorDepartments(buildingId:string, level:number, hour:number=REF_HOUR): Department[] {
  const f = buildingStats[buildingId]?.floors.find(x=>x.level===level);
  if (!f) return [];
  const n = f.depts.length, raw = n===1 ? [1] : n===2 ? [0.58,0.42] : n===3 ? [0.45,0.33,0.22] : f.depts.map((_,i)=>1/(1+i*0.25)), sum = raw.reduce((a,b)=>a+b,0);
  const weights = raw.map(w=>w/sum), count = floorCountAt(buildingId,level,hour);
  return f.depts.map((name,i)=>{
    const queue = isOff(`dept:${name}`) ? 0 : Math.round(count*weights[i]);
    return {name,queue,status:densityLevel(queue),color:deptColors[i%deptColors.length]};
  });
}
// The service bar: one figure per kind of service (demo numbers for the busiest hour; the HIS feed and the tracked
// patients replace them). Ids are the ones the live feed uses.
export type ServicePoint = { id:string; name:string; queue:number; waitMinutes:number; status:'normal'|'busy'|'critical' };
export const servicePoints: ServicePoint[] = [
 {id:'registration',name:'ลงทะเบียน',queue:42,waitMinutes:12,status:'normal'},
 {id:'screening',name:'คัดกรอง',queue:18,waitMinutes:8,status:'normal'},
 {id:'clinic',name:'ห้องตรวจ',queue:276,waitMinutes:52,status:'critical'},
 {id:'lab',name:'ห้องเจาะเลือด',queue:35,waitMinutes:18,status:'busy'},
 {id:'pharmacy',name:'ห้องยา',queue:96,waitMinutes:28,status:'busy'},
 {id:'finance',name:'การเงิน',queue:28,waitMinutes:9,status:'normal'},
 {id:'radiology',name:'รังสีวิทยา',queue:14,waitMinutes:20,status:'normal'},
];
// Walking routes drawn on the map with people walking along them (facility site). Colours avoid the green/amber/red
// used for queue status so a route is never read as a status. kind: whose hours the walkers follow.
export type DemoFlow = {id:string; name:string; color:string; kind:BuildingKind; points:[number,number][]};
export const demoFlows:DemoFlow[] = [];
// Ground layout shared by the 3D scene and the mini map: [x0,z0,x1,z1] rectangles in world units.
export type Rect = [x0:number,z0:number,x1:number,z1:number];
// Ground around the buildings (facility site): roads, car parks, unlabelled neighbouring blocks that frame the campus.
export const roads:Rect[] = [];
export const parkingLots:Rect[] = [];
// Paved plazas: around every building, plus the site's own (the entrance forecourt).
export const plazas:Rect[] = [];
// The main entrance: in front of the building with registration (the first building without one).
export const entranceSpot = () => { const reg = facility().groups.find(g=>!g.retiredAt && g.steps.includes('registration')), fl = reg?.floorId ? facility().floors.find(x=>x.id===reg.floorId) : undefined;
  const b = buildings.find(x=>x.id===fl?.buildingId) ?? buildings[0]; return b ? {x:b.x-b.width/4,z:b.z+b.depth/2+0.9} : {x:0,z:0}; };
export const fillerBuildings:BuildingSpec[] = [];
// Who the little figures on the map are; their clothing colour encodes the type.
// Nurses wear white with a banded cap (accent = band colour); doctors wear green scrubs and a scrub cap.
export const personTypes = [
 {id:'patient',name:'ผู้ป่วยทั่วไป',color:'#2f7fd8',accent:'#2f7fd8'},
 {id:'emergency',name:'ผู้ป่วยฉุกเฉิน',color:'#e0368c',accent:'#e0368c'},
 {id:'inpatient',name:'ผู้ป่วยใน',color:'#8b4fe6',accent:'#8b4fe6'},
 {id:'visitor',name:'ญาติ / ผู้ติดตาม',color:'#f2c230',accent:'#d9a514'},
 {id:'staff',name:'พยาบาล / เจ้าหน้าที่',color:'#ffffff',accent:'#0f9f9a'},
 {id:'doctor',name:'แพทย์',color:'#2e8b57',accent:'#2e8b57'},
] as const;
export type PersonType = typeof personTypes[number]['id'];

// ---- Time of day (demo) -------------------------------------------------------------------------
// The counts in buildingStats / servicePoints describe REF_HOUR; any other hour scales them by the
// building type's daily profile. Real data should come from HIS registration / queue timestamps.
// The whole day (00–24): the ER never closes, and OPD patients start queueing before the counters open.
export const HOUR_START = 0, HOUR_END = 23, REF_HOUR = 10;
export const HOURS = Array.from({length:HOUR_END-HOUR_START+1},(_,i)=>HOUR_START+i);
// OPD service hours (whole hours): counters open at opdOpen, the last new OPD patient arrives by opdClose. Set from the
// shared settings before the simulated day is generated, so every screen builds the same day.
export type ServiceHours = {opdOpen:number; opdClose:number};
export const DEFAULT_HOURS:ServiceHours = {opdOpen:7,opdClose:16};
let serviceHours:ServiceHours = {...DEFAULT_HOURS};
export function setServiceHours(h?:ServiceHours) { serviceHours = {...(h ?? DEFAULT_HOURS)}; }
export const getServiceHours = () => serviceHours;

// ---- Switched on / off ------------------------------------------------------------------------------------------
// From the facility: `dept:<name>` for a department, a point's id (queue station, room, bed) for that point — off
// when it, its group, its floor or its building is switched off (its department has its own `dept:` switch).
export const isOff = (id:string) => {
  if (id.startsWith('dept:')) { const d = facility().departments.find(x=>x.name===id.slice(5) && !x.retiredAt); return !!d && !isActive(d); }
  const p = fPoint(id) ?? fPoint(`room:${id}`); if (!p) return false;
  const g = fGroup(p.groupId), fl = p.floorId ?? g?.floorId, floor = fl ? facility().floors.find(x=>x.id===fl) : undefined;
  return !isActive(p) || !isActive(g) || (!!floor && (!isActive(floor) || !isActive(facility().buildings.find(b=>b.id===floor.buildingId))));
};
// Bumps on every new facility: memoised lists of rooms / stations / clinics key on it.
export const layoutRevision = () => facilityRevision();

// The old Settings "layout" (departments added / renamed / rooms shared out / switched off) — still in the queue
// settings of installations that used it; the API made the facility from it. Nothing reads it here any more.
export type Layout = {off?:string[]; depts?:{name:string; level:number}[]; names?:Record<string,string>; split?:Record<string,number[]>; roomNames?:Record<string,string>};
export const opdOpenMin = () => serviceHours.opdOpen*60, opdLastArrivalMin = () => serviceHours.opdClose*60;
const dailyProfile:Record<BuildingKind,number[]> = {
  //            00   01   02   03   04   05   06   07   08   09   10   11   12   13   14   15   16   17   18   19   20   21   22   23
  opd:        [0.01,0.01,0.01,0.01,0.01,0.05,0.10,0.35,0.75,1.00,0.95,0.80,0.45,0.60,0.55,0.40,0.25,0.12,0.06,0.03,0.02,0.01,0.01,0.01], // early queue, morning clinics
  er:         [0.40,0.35,0.30,0.28,0.28,0.30,0.35,0.40,0.50,0.55,0.60,0.55,0.50,0.55,0.60,0.65,0.75,0.85,0.90,0.80,0.65,0.60,0.55,0.45], // 24 h, busier after hours
  inpatient:  [0.55,0.55,0.55,0.55,0.55,0.58,0.60,0.65,0.70,0.75,0.80,0.95,1.00,0.85,0.75,0.80,0.90,1.00,0.95,0.80,0.65,0.60,0.58,0.55], // visiting hours
  diagnostics:[0.02,0.02,0.02,0.02,0.02,0.03,0.05,0.15,0.40,0.75,1.00,0.95,0.60,0.55,0.70,0.60,0.40,0.20,0.08,0.04,0.02,0.02,0.02,0.02], // follows OPD orders
  support:    [0.05,0.05,0.05,0.05,0.05,0.05,0.10,0.30,0.80,1.00,1.00,1.00,0.70,0.95,1.00,1.00,0.90,0.40,0.15,0.10,0.05,0.05,0.05,0.05], // office hours
};
export const clampHour = (h:number) => Math.min(HOUR_END+0.99,Math.max(HOUR_START,h));
// Hourly steps: every minute within an hour uses that hour's value, matching the timeline bars.
export function crowdFactor(kind:BuildingKind, hour:number) {
  const p = dailyProfile[kind];
  return p[Math.floor(clampHour(hour))-HOUR_START]/p[REF_HOUR-HOUR_START];
}
const kindOf = (id:string):BuildingKind => buildings.find(b=>b.id===id)?.kind ?? 'opd';
// Live values from the realtime feed (see lib/live-feed.ts) replace the demo profile for the hour they
// were measured in; every other hour keeps using the profile.
export type LiveData = {hour:number; floors:Record<string,number>; servicePoints:Record<string,{queue:number;waitMinutes:number;status:DensityLevel}>; duty?:Record<string,LiveDuty>; source?:'demo'|'his-adapter'};
let live:LiveData|null = null;
export const setLiveData = (d:LiveData|null) => { live = d; };
// Live data mode (real patients): counts come from the patients actually in the hospital — `real` — and only a feed
// from the HIS may override the current hour; the demo feed and the demo daily profile are not used at all.
export type RealCounts = {floor:(id:string, level:number, hour:number)=>number; waiting:(id:string, hour:number)=>{n:number; avgWait:number}; rooms:(id:string)=>[number,number]};
let real:RealCounts|null = null;
export const setRealCounts = (r:RealCounts|null) => { real = r; };
export const isRealMode = () => !!real;
const liveAt = (hour:number) => live && (!real || live.source==='his-adapter') && Math.floor(clampHour(hour))===Math.floor(clampHour(live.hour)) ? live : null;
export function floorCountAt(id:string, level:number, hour:number=REF_HOUR) {
  const measured = liveAt(hour)?.floors[`${id}:${level}`];
  if (measured!==undefined) return measured;
  if (real) return real.floor(id,level,hour);
  const f = buildingStats[id]?.floors.find(x=>x.level===level);
  return f ? Math.round(f.count*crowdFactor(kindOf(id),hour)) : 0;
}
export const peakFloorCount = (id:string, level:number) => Math.max(...HOURS.map(h=>floorCountAt(id,level,h)));
// Campus view compares buildings by their average people per floor.
export function buildingDensityAt(id:string, hour:number=REF_HOUR) {
  const f = buildingStats[id]?.floors ?? [];
  return f.length ? Math.round(f.reduce((n,x)=>n+floorCountAt(id,x.level,hour),0)/f.length) : 0;
}
export function buildingStatsAt(id:string, hour:number):BuildingStats|undefined {
  const s = buildingStats[id];
  if (s && real) { const w = real.waiting(id,hour);
    return {...s,waiting:w.n,avgWait:w.avgWait,rooms:real.rooms(id),floors:s.floors.map(f=>({...f,count:floorCountAt(id,f.level,hour)}))}; }
  const k = crowdFactor(kindOf(id),hour);
  return s && {...s,waiting:Math.round(s.waiting*k),avgWait:Math.round(s.avgWait*(0.4+0.6*k)),
    rooms:[Math.min(s.rooms[1],Math.round(s.rooms[0]*Math.min(1.1,k))),s.rooms[1]],
    floors:s.floors.map(f=>({...f,count:floorCountAt(id,f.level,hour)}))};
}
const levelOrder:DensityLevel[] = ['normal','busy','critical'];
const servicePointKind:Record<string,BuildingKind> = {lab:'diagnostics',radiology:'diagnostics'}; // the rest are OPD
export function servicePointAt(sp:ServicePoint, hour:number):ServicePoint {
  const measured = liveAt(hour)?.servicePoints[sp.id];
  if (measured) return {...sp,...measured};
  const k = crowdFactor(servicePointKind[sp.id]??'opd',hour);
  const shift = k<0.5?-2:k<0.8?-1:k>1.2?1:0;
  return {...sp,queue:Math.round(sp.queue*k),waitMinutes:Math.round(sp.waitMinutes*(0.4+0.6*k)),
    status:levelOrder[Math.max(0,Math.min(2,levelOrder.indexOf(sp.status)+shift))]};
}
// Share of the figures generated for a place that should be visible at this hour (1 = its busiest hour).
export const floorPresence = (id:string, level:number, hour:number) => { const peak = peakFloorCount(id,level); return peak ? floorCountAt(id,level,hour)/peak : 0; };
// No generic crowd in live data mode: only real patients (drawn separately) and staff on duty.
export const kindPresence = (kind:BuildingKind, hour:number) => real ? 0 : crowdFactor(kind,hour)/Math.max(...HOURS.map(h=>crowdFactor(kind,h)));

// Timeline scope: whole campus, one building, or one floor.
export type Scope = {building?:string; level?:number};
export type ScopePoint = {hour:number; total:number; density:number};
export function scopeAt(scope:Scope, hour:number):ScopePoint {
  if (scope.building && scope.level) { const n = floorCountAt(scope.building,scope.level,hour); return {hour,total:n,density:n}; }
  let total = 0, floors = 0;
  (scope.building ? [scope.building] : buildings.map(b=>b.id)).forEach(id=>(buildingStats[id]?.floors??[]).forEach(f=>{ total += floorCountAt(id,f.level,hour); floors++; }));
  return {hour,total,density:floors?Math.round(total/floors):0};
}
export const hourlySeries = (scope:Scope) => HOURS.map(h=>scopeAt(scope,h));
// The busiest hour plus its neighbours that stay within 85% of it.
export function peakWindow(series:ScopePoint[]) {
  const max = Math.max(...series.map(p=>p.total)), i = series.findIndex(p=>p.total===max);
  let a = i, b = i;
  while (a>0 && series[a-1].total>=0.85*max) a--;
  while (b<series.length-1 && series[b+1].total>=0.85*max) b++;
  return {from:series[a].hour,to:series[b].hour+1,max};
}
export const fmtHour = (h:number) => `${String(Math.floor(h)).padStart(2,'0')}:${String(Math.floor((h%1)*60)).padStart(2,'0')}`;

// ---- Rooms --------------------------------------------------------------------------------------------------------
// Rooms along the back wall of each floor: the room points of the facility on that floor, in band order, equal widths.
// A room's id is how records name it — the same rule as the API's roomRef: `opd-201` for the point `room:opd-201`,
// else the point's own id (a room added in Settings, the x-ray rooms `counter:xray:1`).
export type RoomKind = 'exam'|'scan'|'treatment'|'ward'|'office';
export type Room = {id:string; buildingId:string; level:number; index:number; count:number; number:number; name:string; kind:RoomKind; dept:string; deptIndex:number; pointId:string};
const roomsByFloor = new Map<string,Room[]>(), roomById = new Map<string,Room>();
const roomIdOf = (p:FPoint) => p.id.startsWith('room:') ? p.id.slice(5) : p.id;
function rebuildRooms() {
  roomsByFloor.clear(); roomById.clear();
  for (const b of fBuildings()) for (const fl of fFloors(b.id)) {
    const bands = bandsOf.get(fl.id) ?? [], band = new Map(bands.map((x,i)=>[x.deptId,i]));
    const list = fPoints().map(p=>({p,g:fGroup(p.groupId)!})).filter(({p,g})=>g.pointKind==='room' && (p.floorId ?? g.floorId)===fl.id)
      .map(({p,g})=>({p,g,band:band.get(g.departmentId) ?? 0}));
    const gOrder = new Map(facility().groups.map((g,i)=>[g.id,i]));
    list.sort((a,b)=>a.band-b.band || gOrder.get(a.g.id)!-gOrder.get(b.g.id)! || a.p.number-b.p.number);
    const rooms = list.map(({p,g,band:deptIndex},k):Room=>{
      const number = /^\d+$/.test(p.roomCode ?? '') ? Number(p.roomCode) : p.number;
      const kind:RoomKind = p.roomKind==='lab' ? 'office' : p.roomKind ?? (g.steps.includes('exam') ? 'exam' : b.kind==='er' ? 'treatment' : b.kind==='inpatient' ? 'ward' : 'office');
      return {id:roomIdOf(p),buildingId:b.id,level:fl.level,index:k,count:list.length,number,name:pointLabel(p),kind,dept:bands[deptIndex]?.name ?? '',deptIndex,pointId:p.id};
    });
    roomsByFloor.set(`${b.id}:${fl.level}`,rooms);
    for (const r of rooms) { roomById.set(r.id,r); roomById.set(r.pointId,r); }
  }
}
export const floorRooms = (buildingId:string, level:number):Room[] => roomsByFloor.get(`${buildingId}:${level}`) ?? [];
export const findRoom = (id:string) => roomById.get(id);
export const isDoctorRoom = (r:Room) => r.kind==='exam' || r.kind==='treatment';

// ---- Doctor duty roster (demo) ---------------------------------------------------------------------------------
export type Doctor = {title:'นพ.'|'พญ.'; first:string; last:string};
export type Shift = {from:number; to:number; doctor:Doctor};
export type DutyStatus = 'active'|'break'|'vacant';
export type LiveDuty = {status:DutyStatus; doctor?:Doctor; from?:number; to?:number};
export type RoomDuty = {room:Room; status:DutyStatus; current?:Shift; next?:Shift; queue:number};
const firstNames:[string,boolean][] = [['ศิริพร',true],['ธนพล',false],['อนันต์',false],['ปิยะดา',true],['กิตติ',false],['วรรณา',true],['ชยพล',false],['สุภาวดี',true],
  ['ณัฐวุฒิ',false],['พิมพ์ชนก',true],['ภาณุ',false],['อรอุมา',true],['ธีรวัฒน์',false],['กมลชนก',true],['วีรยุทธ',false],['จิราพร',true],['ศุภชัย',false],['นภัสสร',true]];
const lastInitials = ['ก.','ส.','ว.','ท.','ป.','ร.','ม.','จ.','น.','พ.','ช.','บ.'];
const hashOf = (str:string) => { let h = 2166136261; for (let i=0;i<str.length;i++) { h ^= str.charCodeAt(i); h = Math.imul(h,16777619); } return h>>>0; };
const seededFrom = (str:string) => { let x = hashOf(str)%2147483646+1; return ()=>{ x = x*16807%2147483647; return (x-1)/2147483646; }; };
export const doctorName = (d:Doctor, full=false) => `${d.title}${d.first}${full?` ${d.last}`:''}`;
export function roomShifts(room:Room):Shift[] {
  if (!isDoctorRoom(room)) return [];
  const r = seededFrom(room.id);
  const doc = ():Doctor => { const [first,female] = firstNames[Math.floor(r()*firstNames.length)]; return {title:female?'พญ.':'นพ.',first,last:lastInitials[Math.floor(r()*lastInitials.length)]}; };
  if (room.kind==='treatment') return [{from:0,to:8,doctor:doc()},{from:8,to:16,doctor:doc()},{from:16,to:24,doctor:doc()}]; // ER: 3 shifts
  // Clinic sessions follow the OPD hours: morning from an hour after opening, a lunch hour, afternoon until the last
  // arrival, and an after-hours clinic after that (default 08–12, 13–16, 16–20).
  const {opdOpen:o, opdClose:c} = serviceHours, a = o+1, span = Math.max(2,c-a), am = Math.max(1,Math.round((span-1)*4/7));
  const shifts:Shift[] = [];
  if (r()<0.92) shifts.push({from:a,to:a+am,doctor:doc()});
  if (r()<0.7 && a+am+1<c) shifts.push({from:a+am+1,to:c,doctor:doc()});
  if (r()<0.3 && c<24) shifts.push({from:c,to:Math.min(24,c+4),doctor:doc()}); // after-hours clinic
  return shifts;
}
export function floorDutyAt(buildingId:string, level:number, hour:number):RoomDuty[] {
  const depts = floorDepartments(buildingId,level,hour), liveDuty = liveAt(hour)?.duty;
  const duties = floorRooms(buildingId,level).filter(isDoctorRoom).map<RoomDuty>(room=>{
    // A room or department switched off in Settings has no doctor today.
    if (isOff(`room:${room.id}`) || isOff(`dept:${room.dept}`)) return {room,status:'vacant',queue:0};
    const shifts = roomShifts(room), current = shifts.find(s=>hour>=s.from && hour<s.to), next = shifts.find(s=>s.from>hour);
    // ~1 in 7 on-duty hours the doctor is on a short break.
    let status:DutyStatus = !current ? 'vacant' : hashOf(`${room.id}@${Math.floor(hour)}`)%7===0 ? 'break' : 'active';
    const measured = liveDuty?.[room.id];
    if (measured) return {room,status:measured.status,next,queue:0,current:measured.doctor?{from:measured.from??Math.floor(hour),to:measured.to??Math.floor(hour)+1,doctor:measured.doctor}:undefined};
    return {room,status,current,next,queue:0};
  });
  // Waiting at each room's door: a share of the department's queue split across its open rooms.
  depts.forEach((d,i)=>{
    const open = duties.filter(x=>x.room.deptIndex===i && x.status!=='vacant');
    open.forEach(x=>{ x.queue = Math.round(d.queue*0.35/open.length); });
  });
  return duties;
}
// Minutes a doctor room actually sees patients: its roster shifts minus the doctor's break hours (the same
// hours floorDutyAt reports as 'พัก'). The patient simulator queues exam patients against these windows.
export function roomOpenIntervals(room:Room):[number,number][] {
  const out:[number,number][] = [];
  for (const s of roomShifts(room)) for (let h=s.from; h<s.to; h++) {
    if (hashOf(`${room.id}@${h}`)%7===0) continue;
    const last = out[out.length-1];
    if (last && last[1]===h*60) last[1] = (h+1)*60; else out.push([h*60,(h+1)*60]);
  }
  return out;
}
export const roomDutyAt = (id:string, hour:number) => { const r = findRoom(id); return r ? floorDutyAt(r.buildingId,r.level,hour).find(d=>d.room.id===id) : undefined; };
export const dutyLabel:Record<DutyStatus,string> = {active:'ตรวจอยู่',break:'พัก',vacant:'ว่าง'};

// ---- Spots where people stand (world coordinates) ---------------------------------------------------
// Mirror the floor-plan layout in HospitalScene (rooms take the back 42% of the depth, then a 1.2 corridor,
// then one band per department at the front).
export const FLOOR_H = 0.8;
export type Spot = {x:number; y:number; z:number};
const bld = (id:string) => buildings.find(b=>b.id===id)!;
export const floorY = (level:number) => (level-1)*FLOOR_H+0.11;
function bandOf(id:string, level:number, deptIndex:number) {
  const b = bld(id), n = buildingStats[id]?.floors.find(f=>f.level===level)?.depts.length ?? 1, w = b.width/n;
  const x0 = b.x-b.width/2+deptIndex*w;
  return {b,x0,x1:x0+w,front0:-b.depth/2+b.depth*0.42+1.2};
}
// Waiting chairs in a department's band — the same rows the 3D floor plan draws (seats every 0.46 × 0.68).
export function waitingSeats(id:string, level:number) {
  const b = bld(id), n = buildingStats[id]?.floors.find(f=>f.level===level)?.depts.length ?? 1, bandW = b.width/n, hd = b.depth/2, front0 = -hd+b.depth*0.42+1.2;
  let rows = 0, cols = 0;
  for (let z=front0+1.2; z<hd-0.3; z+=0.68) rows++;
  for (let x=0.45; x<bandW-0.3; x+=0.46) cols++;
  return rows*cols;
}
// The floor area of one department: its band of rooms at the back and its waiting area in front.
export function deptArea(id:string, level:number, deptIndex:number) {
  const {b,x0,x1} = bandOf(id,level,deptIndex);
  return {x:(x0+x1)/2,z:b.z,w:x1-x0+1.2,d:b.depth+0.6};
}
// u, v in [0,1) spread people across the department's waiting area.
export function waitingSpot(id:string, level:number, deptIndex:number, u:number, v:number):Spot {
  const {b,x0,x1,front0} = bandOf(id,level,deptIndex);
  return {x:x0+0.5+u*(x1-x0-0.9),y:floorY(level),z:b.z+front0+1.1+v*Math.max(0.2,b.depth/2-front0-1.5)};
}
export function counterSpot(id:string, level:number, deptIndex:number, u:number):Spot {
  const {b,x0,front0} = bandOf(id,level,deptIndex);
  return {x:x0+0.5+u*0.9,y:floorY(level),z:b.z+front0+0.85};
}
// Where a patient stands while being seen in a room: across the desk, or beside the bed.
export function roomSpot(roomId:string):Spot {
  const room = findRoom(roomId)!, b = bld(room.buildingId), w = b.width/room.count, x0 = b.x-b.width/2+room.index*w;
  return room.kind==='treatment' || room.kind==='ward'
    ? {x:x0+w*0.3+0.38,y:floorY(room.level),z:b.z-b.depth/2+1.3}
    : {x:x0+w*0.32,y:floorY(room.level),z:b.z-b.depth/2+b.depth*0.42-0.22};
}

// ---- Queue-ticket kiosks (demo) -------------------------------------------------------------------------
export type KioskStatus = 'online'|'paper-low'|'offline';
export type Kiosk = {id:string; name:string; x:number; z:number; level?:number; buildingId?:string; status:KioskStatus};
// The facility's kiosk points (where they stand on the site, or on a floor). Their paper / network state is demo data.
export const kiosks:Kiosk[] = [];
const DEMO_KIOSK_STATUS:Record<string,KioskStatus> = {'k-main-2':'paper-low'};
function rebuildKiosks() {
  kiosks.splice(0,kiosks.length,...fPoints().filter(p=>fGroup(p.groupId)?.pointKind==='kiosk' && p.map).map<Kiosk>(p=>{
    const fl = p.floorId ? facility().floors.find(x=>x.id===p.floorId) : undefined;
    return {id:p.id,name:pointLabel(p),x:p.map!.x,z:p.map!.z,...(fl ? {level:fl.level,buildingId:fl.buildingId} : {}),status:isActive(p) ? DEMO_KIOSK_STATUS[p.id] ?? 'online' : 'offline'};
  }));
}
export const kioskStatusLabel:Record<KioskStatus,string> = {online:'ออนไลน์','paper-low':'กระดาษใกล้หมด',offline:'ออฟไลน์'};
export const kioskY = (k:Kiosk) => k.level ? floorY(k.level) : 0;

// ---- Department directory: where every department is (building, floor, rooms) — the map's search uses it. ----
export type DeptPlace = {name:string; buildingId:string; place:string; level:number; deptIndex:number; rooms:string; floorDesc:string; off:boolean};
export const placeName = (b:BuildingSpec) => b.name.match(/\((.+)\)/)?.[1] ?? b.name;
export function deptDirectory():DeptPlace[] {
  return buildings.flatMap(b=>(buildingStats[b.id]?.floors ?? []).slice().sort((x,y)=>x.level-y.level).flatMap(f=>f.depts.map((name,i)=>{
    const nums = floorRooms(b.id,f.level).filter(r=>r.deptIndex===i).map(r=>r.number);
    const rooms = !nums.length ? '' : nums.length===1 ? `ห้อง ${nums[0]}` : `ห้อง ${nums[0]}–${nums[nums.length-1]}`;
    return {name,buildingId:b.id,place:`${placeName(b)} ชั้น ${f.level}`,level:f.level,deptIndex:i,rooms,floorDesc:f.desc,off:isOff(`dept:${name}`)};
  })));
}
// Name matches first (start of the name before anywhere in it), then departments on a floor whose description matches.
export function findDepts(query:string, limit=6):DeptPlace[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const rank = (d:DeptPlace) => { const n = d.name.toLowerCase(); return n.startsWith(q) ? 0 : n.includes(q) ? 1 : d.floorDesc.toLowerCase().includes(q) || d.place.toLowerCase().includes(q) ? 2 : 9; };
  return deptDirectory().map(d=>({d,r:rank(d)})).filter(x=>x.r<9).sort((a,b)=>a.r-b.r).slice(0,limit).map(x=>x.d);
}

// ---- Doctor search: who is on duty at `hour` (and who comes in later today), for the map's search box. ----
export type DoctorHit = {name:string; room:Room; place:string; status:DutyStatus|'later'; from:number; to:number};
export function findDoctors(query:string, hour:number, limit=6):DoctorHit[] {
  const q = query.trim().replace(/^(หมอ|คุณหมอ|นพ\.?|พญ\.?|dr\.?)\s*/i,'').toLowerCase();
  if (q.length<2) return [];
  const match = (d:Doctor) => `${d.title}${d.first} ${d.last}`.toLowerCase().includes(q) || d.first.toLowerCase().startsWith(q);
  const out:DoctorHit[] = [];
  // OPD floor 1 is registration / pharmacy / cashier — no clinics there, so no doctors to find.
  buildings.forEach(b=>(buildingStats[b.id]?.floors ?? []).filter(f=>!(b.kind==='opd' && f.level===1)).forEach(f=>floorDutyAt(b.id,f.level,hour).forEach(d=>{
    const place = `${placeName(b)} ชั้น ${f.level}`;
    if (d.current && d.status!=='vacant' && match(d.current.doctor)) { out.push({name:doctorName(d.current.doctor,true),room:d.room,place,status:d.status,from:d.current.from,to:d.current.to}); return; }
    const later = roomShifts(d.room).find(sh=>sh.from>hour && match(sh.doctor));
    if (later && !isOff(`room:${d.room.id}`) && !isOff(`dept:${d.room.dept}`)) out.push({name:doctorName(later.doctor,true),room:d.room,place,status:'later',from:later.from,to:later.to});
  })));
  const rank = (h:DoctorHit) => h.status==='active' ? 0 : h.status==='break' ? 1 : 2;
  return out.sort((a,b)=>rank(a)-rank(b) || a.from-b.from).slice(0,limit);
}

// Build from the facility now (the sample until the API's arrives) and again on every new facility.
rebuildPlan();
onFacility(rebuildPlan);
