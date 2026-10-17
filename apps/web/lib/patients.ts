// Simulated patient journeys for one day (demo). Real journeys would be assembled from events that
// existing systems already record (kiosk ticket, queue call, vital signs, HIS orders, LIS, pharmacy,
// cashier), so no extra data entry for doctors or nurses. No names: an opaque id, queue number and HN.
import { buildings, buildingStats, builtInDeptCount, counterSpot, floorRooms, isDoctorRoom, isOff, kiosks, layoutRevision, roomOpenIntervals, roomSpot, waitingSpot, type Room, type Spot, getServiceHours, opdOpenMin } from './scene-data';

export type StepKind = 'kiosk'|'registration'|'screening'|'exam'|'lab'|'labResult'|'xray'|'followup'|'pharmacy'|'finance'|'triage'|'treatment'|'admit'|'ward'|'leave';
// Wording while waiting for the step, and while being served.
export const stepText:Record<StepKind,{wait:string;serve:string}> = {
  kiosk:{wait:'ต่อแถวรับบัตรคิว',serve:'รับบัตรคิว'},
  registration:{wait:'รอลงทะเบียน',serve:'ลงทะเบียน'},
  screening:{wait:'รอซักประวัติ',serve:'ซักประวัติ / วัดสัญญาณชีพ'},
  exam:{wait:'รอพบแพทย์',serve:'พบแพทย์'},
  lab:{wait:'รอเจาะเลือด',serve:'เจาะเลือด'},
  labResult:{wait:'รอผลแล็บ',serve:'รอผลแล็บ'},
  xray:{wait:'รอเอกซเรย์',serve:'เอกซเรย์'},
  followup:{wait:'รอพบแพทย์ฟังผล',serve:'พบแพทย์ฟังผล'},
  pharmacy:{wait:'รอรับยา',serve:'รับยา'},
  finance:{wait:'รอชำระเงิน',serve:'ชำระเงิน'},
  triage:{wait:'รอคัดแยก',serve:'คัดแยกอาการ'},
  treatment:{wait:'รอรักษา',serve:'รักษาในห้องฉุกเฉิน'},
  admit:{wait:'รอเข้าหอผู้ป่วย',serve:'รับเข้าหอผู้ป่วยแล้ว'},
  ward:{wait:'พักรักษาในหอผู้ป่วย',serve:'พักรักษาในหอผู้ป่วย'},
  leave:{wait:'กำลังกลับบ้าน',serve:'กำลังกลับบ้าน'},
};
// waitArea: where the wait happens when it isn't the destination (an admitted patient waits in their ER bed).
export type Area = {buildingId?:string; level?:number};
export type Place = {where:string; buildingId?:string; level?:number; serve:Spot; wait:Spot; waitArea?:Area};
// Times are minutes since midnight: waiting [start, called), being served [called, end).
// stationId: the counter / room / clinic queue that serves this step (as the simulator assigned it).
// manual, calls, holds: set when queue staff control the step (see lib/queue.ts).
export type Hold = {at:number; until?:number; reason:string};
export type Step = {kind:StepKind; start:number; called:number; end:number; place:Place; stationId?:string; manual?:string; calls?:number[]; holds?:Hold[]; assigned?:string; group?:string; requeue?:number; movedFrom?:string; owner?:boolean; locked?:boolean; ready?:number};
// ready: pharmacy — when the prescription is prepared (the patient can be called from then on)
// owner: a follow-up booked back to the doctor who examined the patient · locked: the queue assistant must not move it
export type Age = 'child'|'adult'|'middle'|'elderly';
export type Patient = {
  id:string; queue:string; hn:string; flow:'opd'|'er'|'ipd'; dept:string; deptWhere:string; roomId?:string;
  arrival:number; steps:Step[]; kioskId?:string; help?:string; missed?:{at:number;until:number};
  age:Age; female:boolean; seed:number;
  ward?:{bed:string; day:number; dischargeAt?:number}; // inpatients: bed, day of stay, planned discharge today
  clinicKey?:string; // OPD clinic (queue group for screening and exam)
  bed?:{level:number; bed:string; from:number; to?:number}; // ward bed held (inpatients, and admitted ER patients)
  triage?:Triage; // ER only
  // Real patient (live data mode): built from a server visit, not simulated — no HN here, steps only as far as ordered.
  live?:boolean; priority?:PriorityKey;
};
export type PriorityKey = 'monk'|'pregnant'|'wheelchair'|'disabled'|'elderly';
export type PatientStatus = 'waiting'|'calling'|'held'|'serving'|'result'|'long'|'missed'|'ward'|'done';
export const statusText:Record<PatientStatus,string> = {waiting:'รอ',calling:'กำลังเรียก',held:'พักคิว',serving:'กำลังรับบริการ',result:'รอผล',long:'รอนาน',missed:'เรียกแล้วไม่มา',ward:'พักรักษา',done:'เสร็จแล้ว · กำลังกลับ'};
export const statusColor:Record<PatientStatus,string> = {waiting:'#f5a524',calling:'#0891b2',held:'#94a3b8',serving:'#1677ff',result:'#8b4fe6',long:'#ef4444',missed:'#e0368c',ward:'#6366f1',done:'#22c58b'};
export const NO_SHOW = 'ไม่มาตามเรียก';
export const LONG_WAIT = 45; // minutes in one step before a patient is flagged

export const maskHN = (hn:string) => hn ? `HN ••-••${hn.slice(-4)}` : 'HN —';
// Durations people read at a glance: "45 นาที", "1 ชม. 5 นาที", "4 ชม. 32 นาที" (short: "4 ชม. 32 น.").
export function fmtDur(min:number, short=false) {
  const m = Math.max(0,Math.round(min)), u = short ? 'น.' : 'นาที';
  if (m<60) return `${m} ${u}`;
  const h = Math.floor(m/60), r = m%60;
  return r ? `${h} ชม. ${r} ${u}` : `${h} ชม.`;
}
// A range: "15–30 นาที", "50 นาที – 1 ชม. 20 นาที".
export const fmtDurRange = (lo:number, hi:number) => hi<60 ? `${Math.round(lo)}–${Math.round(hi)} นาที` : `${fmtDur(lo,true)} – ${fmtDur(hi,true)}`;
export const fmtMin = (m:number) => `${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(Math.floor(m%60)).padStart(2,'0')}`;

