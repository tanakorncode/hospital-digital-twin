export type BuildingKind = 'opd' | 'er' | 'inpatient' | 'diagnostics' | 'support';
export type BuildingSpec = { id:string; name:string; kind:BuildingKind; x:number; z:number; width:number; depth:number; floors:number; color:string; };
// World units; the camera looks from +x/+z, so smaller x+z sits further back on screen.
export const buildings: BuildingSpec[] = [
  {id:'opd',name:'อาคารผู้ป่วยนอก (OPD)',kind:'opd',x:-5,z:2.5,width:12,depth:8,floors:4,color:'#e8eef3'},
  {id:'inpatient',name:'อาคารผู้ป่วยใน',kind:'inpatient',x:-4,z:-10,width:10,depth:5.5,floors:5,color:'#eef2f5'},
  {id:'er',name:'อาคารฉุกเฉิน',kind:'er',x:7.5,z:-12,width:7,depth:6,floors:3,color:'#eef1f4'},
  {id:'diagnostics',name:'อาคารศูนย์การแพทย์',kind:'diagnostics',x:11,z:-3.5,width:6.5,depth:6.5,floors:3,color:'#e9eef2'},
  {id:'support',name:'อาคารสนับสนุน',kind:'support',x:14,z:5,width:7,depth:5,floors:2,color:'#e4e9ed'},
];
export type FloorInfo = { level:number; desc:string; count:number; depts:string[] };
export type BuildingStats = { waiting:number; avgWait:number; rooms:[number,number]; floors:FloorInfo[] };
export const buildingStats: Record<string,BuildingStats> = {
  opd:{waiting:396,avgWait:52,rooms:[21,30],floors:[
   {level:4,desc:'พิเศษ / คลินิกเฉพาะทาง',count:120,depts:['คลินิกพิเศษ','ตา','หู คอ จมูก']},
   {level:3,desc:'แผนกตรวจรักษา',count:186,depts:['ศัลยกรรม','ออร์โธปิดิกส์','สูติ-นรีเวช']},
   {level:2,desc:'ห้องตรวจอายุรกรรม',count:243,depts:['อายุรกรรมทั่วไป','อายุรกรรมเฉพาะทาง','คลินิกเบาหวาน']},
   {level:1,desc:'ลงทะเบียน / ห้องยา',count:396,depts:['ลงทะเบียน','ห้องยา','การเงิน']}]},
  inpatient:{waiting:48,avgWait:15,rooms:[212,240],floors:[
   {level:5,desc:'หอผู้ป่วยพิเศษ',count:38,depts:['หอพิเศษ A','หอพิเศษ B']},
   {level:4,desc:'หอผู้ป่วยศัลยกรรม',count:52,depts:['ศัลยกรรมชาย','ศัลยกรรมหญิง']},
   {level:3,desc:'หอผู้ป่วยอายุรกรรม',count:61,depts:['อายุรกรรมชาย','อายุรกรรมหญิง']},
   {level:2,desc:'หอผู้ป่วยเด็ก',count:34,depts:['กุมารเวช','ทารกแรกเกิด']},
   {level:1,desc:'หอผู้ป่วยรับใหม่ / อายุรกรรมรวม',count:48,depts:['หอผู้ป่วยรับใหม่','อายุรกรรมรวม']}]},
  er:{waiting:27,avgWait:12,rooms:[9,12],floors:[
   {level:3,desc:'ห้องผ่าตัดฉุกเฉิน',count:6,depts:['ห้องผ่าตัด','ห้องพักฟื้น']},
   {level:2,desc:'สังเกตอาการ',count:18,depts:['สังเกตอาการ','ICU ฉุกเฉิน']},
   {level:1,desc:'คัดแยก / ห้องฉุกเฉิน',count:27,depts:['คัดแยก (Triage)','ห้องฉุกเฉิน','ห้องหัตถการ']}]},
  diagnostics:{waiting:84,avgWait:24,rooms:[11,16],floors:[
   {level:3,desc:'ศูนย์หัวใจ',count:22,depts:['ศูนย์หัวใจ','Echo / EKG']},
   {level:2,desc:'รังสีวิทยา (เอกซเรย์)',count:31,depts:['รังสีวิทยา']},
   {level:1,desc:'ห้องปฏิบัติการ / เจาะเลือด',count:84,depts:['ห้องปฏิบัติการ','ห้องเจาะเลือด']}]},
  support:{waiting:0,avgWait:0,rooms:[0,0],floors:[
   {level:2,desc:'สำนักงาน / IT',count:42,depts:['สำนักงาน','ศูนย์ IT']},
   {level:1,desc:'คลังพัสดุ / ซักฟอก',count:18,depts:['คลังพัสดุ','ซักฟอก','โรงครัว']}]},
};
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
export type ServicePoint = { id:string; name:string; x:number; z:number; queue:number; waitMinutes:number; status:'normal'|'busy'|'critical' };
export const servicePoints: ServicePoint[] = [
 {id:'registration',name:'ลงทะเบียน',x:-9,z:7,queue:42,waitMinutes:12,status:'normal'},
 {id:'screening',name:'คัดกรอง',x:-5,z:7,queue:18,waitMinutes:8,status:'normal'},
 {id:'clinic',name:'ห้องตรวจ',x:-4,z:1,queue:276,waitMinutes:52,status:'critical'},
 {id:'lab',name:'ห้องเจาะเลือด',x:9,z:0,queue:35,waitMinutes:18,status:'busy'},
 {id:'pharmacy',name:'ห้องยา',x:0,z:5,queue:96,waitMinutes:28,status:'busy'},
 {id:'finance',name:'การเงิน',x:-1,z:4,queue:28,waitMinutes:9,status:'normal'},
 {id:'radiology',name:'รังสีวิทยา',x:12,z:-1,queue:14,waitMinutes:20,status:'normal'},
];
// Simulated workflow routes (x,z waypoints), drawn as coloured paths with people walking along them.
// Colours avoid the green/amber/red used for queue status so a route is never read as a status.
export const demoFlows = [
 {id:'flow-entry',name:'มาถึง → ทางเข้า OPD',color:'#2563eb',points:[[-17,9.4],[-12.5,9.4],[-9.5,7.2]]},
 {id:'flow-er',name:'ไปห้องฉุกเฉิน (ER)',color:'#e0368c',points:[[-11,13],[-11,8.6],[-1,8.6],[2.8,8.6],[2.8,-5],[2.8,-8.5],[5,-8.5]]},
 {id:'flow-ipd',name:'OPD → รับเป็นผู้ป่วยใน',color:'#8b4fe6',points:[[-3,-1.6],[-3,-5.6],[-1,-5.6],[-1,-7.2]]},
 {id:'flow-dx',name:'OPD → ส่งตรวจแล็บ / เอกซเรย์',color:'#0aa5c2',points:[[1,0.5],[2.2,0.5],[3.6,-0.4],[7.6,-0.4]]},
 {id:'flow-support',name:'ศูนย์การแพทย์ → อาคารสนับสนุน',color:'#475569',points:[[14.2,-0.8],[14.2,2.4]]},
] as const;
// Ground layout shared by the 3D scene and the mini map: [x0,z0,x1,z1] rectangles in world units.
export type Rect = [x0:number,z0:number,x1:number,z1:number];
export const roads:Rect[] = [
 [-80,8,80,10],        // front avenue
 [1.9,-80,3.7,80],     // central spine
 [-80,-5.3,1.9,-3.7],  // OPD ↔ inpatient lane
 [3.7,-8.6,80,-7.2],   // ER ↔ diagnostics lane
 [-15,-80,-13.2,80],   // west road
 [20.2,-80,22,80],     // east road
];
export const parkingLots:Rect[] = [[-1,11.2,11,17.4],[-24,11.2,-16.5,17.4]];
// Unlabelled neighbouring blocks that frame the campus.
export const fillerBuildings:BuildingSpec[] = [
 {id:'f1',name:'',kind:'diagnostics',x:-21,z:-9,width:6,depth:5,floors:3,color:'#e6ebef'},
 {id:'f2',name:'',kind:'diagnostics',x:-22,z:1,width:5,depth:6,floors:2,color:'#e9edf1'},
 {id:'f3',name:'',kind:'diagnostics',x:-6,z:-25,width:9,depth:5,floors:4,color:'#e6ebef'},
 {id:'f4',name:'',kind:'diagnostics',x:9,z:-24,width:7,depth:6,floors:3,color:'#e9edf1'},
 {id:'f5',name:'',kind:'diagnostics',x:16,z:-15.5,width:5,depth:5,floors:2,color:'#e4e9ed'},
 {id:'f6',name:'',kind:'diagnostics',x:29,z:-6,width:6,depth:5,floors:3,color:'#e9edf1'},
 {id:'f7',name:'',kind:'diagnostics',x:28,z:3,width:5,depth:6,floors:2,color:'#e6ebef'},
 {id:'f8',name:'',kind:'diagnostics',x:-30,z:-20,width:7,depth:5,floors:3,color:'#e9edf1'},
 {id:'f9',name:'',kind:'diagnostics',x:-4,z:-36,width:8,depth:5,floors:3,color:'#e6ebef'},
];
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