function seeded(seed:number) { let s = seed%2147483646+1; return ()=>{ s = s*16807%2147483647; return (s-1)/2147483646; }; }
const hashOf = (str:string) => { let h = 2166136261; for (let i=0;i<str.length;i++) { h ^= str.charCodeAt(i); h = Math.imul(h,16777619); } return h>>>0; };

// Sized so tracked patients fill the floors about as densely as the crowd they replace.
const OPD_PER_DAY = 520, ER_PER_DAY = 60;
export const BEDS_PER_FLOOR = 16, OCCUPIED_PER_FLOOR = 14, CLEANING_MIN = 45;
const ENTRANCE = {x:-8,y:0,z:8.2}, PARKING = {x:5,y:0,z:14.2};
const DAY = 24*60; // OPD counters open at opdOpenMin(); queues before that wait for opening
const where = (id:string, level:number, text:string) => `${text} · ${id==='opd'?'OPD':id==='er'?'ER':id==='diagnostics'?'ศูนย์การแพทย์':'อาคารผู้ป่วยใน'} ชั้น ${level}`;

// ---- Capacity: how many staffed service points each step has. The what-if view changes these. ----
export type Capacity = {registration:number; screening:number; lab:number; xray:number; rxPrep:number; pharmacy:number; finance:number; triage:number; erBeds:number; extraRooms:Record<string,number>};
export type CapacityKey = Exclude<keyof Capacity,'extraRooms'>;
export const DEFAULT_CAPACITY:Capacity = {registration:5,screening:2,lab:3,xray:3,rxPrep:3,pharmacy:3,finance:4,triage:1,erBeds:8,extraRooms:{}};
export const capacityText:Record<CapacityKey,string> = {registration:'ช่องลงทะเบียน',screening:'พยาบาลซักประวัติ / คลินิก',lab:'จุดเจาะเลือด',xray:'ห้องเอกซเรย์',
  rxPrep:'เภสัชกรจัดยา',pharmacy:'ช่องจ่ายยา',finance:'ช่องการเงิน',triage:'พยาบาลคัดแยก ER',erBeds:'เตียงรักษา ER'};

// OPD clinics on floors 2–4, one queue letter each.
export type Clinic = {key:string; letter:string; level:number; deptIndex:number; dept:string; rooms:Room[]; custom?:boolean};
// Screening counters per clinic: the busiest clinics get one more nurse counter.
export const screeningCounters = (c:{dept:string}, cap=DEFAULT_CAPACITY.screening) => Math.max(1,cap+(c.dept==='ศัลยกรรม' || c.dept==='อายุรกรรมทั่วไป' ? 1 : 0));
export const screeningStationId = (clinicKey:string, i:number) => i===0 ? `screen:${clinicKey}` : `screen:${clinicKey}:${i+1}`;
// Letters: built-in clinics first (A, B, C… by floor), departments added in Settings after them, so adding one never
// renames the queues of the others.
let clinicCache:{rev:number; list:Clinic[]}|null = null;
export function opdClinics():Clinic[] {
  if (clinicCache?.rev===layoutRevision()) return clinicCache.list;
  const list = (buildingStats.opd?.floors ?? []).filter(f=>f.level>1).sort((a,b)=>a.level-b.level)
    .flatMap(f=>f.depts.map((dept,i)=>({key:`opd-${f.level}-${i}`,letter:'',level:f.level,deptIndex:i,dept,custom:i>=builtInDeptCount(f.level),rooms:floorRooms('opd',f.level).filter(x=>x.deptIndex===i && isDoctorRoom(x))})))
    .filter(c=>c.rooms.length);
  [...list.filter(c=>!c.custom),...list.filter(c=>c.custom)].forEach((c,i)=>{ c.letter = String.fromCharCode(65+i); });
  clinicCache = {rev:layoutRevision(),list};
  return list;
}
// Switched on in Settings, with at least one exam room and one screening counter on.
export const clinicRoomsOn = (c:Clinic) => c.rooms.filter(r=>!isOff(`room:${r.id}`));
export const clinicScreensOn = (c:Clinic, cap=DEFAULT_CAPACITY.screening) => Array.from({length:screeningCounters(c,cap)},(_,i)=>i).filter(i=>!isOff(screeningStationId(c.key,i)));
export const clinicOpen = (c:Clinic) => !isOff(`dept:${c.dept}`) && clinicRoomsOn(c).length>0 && clinicScreensOn(c).length>0;

// Inpatient beds, positioned exactly where the 3D floor plan draws them: two per room along the back wall,
// then the rest in a row in the open ward at the front. The plan and the bed board both use this list.
export type WardBed = {id:string; level:number; index:number; bed:string; dept:string; spot:Spot};
export function wardBeds():WardBed[] {
  const b = buildings.find(x=>x.id==='inpatient');
  if (!b) return [];
  return (buildingStats.inpatient?.floors ?? []).flatMap(f=>{
    const rooms = floorRooms('inpatient',f.level), rw = b.width/rooms.length, y = (f.level-1)*0.8+0.11;
    const inRooms = rooms.flatMap(room=>[0,1].map(side=>({room,side}))).slice(0,BEDS_PER_FLOOR), wardCount = BEDS_PER_FLOOR-inRooms.length;
    return Array.from({length:BEDS_PER_FLOOR},(_,i)=>{
      if (i<inRooms.length) {
        const {room,side} = inRooms[i];
        return {id:`bed-${f.level}-${i}`,level:f.level,index:i,bed:`${room.number}-${side?'B':'A'}`,dept:f.depts[room.deptIndex] ?? f.desc,
          spot:{x:b.x-b.width/2+room.index*rw+rw*(side?0.72:0.3),y,z:b.z-b.depth/2+0.9}};
      }
      const j = i-inRooms.length;
      return {id:`bed-${f.level}-${i}`,level:f.level,index:i,bed:`${f.level}W-${j+1}`,dept:f.depts[Math.min(f.depts.length-1,Math.floor(j/wardCount*f.depts.length))] ?? f.desc,
        spot:{x:b.x-b.width/2+0.55+j*((b.width-1.1)/Math.max(1,wardCount-1)),y,z:b.z+b.depth/2-0.8}};
    });
  });
}

// ER treatment beds (two per room, where the 3D plan draws them) and the two resuscitation bays at the front.
export type UnitSpot = {id:string; name:string; spot:Spot; room?:Room};
export function erBedSpots():UnitSpot[] {
  const b = buildings.find(x=>x.id==='er'), all = floorRooms('er',1);
  if (!b || !all.length) return [];
  const rw = b.width/all.length;
  return all.filter(isDoctorRoom).flatMap(room=>[0,1].map(side=>({id:`er-${room.number}-${side?'B':'A'}`,name:`เตียง ER ${room.number}-${side?'B':'A'}`,room,
    spot:{x:b.x-b.width/2+room.index*rw+rw*(side?0.72:0.3),y:0.11,z:b.z-b.depth/2+0.9}})));
}
export function erResusSpots():UnitSpot[] {
  const b = buildings.find(x=>x.id==='er'), n = buildingStats.er?.floors.find(f=>f.level===1)?.depts.length ?? 3;
  if (!b) return [];
  const w = b.width/n, x0 = b.x-b.width/2+(n-1)*w;
  return [0,1].map(i=>({id:`er-resus-${i+1}`,name:`เตียงกู้ชีพ ${i+1}`,spot:{x:x0+w*(i?0.72:0.3),y:0.11,z:b.z+b.depth/2-0.8}}));
}

// Medical centre: three separate blood-draw stations across the blood-draw zone (floor 1, patient seat at
// `spot`), and the x-ray rooms along the back wall of floor 2.
export function labStationSpots(n=3):UnitSpot[] {
  const b = buildings.find(x=>x.id==='diagnostics'), depts = buildingStats.diagnostics?.floors.find(f=>f.level===1)?.depts ?? ['',''];
  if (!b) return [];
  const w = b.width/depts.length, x0 = b.x-b.width/2+Math.min(1,depts.length-1)*w, z = b.z-b.depth/2+b.depth*0.42+1.2+0.95;
  return Array.from({length:n},(_,i)=>({id:`dx-lab-${i+1}`,name:`จุดเจาะเลือด ${i+1}`,spot:{x:x0+(i+0.5)*w/n,y:0.11,z}}));
}
export const xrayRoomSpots = ():UnitSpot[] => floorRooms('diagnostics',2).map(room=>({id:room.id,name:room.name,room,spot:roomSpot(room.id)}));

// ER triage (5 levels as used by Thai EDs). Targets are example time-to-treatment goals for the board.
export const triageLevels = [
  {level:1,name:'วิกฤต',color:'#dc2626',target:0},
  {level:2,name:'เร่งด่วนมาก',color:'#f97316',target:10},
  {level:3,name:'เร่งด่วน',color:'#eab308',target:30},
  {level:4,name:'กึ่งเร่งด่วน',color:'#22c55e',target:60},
  {level:5,name:'ไม่เร่งด่วน',color:'#3b82f6',target:120},
] as const;
export type Triage = 1|2|3|4|5;

// ---- Queue simulation ----------------------------------------------------------------------------------
// Each step queues FIFO for a pool of servers (counters, rooms, beds). Exam rooms only call patients while
// the roster has a doctor in (roomOpenIntervals), so lunch gaps and missing afternoon clinics show up as waits.
type Server = {free:number; open:[number,number][]; idx:number; count:number; room?:Room; spot?:Spot; bed?:WardBed};
type StageKind = StepKind|'rx'; // 'rx' = prescription being prepared; shown as part of the pharmacy wait
type Stage = {kind:StageKind; pool?:string; dur:number; delay?:number; walk:number; place:(srv?:Server)=>Place};
type Plan = {flow:'opd'|'er'; arrival:number; stages:Stage[]; missExam?:boolean; admitLevel?:number; admitPrep?:number;
  profile:Omit<Patient,'id'|'queue'|'steps'|'roomId'|'missed'|'bed'>; clinic?:Clinic; closed?:boolean};
const startOn = (s:Server, t:number) => { t = Math.max(t,s.free); for (const [a,b] of s.open) if (t<b) return Math.max(t,a); return Infinity; };
function pickServer(servers:Server[], t:number, prefer?:Server) {
  if (prefer) { const at = startOn(prefer,t); if (at<Infinity) return {srv:prefer,at}; }
  let srv:Server|undefined, at = Infinity;
  for (const s of servers) { const x = startOn(s,t); if (x<at) { at = x; srv = s; } }
  if (srv) return {srv,at};
  // Nothing open later today (e.g. no afternoon clinic): the earliest-free one stays on to finish.
  const open = servers.filter(s=>s.free<Infinity).sort((a,b)=>a.free-b.free)[0];
  return open ? {srv:open,at:Math.max(t,open.free)} : null;
}