// ---- Layout from Settings: departments added on the OPD clinic floors (2–4), and departments, exam rooms and
// counters switched off. Ids: `dept:<name>` for a department, the queue station id for a room or counter.
// The floor's rooms are shared out between its departments, so a new department takes rooms from its neighbours.
export type CustomDept = {name:string; level:number};
// names: a department renamed in Settings, by its clinic key (opd-<floor>-<index>); the key itself never changes.
// split: exam rooms per department of an OPD floor ('opd-<floor>' → counts in department order); roomNames: a room's
// display name by id (opd-205). Ids never change.
export type Layout = {off?:string[]; depts?:CustomDept[]; names?:Record<string,string>; split?:Record<string,number[]>; roomNames?:Record<string,string>};
export const CLINIC_FLOORS = [2,3,4];
const builtInDepts = new Map(Object.entries(buildingStats).flatMap(([id,s])=>s.floors.map(f=>[`${id}:${f.level}`,[...f.depts]] as [string,string[]])));
export const builtInDeptCount = (level:number) => builtInDepts.get(`opd:${level}`)?.length ?? 0;
let layoutOff = new Set<string>(), layoutDepts:CustomDept[] = [], layoutNames:Record<string,string> = {}, layoutSplit:Record<string,number[]> = {}, layoutRoomNames:Record<string,string> = {}, layoutKey = '', layoutRev = 0;
export function setLayout(l?:Layout) {
  const key = JSON.stringify([l?.depts ?? [],[...(l?.off ?? [])].sort(),l?.names ?? {},l?.split ?? {},l?.roomNames ?? {}]);
  if (key===layoutKey) return;
  layoutKey = key; layoutRev++;
  layoutOff = new Set(l?.off ?? []); layoutDepts = [...(l?.depts ?? [])]; layoutNames = {...(l?.names ?? {})}; layoutSplit = {...(l?.split ?? {})}; layoutRoomNames = {...(l?.roomNames ?? {})};
  buildingStats.opd?.floors.forEach(f=>{ f.depts = [...(builtInDepts.get(`opd:${f.level}`) ?? f.depts).map((n,i)=>layoutNames[`opd-${f.level}-${i}`] ?? n),...layoutDepts.filter(d=>d.level===f.level).map(d=>d.name)]; });
}
// Bumps on every layout change: memoised lists of rooms / stations / clinics key on it.
export const layoutRevision = () => layoutRev;
export const isOff = (id:string) => layoutOff.has(id);
export const customDepts = () => layoutDepts;
// The name a built-in OPD department had before any rename (for "คืนชื่อเดิม").
export const builtInDeptName = (level:number, index:number) => builtInDepts.get(`opd:${level}`)?.[index];
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