export type GenerateOptions = {capacity?:Capacity; volume?:number};
export function generatePatients(dayKey:string, opts:GenerateOptions={}):Patient[] {
  const cap = opts.capacity ?? DEFAULT_CAPACITY, volume = opts.volume ?? 1;
  const r = seeded(hashOf(dayKey)), between = (a:number,b:number) => a+r()*(b-a);
  const pickW = <T,>(items:[T,number][]) => { let x = r()*items.reduce((n,[,w])=>n+w,0); for (const [v,w] of items) { if ((x-=w)<0) return v; } return items[0][0]; };
  const ageOf = ():Age => pickW<Age>([['child',1],['adult',3],['middle',3],['elderly',3]]);
  const hnOf = (base:number) => `${base+Math.floor(r()*3)}-${String(Math.floor(r()*900000)+100000)}`;
  const clinics = opdClinics(), beds = wardBeds(), erRooms = floorRooms('er',1).filter(isDoctorRoom);
  // OPD patients start arriving before the 07:00 opening (the well-known pre-dawn queue).
  // Arrivals follow the OPD hours: some come up to 2 hours before opening; the usual curve is stretched over opening → last arrival.
  const {opdOpen:o, opdClose:c} = getServiceHours(), curve = [0.35,0.75,1,0.95,0.8,0.45,0.6,0.55,0.4], span = Math.max(1,c-o);
  const at = (x:number) => { const i = Math.min(curve.length-2,Math.floor(x)), f = x-i; return curve[i]*(1-f)+curve[i+1]*f; };
  const opdHours:[number,number][] = [[o-2,0.12],[o-1,0.25],...Array.from({length:span},(_,i):[number,number]=>[o+i,at(span>1?i*(curve.length-1)/(span-1):0)])];
  // The ER runs around the clock.
  const erHours:[number,number][] = [0.40,0.35,0.30,0.28,0.28,0.30,0.35,0.40,0.50,0.55,0.60,0.55,0.50,0.55,0.60,0.65,0.75,0.85,0.90,0.80,0.65,0.60,0.55,0.45].map((w,h)=>[h,w]);

  // -- pools
  const pools = new Map<string,Server[]>();
  const pool = (key:string, n:number, open:[number,number][], extra:(i:number)=>Partial<Server> = ()=>({})) =>
    pools.set(key,Array.from({length:n},(_,i)=>({free:0,open,idx:i,count:n,...extra(i)})));
  // Counters switched off in Settings take no patients; idx stays the physical counter (its spot and station id).
  // A whole service is never switched off — if every counter is off the service keeps them all.
  const counterPool = (key:string, kind:string, n:number, open:[number,number][], on?:number[]) => {
    const live = on ?? Array.from({length:n},(_,i)=>i).filter(i=>!isOff(`counter:${kind}:${i+1}`));
    pools.set(key,(live.length ? live : Array.from({length:n},(_,i)=>i)).map(i=>({free:0,open,idx:i,count:n})));
  };
  const allDay:[number,number][] = [[0,DAY]], counters:[number,number][] = [[opdOpenMin(),DAY]];
  kiosks.forEach(k=>pool(`kiosk:${k.id}`,1,allDay));
  counterPool('registration','registration',cap.registration,counters); counterPool('lab','lab',cap.lab,counters); counterPool('xray','xray',cap.xray,counters);
  // Pharmacy and cashier stay open around the clock for the ER; registration, lab and x-ray open at 07:00.
  pool('rx',cap.rxPrep,allDay); counterPool('pharmacy','pharmacy',cap.pharmacy,allDay); counterPool('finance','finance',cap.finance,allDay);
  const erSpots = erBedSpots(), resusSpots = erResusSpots();
  counterPool('triage','triage',cap.triage,allDay); pool('resus',2,allDay,i=>({room:erRooms[0],spot:resusSpots[i].spot}));
  pool('erBed',cap.erBeds,allDay,i=>({room:erSpots[i%erSpots.length].room,spot:erSpots[i%erSpots.length].spot}));
  clinics.forEach(c=>{
    counterPool(`screening:${c.key}`,'',screeningCounters(c,cap.screening),counters,clinicScreensOn(c,cap.screening));
    const extra = cap.extraRooms[c.key] ?? 0, rooms = clinicRoomsOn(c).length ? clinicRoomsOn(c) : c.rooms;
    pools.set(`exam:${c.key}`,[...rooms.map((room,i)=>({free:0,open:roomOpenIntervals(room),idx:i,count:rooms.length,room})),
      ...Array.from({length:extra},(_,i)=>({free:0,open:[[8*60,16*60]] as [number,number][],idx:c.rooms.length+i,count:c.rooms.length+extra,room:c.rooms[0]}))]);
  });

  // -- inpatients already in bed (also fixes when each ward bed frees up)
  const out:Patient[] = [], wardPools = new Map<number,Server[]>();
  beds.forEach(b=>{
    if (!wardPools.has(b.level)) wardPools.set(b.level,[]);
    const srv:Server = {free:0,open:allDay,idx:b.index,count:BEDS_PER_FLOOR,bed:b,spot:b.spot};
    wardPools.get(b.level)!.push(srv);
    if (b.index>=OCCUPIED_PER_FLOOR) return;
    const age = pickW<Age>([['child',b.level===2?6:0.5],['adult',2],['middle',3],['elderly',4]]), female = r()<0.5;
    const dischargeAt = r()<0.15 ? Math.round(between(11,16)*60) : undefined;
    srv.free = dischargeAt ? dischargeAt+CLEANING_MIN : Infinity; // bed is cleaned before the next admission
    const place:Place = {where:where('inpatient',b.level,`${b.dept} · เตียง ${b.bed}`),buildingId:'inpatient',level:b.level,serve:b.spot,wait:b.spot};
    const steps:Step[] = [{kind:'ward',start:0,called:0,end:dischargeAt ?? DAY,place}];
    if (dischargeAt) steps.push({kind:'leave',start:dischargeAt,called:dischargeAt,end:dischargeAt+between(8,12),place:{where:'ทางออก → ลานจอดรถ',serve:PARKING,wait:ENTRANCE}});
    out.push({id:`w-${b.level}${String(b.index+1).padStart(2,'0')}`,queue:`IPD-${b.bed}`,hn:hnOf(60),flow:'ipd',dept:b.dept,deptWhere:where('inpatient',b.level,b.dept),
      arrival:0,steps,age,female,seed:Math.floor(r()*1e9),ward:{bed:b.bed,day:1+Math.floor(r()*9),dischargeAt},bed:{level:b.level,bed:b.bed,from:0,to:dischargeAt}});
  });
  wardPools.forEach((list,level)=>pools.set(`ward:${level}`,list));

  // -- plans (all random draws happen here, so a different capacity replays the very same patients)
  const counterAt = (id:string, level:number, deptIndex:number, text:string) => { const wu = r(), wv = r();
    return (srv?:Server):Place => ({where:where(id,level,text),buildingId:id,level,serve:counterSpot(id,level,deptIndex,srv?(srv.idx+0.5)/srv.count:0.5),wait:waitingSpot(id,level,deptIndex,wu,wv)}); };
  const kioskStage = (kioskId:string):Stage => { const k = kiosks.find(x=>x.id===kioskId)!, y = k.level ? (k.level-1)*0.8+0.11 : 0, dx = between(-0.2,0.2), dz = between(0,1.2);
    return {kind:'kiosk',pool:`kiosk:${kioskId}`,dur:between(0.6,1.2),walk:0,place:()=>({where:k.name,buildingId:k.buildingId,level:k.level,serve:{x:k.x,y,z:k.z+0.4},wait:{x:k.x+dx,y,z:k.z+0.75+dz}})}; };
  const leaveStage = ():Stage => ({kind:'leave',dur:between(6,10),walk:0,place:()=>({where:'ทางออก → ลานจอดรถ',serve:PARKING,wait:ENTRANCE})});
  const walk = () => between(1,3);
  // Lab stations / x-ray rooms: the server index picks the physical station or room the patient goes to.
  const labs = labStationSpots(Math.max(1,cap.lab)), xrays = xrayRoomSpots();
  const labPlace = (wu:number, wv:number) => (srv?:Server):Place => { const st = labs[(srv?.idx ?? 0)%labs.length];
    return {where:where('diagnostics',1,st.name),buildingId:'diagnostics',level:1,serve:st.spot,wait:waitingSpot('diagnostics',1,1,wu,wv)}; };
  const xrayPlace = (wu:number, wv:number) => (srv?:Server):Place => { const rm = xrays[(srv?.idx ?? 0)%xrays.length];
    return {where:where('diagnostics',2,rm.name),buildingId:'diagnostics',level:2,serve:rm.spot,wait:waitingSpot('diagnostics',2,0,wu,wv)}; };
  const plans:Plan[] = [];
  for (let i=0;i<Math.round(OPD_PER_DAY*volume);i++) {
    const age = ageOf(), female = r()<0.5, c = clinics[Math.floor(r()*clinics.length)], arrival = pickW(opdHours)*60+between(0,60);
    const kioskId = pickW<string>([['k-main-1',4],['k-main-2',3],['k-opd-lobby',3]]);
    const clinicWait = waitingSpot('opd',c.level,c.deptIndex,r(),r());
    const room = (text:string) => (srv?:Server):Place => ({where:where('opd',c.level,`${text} ${srv?.room?.number ?? ''}`.trim()),buildingId:'opd',level:c.level,serve:roomSpot((srv?.room ?? c.rooms[0]).id),wait:clinicWait});
    const screen = counterAt('opd',c.level,c.deptIndex,`ซักประวัติ ${c.dept}`);
    const stages:Stage[] = [kioskStage(kioskId),
      {kind:'registration',pool:'registration',dur:between(2.5,4),walk:walk(),place:counterAt('opd',1,0,'ลงทะเบียน')},
      {kind:'screening',pool:`screening:${c.key}`,dur:between(4,6),walk:walk(),place:srv=>({...screen(srv),wait:clinicWait})},
      {kind:'exam',pool:`exam:${c.key}`,dur:between(6,10),walk:walk(),place:room('ห้องตรวจ')}];
    const extra = r();
    if (extra<0.35) stages.push({kind:'lab',pool:'lab',dur:between(3,5),walk:between(3,6),place:labPlace(r(),r())},
      {kind:'labResult',dur:0,delay:between(30,60),walk:0,place:()=>({where:where('opd',c.level,`พื้นที่รอ ${c.dept}`),buildingId:'opd',level:c.level,serve:clinicWait,wait:clinicWait})},
      {kind:'followup',pool:`exam:${c.key}`,dur:between(4,6),walk:walk(),place:room('ห้องตรวจ')});
    else if (extra<0.5) stages.push({kind:'xray',pool:'xray',dur:between(8,12),walk:between(3,6),place:xrayPlace(r(),r())},
      {kind:'followup',pool:`exam:${c.key}`,dur:between(4,6),walk:between(3,6),place:room('ห้องตรวจ')});
    if (r()<0.95) { const ph = counterAt('opd',1,1,'ห้องยา');
      stages.push({kind:'rx',pool:'rx',dur:between(2,4),walk:walk(),place:ph},{kind:'pharmacy',pool:'pharmacy',dur:between(2,4),walk:0,place:ph}); }
    stages.push({kind:'finance',pool:'finance',dur:between(1.5,3),walk:walk(),place:counterAt('opd',1,2,'การเงิน')},leaveStage());
    // A department switched off today has no patients; the plan is still drawn so everyone else stays the same.
    plans.push({flow:'opd',arrival,stages,clinic:c,closed:!clinicOpen(c),missExam:r()<0.06,profile:{hn:hnOf(65),flow:'opd',clinicKey:c.key,dept:c.dept,deptWhere:where('opd',c.level,c.dept),arrival,kioskId,age,female,
      seed:Math.floor(r()*1e9),help:age==='elderly'&&r()<0.3?'รถเข็น':r()<0.03?'ผู้ช่วยพาไปจุดบริการ':undefined}});
  }
  for (let i=0;i<Math.round(ER_PER_DAY*volume);i++) {
    const age = ageOf(), female = r()<0.5, arrival = pickW(erHours)*60+between(0,60), walkIn = r()<0.55;
    const triage = pickW<Triage>([[1,1],[2,8],[3,35],[4,40],[5,16]]), erWait = waitingSpot('er',1,1,r(),r());
    const stages:Stage[] = walkIn ? [kioskStage('k-er')] : [];
    stages.push({kind:'triage',pool:'triage',dur:between(3,6),walk:walkIn?walk():0,place:counterAt('er',1,0,'คัดแยก (Triage)')});
    const bay = (srv?:Server):Place => ({where:where('er',1,triage<=2?'ห้องกู้ชีพ':`ห้องรักษา ${srv?.room?.number ?? ''}`.trim()),buildingId:'er',level:1,serve:srv?.spot ?? roomSpot((srv?.room ?? erRooms[0]).id),wait:erWait});
    stages.push({kind:'treatment',pool:triage<=2?'resus':'erBed',dur:triage<=2?between(60,120):between(30,90),walk:0,place:bay});
    const admit = r() < (triage<=2?0.7:triage===3?0.22:0.05);
    const admitLevel = 1+Math.floor(r()*5), admitPrep = between(30,60);
    if (admit) stages.push({kind:'admit',pool:`ward:${admitLevel}`,dur:0,walk:0,place:srv=>({where:where('inpatient',srv?.bed?.level ?? admitLevel,srv?.bed?`เตียง ${srv.bed.bed}`:'รอเตียง'),buildingId:'inpatient',level:srv?.bed?.level ?? admitLevel,serve:srv?.spot ?? erWait,wait:erWait})});
    else { const ph = counterAt('opd',1,1,'ห้องยา');
      stages.push({kind:'rx',pool:'rx',dur:between(2,4),walk:walk(),place:ph},{kind:'pharmacy',pool:'pharmacy',dur:between(2,4),walk:0,place:ph},
        {kind:'finance',pool:'finance',dur:between(1.5,3),walk:walk(),place:counterAt('opd',1,2,'การเงิน')},leaveStage()); }
    plans.push({flow:'er',arrival,stages,admitLevel:admit?admitLevel:undefined,admitPrep,profile:{hn:hnOf(65),flow:'er',dept:'ห้องฉุกเฉิน',deptWhere:where('er',1,'ห้องฉุกเฉิน'),arrival,
      kioskId:walkIn?'k-er':undefined,triage,age,female,seed:Math.floor(r()*1e9),help:age==='elderly'&&r()<0.4?'รถเข็น':undefined}});
  }

  // -- run: always serve the patient who became ready earliest (FIFO across the whole hospital)
  type Res = {kind:StageKind; start:number; called:number; end:number; srv?:Server; stage:Stage; wait?:Spot};
  const run = plans.map(p=>({p,i:p.closed?p.stages.length:0,ready:p.arrival,res:[] as Res[],exam:undefined as Server|undefined,missed:undefined as Patient['missed'],missedDone:false}));
  for (;;) {
    let a:(typeof run)[number]|undefined;
    for (const x of run) if (x.i<x.p.stages.length && (!a || x.ready<a.ready)) a = x;
    if (!a) break;
    const st = a.p.stages[a.i], start = a.res.length ? a.res[a.res.length-1].end : a.p.arrival;
    let res:Res;
    if (st.delay!==undefined) res = {kind:st.kind,start,called:a.ready+st.delay,end:a.ready+st.delay,stage:st};
    else if (!st.pool) res = {kind:st.kind,start,called:a.ready,end:a.ready+st.dur,stage:st};
    else {
      const pick = pickServer(pools.get(st.pool)!,a.ready,st.kind==='followup'?a.exam:undefined);
      if (st.kind==='admit') { // no free bed today: keeps waiting (boarding in the ER)
        const at = pick && pick.at<DAY ? pick.at : DAY;
        if (pick && at<DAY) pick.srv.free = Infinity;
        res = {kind:'admit',start,called:at,end:DAY,srv:at<DAY?pick!.srv:undefined,stage:st};
      } else if (!pick) res = {kind:st.kind,start,called:DAY,end:DAY,stage:st};
      else {
        // ~6% aren't at the door when first called; the room calls the next patient and recalls them ~15 min later.
        if (st.kind==='exam' && a.p.missExam && !a.missedDone) { a.missedDone = true; a.missed = {at:pick.at,until:pick.at+12}; a.ready = pick.at+15; continue; }
        res = {kind:st.kind,start,called:pick.at,end:pick.at+st.dur,srv:pick.srv,stage:st};
        pick.srv.free = res.end;
        if (st.kind==='exam') a.exam = pick.srv;
        // Admitted ER patients keep their ER bed until a ward bed is ready — the boarding problem.
        if (st.kind==='treatment' && a.p.admitLevel) {
          // Bed coordination: the preferred ward if it has a bed within the hour, otherwise the earliest bed on any ward.
          const ready = res.end+(a.p.admitPrep??45);
          let bedPick = pickServer(pools.get(`ward:${a.p.admitLevel}`)!,ready);
          if (!bedPick || bedPick.at>ready+60) {
            const anyWard = [...wardPools.values()].flat(), alt = pickServer(anyWard,ready);
            if (alt && (!bedPick || alt.at<bedPick.at)) bedPick = alt;
          }
          const bedAt = bedPick && bedPick.at<DAY ? bedPick.at : DAY;
          pick.srv.free = bedAt;
          a.res.push(res); a.i++;
          if (bedPick && bedAt<DAY) bedPick.srv.free = Infinity;
          // While waiting for the ward bed they stay in their ER bed.
          res = {kind:'admit',start:res.end,called:bedAt,end:DAY,srv:bedAt<DAY?bedPick!.srv:undefined,stage:a.p.stages[a.i],wait:pick.srv.spot};
        }
      }
    }
    a.res.push(res); a.i++;
    a.ready = res.end+(a.p.stages[a.i]?.walk ?? 0);
  }

  // -- assemble steps; prescription prep merges into the pharmacy wait
  const counterKinds:StageKind[] = ['registration','lab','xray','pharmacy','finance','triage'];
  const stationOf = (x:Res, plan:Plan) => !x.srv ? undefined
    : (x.kind==='exam'||x.kind==='followup') && x.srv.room ? `room:${x.srv.room.id}`
    : x.kind==='screening' && plan.clinic ? screeningStationId(plan.clinic.key,x.srv.idx)
    : counterKinds.includes(x.kind) ? `counter:${x.kind}:${x.srv.idx+1}` : undefined;
  const toSteps = (res:Res[], plan:Plan):Step[] => {
    const steps:Step[] = [];
    res.forEach((x,i)=>{
      if (x.kind==='rx') return;
      const prev = res[i-1], merged = x.kind==='pharmacy' && prev?.kind==='rx', start = merged ? prev.start : x.start;
      const place = x.stage.place(x.srv);
      // Everything is clamped to the simulated day (late-night ER visits run past midnight).
      const step:Step = {kind:x.kind as StepKind,start:Math.min(start,DAY),called:Math.min(x.called,DAY),end:Math.min(x.end,DAY),place:x.wait?{...place,wait:x.wait,waitArea:{buildingId:'er',level:1}}:place,stationId:stationOf(x,plan)};
      // Follow-up with the same doctor: queued for that room only; about 4 in 10 have an appointment that must stay with them.
      if (merged) step.ready = Math.min(prev.end,DAY);
      const exam = res.find(e=>e.kind==='exam');
      if (x.kind==='followup' && x.srv?.room && exam?.srv?.room?.id===x.srv.room.id) { step.assigned = `room:${x.srv.room.id}`; step.owner = true; step.locked = plan.profile.seed%10<4; }
      steps.push(step);
    });
    return steps;
  };
  const numbered = new Map<string,number>();
  const nextQueue = (prefix:string) => { const n = (numbered.get(prefix)??0)+1; numbered.set(prefix,n); return `${prefix}${String(n).padStart(3,'0')}`; };
  // Queue numbers follow arrival order, as a kiosk issues them.
  run.slice().sort((x,y)=>x.p.arrival-y.p.arrival).forEach((x,k)=>{
    if (x.p.closed) return;
    const admit = x.res.find(s=>s.kind==='admit');
    out.push({...x.p.profile,id:`${x.p.flow==='er'?'e':'p'}-${String(k+1).padStart(4,'0')}`,queue:nextQueue(x.p.flow==='er'?'ER':x.p.clinic!.letter),
      steps:toSteps(x.res,x.p),roomId:(x.exam ?? x.res.find(s=>s.kind==='treatment')?.srv)?.room?.id,missed:x.missed,
      bed:admit?.srv?.bed ? {level:admit.srv.bed.level,bed:admit.srv.bed.bed,from:admit.called} : undefined});
  });
  return out;
}
// Opaque per-day token for the patient-facing status page (a real kiosk would print a random one).
export const patientToken = (p:Patient, dayKey='demo-day') => hashOf(`qr:${dayKey}:${p.id}`).toString(36);

// area: the building / floor the patient is physically in right now.
export type PatientState = {p:Patient; index:number; step:Step; status:PatientStatus; pos:Spot; area:Area; stepWait:number; inHospital:number};
// Where a patient is and what they are doing at `minute`; null before arrival or after leaving.
export function patientAt(p:Patient, minute:number):PatientState|null {
  const index = p.steps.findIndex(s=>minute>=s.start && minute<s.end);
  if (index<0) return null;
  const step = p.steps[index], waiting = minute<step.called;
  let pos = waiting ? step.place.wait : step.place.serve;
  if (step.kind==='leave') {
    const k = (minute-step.start)/(step.end-step.start);
    pos = {x:ENTRANCE.x+(PARKING.x-ENTRANCE.x)*k,y:0,z:ENTRANCE.z+(PARKING.z-ENTRANCE.z)*k};
  }
  const stepWait = waiting ? minute-step.start : step.called-step.start;
  // Staff-controlled steps: on hold, or called and walking over.
  const hold = step.manual && waiting ? step.holds?.find(h=>minute>=h.at && (h.until===undefined || minute<h.until)) : undefined;
  const lastCall = step.manual && waiting ? Math.max(-1,...(step.calls ?? []).filter(c=>c<=minute)) : -1;
  const lastHold = Math.max(-1,...(step.holds ?? []).filter(h=>h.at<=minute).map(h=>h.at));
  const status:PatientStatus = step.kind==='leave' ? 'done'
    : step.kind==='ward' ? 'ward'
    : hold ? (hold.reason===NO_SHOW ? 'missed' : 'held')
    : lastCall>=0 && lastCall>=lastHold ? 'calling'
    // The simulator's own no-show only applies while the simulator runs the step; staff decide on the steps they control.
    : !step.manual && p.missed && minute>=p.missed.at && minute<p.missed.until ? 'missed'
    : step.kind==='labResult' ? 'result'
    : !waiting ? 'serving'
    : stepWait>LONG_WAIT ? 'long' : 'waiting';
  const area = waiting && step.place.waitArea ? step.place.waitArea : {buildingId:step.place.buildingId,level:step.place.level};
  return {p,index,step,status,pos,area,stepWait,inHospital:minute-p.arrival};
}
// Estimated minutes until the patient's current wait ends (the simulator knows; a real system would
// estimate from queue position × recent service rate).
// What can honestly be shown about a step. A patient waiting to see a doctor is told the clinic, not the
// room (rooms are assigned when called); steps after the exam depend on the doctor's orders, so they are
// not known in advance. Used by every view so none of them shows what a real system couldn't know yet.
export function placeText(s:PatientState, minute:number) {
  const waitingExam = (s.step.kind==='exam' || s.step.kind==='followup') && minute<s.step.called;
  return waitingExam ? `พื้นที่รอ ${s.p.deptWhere}` : s.step.place.where;
}
const fixedRoute:StepKind[] = ['kiosk','registration','screening','exam','triage','treatment'];
// Index of the last step that is known at `minute`: everything done so far, the current step and, while still
// in the fixed opening part of the visit, the next fixed step.
export function knownUntil(p:Patient, minute:number) {
  if (p.live) return minute<p.arrival ? -1 : p.steps.length-1; // a real patient's steps are exactly what has been ordered
  const i = p.steps.findIndex(s=>minute>=s.start && minute<s.end);
  if (i<0) return minute<p.arrival ? -1 : p.steps.length-1;
  return fixedRoute.includes(p.steps[i].kind) && fixedRoute.includes(p.steps[i+1]?.kind) ? i+1 : i;
}
// Real patients have no planned time: 0 (unknown) — screens estimate from the queue position instead.
export const etaOf = (s:PatientState, minute:number) => !s.p.live && (s.status==='waiting'||s.status==='long'||s.status==='result') ? Math.max(1,Math.round(s.step.called-minute)) : 0;