// ---- Rooms and doctor duty roster (demo) ----------------------------------------------------------
// Rooms along the back wall of each floor, numbered level*100+n. The same formula drives the 3D plan.
export type RoomKind = 'exam'|'scan'|'treatment'|'ward'|'office';
export type Room = {id:string; buildingId:string; level:number; index:number; count:number; number:number; name:string; kind:RoomKind; dept:string; deptIndex:number};
const roomTitle:Record<RoomKind,string> = {exam:'ห้องตรวจ',scan:'ห้องสแกน',treatment:'ห้องรักษา',ward:'ห้องพัก',office:'สำนักงาน'};
export const roomsPerFloor = (b:BuildingSpec) => Math.max(3,Math.round(b.width/2));
export function floorRooms(buildingId:string, level:number):Room[] {
  const b = buildings.find(x=>x.id===buildingId);
  if (!b) return [];
  const n = roomsPerFloor(b), depts = buildingStats[buildingId]?.floors.find(f=>f.level===level)?.depts ?? [''];
  // A split from Settings counts only while it still fits the floor (same departments, every room given out).
  const s = layoutSplit[`${buildingId}-${level}`], split = s && s.length===depts.length && s.every(x=>x>=1) && s.reduce((a,x)=>a+x,0)===n ? s : undefined;
  return Array.from({length:n},(_,k)=>{
    // Medical centre: floor 1 = laboratory rooms, floor 2 = x-ray rooms, floor 3 = scan / exam rooms alternating.
    const kind:RoomKind = b.kind==='opd'?'exam':b.kind==='er'?'treatment':b.kind==='inpatient'?'ward':b.kind==='support'?'office'
      : level===1?'office':level===2||k%2===0?'scan':'exam';
    const title = b.kind==='diagnostics' && level===1 ? 'ห้องปฏิบัติการ' : b.kind==='diagnostics' && level===2 ? 'ห้องเอกซเรย์' : roomTitle[kind];
    // Rooms go to departments as set in Settings (split), else by even bands — a room belongs to the band its centre is in.
    const deptIndex = split ? split.findIndex((_,i)=>k<split.slice(0,i+1).reduce((a,x)=>a+x,0)) : Math.min(depts.length-1,Math.floor((k+0.5)/n*depts.length)), number = level*100+k+1;
    const id = `${b.id}-${number}`;
    return {id,buildingId,level,index:k,count:n,number,name:layoutRoomNames[id] ?? `${title} ${number}`,kind,dept:depts[deptIndex],deptIndex};
  });
}
export const findRoom = (id:string) => { const [b,num] = [id.slice(0,id.lastIndexOf('-')),Number(id.slice(id.lastIndexOf('-')+1))]; return floorRooms(b,Math.floor(num/100)).find(r=>r.id===id); };
export const isDoctorRoom = (r:Room) => r.kind==='exam' || r.kind==='treatment';

// Demo roster with invented names. Real data should come from the duty-roster system / HIS and can be
// pushed live (LiveSnapshot.duty), which overrides the roster for the current hour.
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
const floorY = (level:number) => (level-1)*FLOOR_H+0.11;
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
export const kiosks:Kiosk[] = [
  {id:'k-main-1',name:'Kiosk ทางเข้าหลัก 1',x:-10.0,z:7.0,status:'online'},
  {id:'k-main-2',name:'Kiosk ทางเข้าหลัก 2',x:-6.3,z:7.0,status:'paper-low'},
  {id:'k-opd-lobby',name:'Kiosk โถง OPD ชั้น 1',x:-8.2,z:3.2,level:1,buildingId:'opd',status:'online'},
  {id:'k-er',name:'Kiosk หน้าห้องฉุกเฉิน',x:10.3,z:-8.82,status:'online'},
  {id:'k-dx',name:'Kiosk ศูนย์การแพทย์',x:12.9,z:0.2,status:'online'},
];
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