// Patients worth a look right now: long waits first, then missed calls.
export function alertsAt(patients:Patient[], minute:number) {
  const now = patients.map(p=>patientAt(p,minute)).filter((s):s is PatientState=>!!s);
  return [...now.filter(s=>s.status==='long').sort((a,b)=>b.stepWait-a.stepWait),...now.filter(s=>s.status==='missed')];
}
// Average wait per step type among steps already called today — where the bottleneck is.
export function bottlenecksAt(patients:Patient[], minute:number) {
  const sums = new Map<StepKind,{total:number;n:number}>();
  patients.forEach(p=>p.steps.forEach(s=>{
    if (s.called>minute || s.kind==='kiosk' || s.kind==='leave' || s.kind==='labResult' || s.kind==='admit' || s.kind==='ward') return;
    const e = sums.get(s.kind) ?? {total:0,n:0}; e.total += s.called-s.start; e.n++; sums.set(s.kind,e);
  }));
  return [...sums.entries()].map(([kind,{total,n}])=>({kind,avg:Math.round(total/n),n})).filter(x=>x.n>=3).sort((a,b)=>b.avg-a.avg);
}
export function kioskAt(patients:Patient[], kioskId:string, minute:number) {
  const hourStart = Math.floor(minute/60)*60;
  let line = 0, issuedHour = 0, issuedToday = 0;
  patients.forEach(p=>{ const s = p.steps[0]; if (s.kind!=='kiosk' || p.kioskId!==kioskId) return;
    if (s.called<=minute) { issuedToday++; if (s.called>=hourStart) issuedHour++; }
    if (minute>=s.start && minute<s.called) line++;
  });
  return {line,issuedHour,issuedToday};
}
// Queue number or HN (any digits, e.g. the last four) among patients who have arrived by `minute`.
export function searchPatients(patients:Patient[], query:string, minute:number) {
  const q = query.trim().toUpperCase().replace(/^HN\s*/,'');
  if (!q) return [];
  const digits = q.replace(/\D/g,'');
  return patients.filter(p=>p.arrival<=minute && (p.queue.includes(q) || (digits.length>=3 && p.hn.replace(/\D/g,'').includes(digits)))).slice(0,6);
}

// ---- Real patients (live data mode) ---------------------------------------------------------------------
// A visit from the API (mirrors apps/api/src/visits.service.ts): who is in today's queue, with which number and
// which steps they have been sent to — no name, no HN.
export type LiveVisit = {id:string; queue:string; flow:'opd'|'er'; clinicKey?:string; dept:string; priority?:PriorityKey; triage?:number;
  arrival:number; steps:{kind:StepKind; at:number}[]; status:'active'|'cancelled'};
type DoneEvent = {action:string; at:number; patientId?:string; step?:number};
// Each step starts when the previous one was finished (or when it was ordered, if later); nothing is predicted:
// called / end stay open (DAY) until staff call, start and finish it — applyQueueEvents fills them in from the log.
// After the last ordered step is done the patient walks out, as in the simulation.
export function livePatients(visits:LiveVisit[], events:DoneEvent[]):Patient[] {
  const doneAt = new Map<string,number>();
  events.forEach(e=>{ if (e.action==='done' && e.patientId?.startsWith('v-') && e.step!==undefined) doneAt.set(`${e.patientId}#${e.step}`,e.at); });
  const clinics = new Map(opdClinics().map(c=>[c.key,c]));
  return visits.filter(v=>v.status==='active').map(v=>{
    const c = v.clinicKey ? clinics.get(v.clinicKey) : undefined, seed = hashOf(v.id+v.queue), r = seeded(seed);
    let prev:number|undefined = v.arrival;
    const steps:Step[] = v.steps.map((x,i)=>{
      const start = prev===undefined ? DAY : Math.min(DAY,Math.max(prev,x.at));
      prev = doneAt.get(`${v.id}#${i}`);
      if (prev!==undefined && prev<start) prev = start;
      return {kind:x.kind,start,called:DAY,end:DAY,place:livePlace(x.kind,c,r)};
    });
    if (prev!==undefined && steps.length) steps.push({kind:'leave',start:prev,called:prev,end:prev+8,place:{where:'ทางออก → ลานจอดรถ',serve:PARKING,wait:ENTRANCE}});
    const deptWhere = c ? where('opd',c.level,c.dept) : where('er',1,'ห้องฉุกเฉิน');
    return {id:v.id,queue:v.queue,hn:'',flow:v.flow,dept:v.dept,deptWhere,arrival:v.arrival,steps,clinicKey:v.clinicKey,
      age:v.priority==='elderly'?'elderly':'adult',female:v.priority==='pregnant' || seed%2===0,seed,
      help:v.priority==='wheelchair'?'รถเข็น':undefined,triage:v.flow==='er' && v.triage ? v.triage as Triage : undefined,live:true,priority:v.priority};
  });
}
// Where a live step happens before a station takes it (the station's own spot replaces `serve` once it calls).
function livePlace(kind:StepKind, c:Clinic|undefined, r:()=>number):Place {
  const counter = (id:string, level:number, deptIndex:number, text:string):Place => ({where:where(id,level,text),buildingId:id,level,serve:counterSpot(id,level,deptIndex,0.5),wait:waitingSpot(id,level,deptIndex,r(),r())});
  if ((kind==='screening' || kind==='exam' || kind==='followup') && c) {
    const wait = waitingSpot('opd',c.level,c.deptIndex,r(),r());
    return kind==='screening' ? {...counter('opd',c.level,c.deptIndex,`ซักประวัติ ${c.dept}`),wait}
      : {where:where('opd',c.level,`ห้องตรวจ ${c.dept}`),buildingId:'opd',level:c.level,serve:c.rooms[0] ? roomSpot(c.rooms[0].id) : wait,wait};
  }
  if (kind==='lab') { const st = labStationSpots()[0]; return {where:where('diagnostics',1,st.name),buildingId:'diagnostics',level:1,serve:st.spot,wait:waitingSpot('diagnostics',1,1,r(),r())}; }
  if (kind==='xray') { const rm = xrayRoomSpots()[0]; return {where:where('diagnostics',2,rm.name),buildingId:'diagnostics',level:2,serve:rm.spot,wait:waitingSpot('diagnostics',2,0,r(),r())}; }
  if (kind==='pharmacy') return counter('opd',1,1,'ห้องยา');
  if (kind==='finance') return counter('opd',1,2,'การเงิน');
  if (kind==='triage') return counter('er',1,0,'คัดแยก (Triage)');
  if (kind==='treatment') { const wait = waitingSpot('er',1,1,r(),r()); return {where:where('er',1,'ห้องรักษา'),buildingId:'er',level:1,serve:erBedSpots()[0]?.spot ?? wait,wait}; }
  return counter('opd',1,0,'ลงทะเบียน');
}
