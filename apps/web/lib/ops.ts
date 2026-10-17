// Operational views derived from patient journeys: queue board, ER board, bed board, alerts and stats.
// Everything here is computed from data existing systems already record; nothing needs extra entry.
import { BEDS_PER_FLOOR, CLEANING_MIN, DEFAULT_CAPACITY, LONG_WAIT, erBedSpots, erResusSpots, labStationSpots, xrayRoomSpots, fmtMin, generatePatients, patientAt, stepText, triageLevels, wardBeds,
  type Capacity, type Patient, type PatientState, type StepKind, type Triage, type WardBed } from './patients';
import { opdLastArrivalMin, opdOpenMin, buildings, buildingStats, counterSpot, doctorName, floorRooms, isDoctorRoom, kiosks, kioskStatusLabel, roomDutyAt, roomSpot, type Spot } from './scene-data';

const present = (patients:Patient[], minute:number) => patients.map(p=>patientAt(p,minute)).filter((s):s is PatientState=>!!s);
const isWaiting = (s:PatientState) => s.status==='waiting' || s.status==='long' || s.status==='missed';

// ---- Queue board --------------------------------------------------------------------------------------
// Clinic steps are grouped by clinic (the room is only known once called); counter steps by the counter.
const byDept:StepKind[] = ['screening','exam','followup','labResult'];
export type QueueRow = {key:string; kind:StepKind; label:string; where:string; waiting:number; serving:number; longest:number; avgWait:number; long:number; missed:number};
export function queueBoard(patients:Patient[], minute:number):QueueRow[] {
  const rows = new Map<string,QueueRow>();
  present(patients,minute).forEach(s=>{
    const k = s.step.kind;
    if (k==='leave' || k==='ward' || k==='kiosk') return;
    const group = byDept.includes(k) ? s.p.deptWhere : s.step.place.where.replace(/ \d+ ·/,' ·');
    const key = `${k}|${group}`;
    const row = rows.get(key) ?? {key,kind:k,label:stepText[k].wait,where:group,waiting:0,serving:0,longest:0,avgWait:0,long:0,missed:0};
    if (isWaiting(s) || s.status==='result') { row.waiting++; row.avgWait += s.stepWait; row.longest = Math.max(row.longest,s.stepWait); }
    else row.serving++;
    if (s.status==='long') row.long++;
    if (s.status==='missed') row.missed++;
    rows.set(key,row);
  });
  return [...rows.values()].map(r=>({...r,avgWait:r.waiting?Math.round(r.avgWait/r.waiting):0,longest:Math.round(r.longest)})).sort((a,b)=>b.waiting-a.waiting);
}

// ---- ER board -------------------------------------------------------------------------------------------
export type ErRow = {s:PatientState; triage:Triage; phase:'triage'|'waiting'|'treatment'|'boarding'|'other'; los:number; overTarget:boolean};
export function erBoard(patients:Patient[], minute:number) {
  const rows:ErRow[] = present(patients,minute).filter(s=>s.p.flow==='er').map(s=>{
    const triage = s.p.triage ?? 4, k = s.step.kind, waiting = minute<s.step.called;
    const phase:ErRow['phase'] = k==='kiosk'||k==='triage' ? 'triage' : k==='treatment' ? (waiting?'waiting':'treatment') : k==='admit' && waiting ? 'boarding' : 'other';
    const target = triageLevels[triage-1].target;
    return {s,triage,phase,los:Math.round(minute-s.p.arrival),overTarget:phase==='waiting' && s.stepWait>target};
  }).filter(r=>r.phase!=='other');
  const byLevel = triageLevels.map(t=>({...t,count:rows.filter(r=>r.triage===t.level).length,over:rows.filter(r=>r.triage===t.level && r.overTarget).length}));
  return {rows:rows.sort((a,b)=>a.triage-b.triage||b.los-a.los),byLevel,boarding:rows.filter(r=>r.phase==='boarding')};
}

// ---- Bed board ------------------------------------------------------------------------------------------
export type BedState = 'occupied'|'cleaning'|'free';
export type BedRow = WardBed & {state:BedState; patient?:Patient; until?:number};
export function bedBoard(patients:Patient[], minute:number) {
  const holders = patients.filter(p=>p.bed);
  const beds:BedRow[] = wardBeds().map(b=>{
    const p = holders.find(h=>h.bed!.level===b.level && h.bed!.bed===b.bed && h.bed!.from<=minute && (h.bed!.to===undefined || minute<h.bed!.to+CLEANING_MIN));
    if (!p) return {...b,state:'free'};
    const to = p.bed!.to;
    return to!==undefined && minute>=to ? {...b,state:'cleaning',until:to+CLEANING_MIN} : {...b,state:'occupied',patient:p,until:to};
  });
  const floors = [...new Set(beds.map(b=>b.level))].sort((a,b)=>b-a).map(level=>{
    const list = beds.filter(b=>b.level===level);
    const occupied = list.filter(b=>b.state==='occupied').length;
    return {level,beds:list,occupied,cleaning:list.filter(b=>b.state==='cleaning').length,free:list.filter(b=>b.state==='free').length,
      discharging:list.filter(b=>b.state==='occupied' && b.until!==undefined && b.until>minute).length,
      waitingAdmit:present(patients,minute).filter(s=>s.step.kind==='admit' && minute<s.step.called && s.p.steps.some(x=>x.kind==='admit' && x.place.level===level)).length,
      occupancy:occupied/BEDS_PER_FLOOR};
  });
  return {beds,floors};
}

// ---- Capacity board: beds, exam rooms and stations across buildings --------------------------------------
export type UnitState = 'busy'|'leaving'|'boarding'|'cleaning'|'free'|'break'|'closed';
export type UnitKind = 'bed'|'room'|'station';
export const unitStateText:Record<UnitKind,Partial<Record<UnitState,string>>> = {
  bed:{busy:'มีผู้ป่วย',leaving:'กลับบ้านวันนี้',boarding:'ค้างรอเตียงหอผู้ป่วย',cleaning:'ทำความสะอาด',free:'ว่าง'},
  room:{busy:'กำลังตรวจ',free:'พร้อมตรวจ (ว่าง)',break:'แพทย์พัก',closed:'ไม่มีแพทย์'},
  station:{busy:'กำลังใช้',free:'ว่าง'},
};
export type Unit = {id:string; name:string; kind:UnitKind; dept:string; state:UnitState; at:Spot; mat:{x:number;z:number;w:number;d:number};
  patient?:PatientState; doctor?:string; until?:number; note:string};
export type CapFloor = {key:string; buildingId:string; buildingName:string; level:number; unitName:string; units:Unit[]; depts:string[];
  free:number; inUse:number; total:number; waiting:number; waitingText:string};
const posKey = (p:Spot) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`;
const bedMat = (sp:Spot) => ({x:sp.x,z:sp.z,w:0.82,d:1.32});
export function capacityBoard(patients:Patient[], minute:number):CapFloor[] {
  const now = present(patients,minute), byPos = new Map<string,PatientState>();
  // Who is at a service spot right now: being served, in bed, or (ER) still occupying a bed while waiting for the ward.
  now.forEach(s=>{ const inBed = s.step.kind==='ward' || s.step.kind==='admit';
    if (inBed || minute>=s.step.called) byPos.set(posKey(s.pos),s); });
  const deptsOf = (id:string, level:number) => buildingStats[id]?.floors.find(f=>f.level===level)?.depts ?? [];
  const nameOf = (id:string) => buildings.find(b=>b.id===id)?.name ?? id;
  const waitingWhere = (pred:(s:PatientState)=>boolean) => now.filter(s=>minute<s.step.called && pred(s)).length;
  const floor = (buildingId:string, level:number, unitName:string, units:Unit[], waiting:number, waitingText:string):CapFloor => ({
    key:`${buildingId}-${level}`,buildingId,buildingName:nameOf(buildingId),level,unitName,units,depts:[...new Set(units.map(u=>u.dept))],
    free:units.filter(u=>u.state==='free').length,inUse:units.filter(u=>u.state==='busy'||u.state==='leaving'||u.state==='boarding').length,
    total:units.filter(u=>u.state!=='closed').length,waiting,waitingText});
  const out:CapFloor[] = [];

  // OPD clinics: exam rooms, staffed per the duty roster.
  const opd = buildings.find(b=>b.id==='opd');
  if (opd) for (const level of [2,3,4]) {
    const all = floorRooms('opd',level), rw = opd.width/all.length, depts = deptsOf('opd',level);
    const units = all.filter(isDoctorRoom).map<Unit>(room=>{
      const at = roomSpot(room.id), occ = byPos.get(posKey(at)), duty = roomDutyAt(room.id,minute/60);
      const state:UnitState = occ ? 'busy' : duty?.status==='active' ? 'free' : duty?.status==='break' ? 'break' : 'closed';
      const x0 = opd.x-opd.width/2+room.index*rw, z0 = opd.z-opd.depth/2, d = opd.depth*0.42;
      return {id:room.id,name:room.name,kind:'room',dept:depts[room.deptIndex] ?? '',state,at,mat:{x:x0+rw/2,z:z0+d/2,w:rw-0.15,d:d-0.15},patient:occ,
        doctor:duty?.current && duty.status!=='vacant' ? doctorName(duty.current.doctor,true) : undefined,
        note:occ ? occ.p.queue : state==='free' ? 'ว่าง' : state==='break' ? 'พัก' : 'ไม่มีแพทย์'};
    });
    out.push(floor('opd',level,'ห้องตรวจ',units,waitingWhere(s=>(s.step.kind==='exam'||s.step.kind==='followup') && s.area.buildingId==='opd' && s.area.level===level),'รอพบแพทย์'));
  }
  // ER: treatment beds and resuscitation bays.
  {
    const depts = deptsOf('er',1);
    const units = [...erBedSpots().map(u=>({...u,dept:depts[1] ?? 'ห้องฉุกเฉิน'})),...erResusSpots().map(u=>({...u,dept:depts[depts.length-1] ?? 'ห้องหัตถการ'}))].map<Unit>(u=>{
      const occ = byPos.get(posKey(u.spot)), boarding = !!occ && occ.step.kind==='admit';
      return {id:u.id,name:u.name,kind:'bed',dept:u.dept,state:boarding?'boarding':occ?'busy':'free',at:u.spot,mat:bedMat(u.spot),patient:occ,
        note:boarding ? `รอเตียง ${Math.round(occ!.stepWait)} น.` : occ ? occ.p.queue : 'ว่าง'};
    });
    out.push(floor('er',1,'เตียง',units,waitingWhere(s=>s.step.kind==='treatment'),'รอรักษา'));
  }
  // Inpatient wards.
  const ward = bedBoard(patients,minute);
  [...ward.floors].sort((a,b)=>b.level-a.level).forEach(f=>{
    const units = f.beds.map<Unit>(b=>{
      const state:UnitState = b.state==='occupied' ? (b.until!==undefined?'leaving':'busy') : b.state;
      const occ = b.patient ? now.find(s=>s.p.id===b.patient!.id) : undefined;
      return {id:b.id,name:`เตียง ${b.bed}`,kind:'bed',dept:b.dept,state,at:b.spot,mat:bedMat(b.spot),patient:occ,until:b.until,
        note:state==='leaving'?`กลับ ${fmtMin(b.until!)}`:state==='cleaning'?`สะอาด ${fmtMin(b.until!)}`:state==='free'?'ว่าง':''};
    });
    out.push(floor('inpatient',f.level,'เตียง',units,f.waitingAdmit,'รอเข้าจาก ER'));
  });
  // Medical centre: blood-draw stations (floor 1) and x-ray rooms (floor 2).
  const dx = buildings.find(b=>b.id==='diagnostics');
  if (dx) {
    const labDept = deptsOf('diagnostics',1).slice(-1)[0] ?? 'ห้องเจาะเลือด';
    const labs = labStationSpots(DEFAULT_CAPACITY.lab).map<Unit>(u=>{ const occ = byPos.get(posKey(u.spot));
      return {id:u.id,name:u.name,kind:'station',dept:labDept,state:occ?'busy':'free',at:u.spot,mat:{x:u.spot.x,z:u.spot.z-0.2,w:0.9,d:1.1},patient:occ,note:occ?occ.p.queue:'ว่าง'}; });
    out.push(floor('diagnostics',1,'จุดเจาะเลือด',labs,waitingWhere(s=>s.step.kind==='lab'),'รอเจาะเลือด'));
    const rw = dx.width/floorRooms('diagnostics',2).length, d = dx.depth*0.42;
    const xr = xrayRoomSpots().map<Unit>(u=>{ const occ = byPos.get(posKey(u.spot)), x0 = dx.x-dx.width/2+u.room!.index*rw;
      return {id:u.id,name:u.name,kind:'station',dept:deptsOf('diagnostics',2)[0] ?? 'รังสีวิทยา',state:occ?'busy':'free',at:u.spot,
        mat:{x:x0+rw/2,z:dx.z-dx.depth/2+d/2,w:rw-0.15,d:d-0.15},patient:occ,note:occ?occ.p.queue:'ว่าง'}; });
    out.push(floor('diagnostics',2,'ห้องเอกซเรย์',xr,waitingWhere(s=>s.step.kind==='xray'),'รอเอกซเรย์'));
  }
  return out;
}

// Service bar figures from the tracked patients themselves (waiting now, their average wait so far), so the
// bar agrees with the map and the queue board at every hour.
const pointSteps:Record<string,StepKind[]> = {registration:['registration'],screening:['screening'],clinic:['exam','followup'],lab:['lab'],pharmacy:['pharmacy'],finance:['finance'],radiology:['xray']};
export function servicePointsNow<T extends {id:string;queue:number;waitMinutes:number;status:'normal'|'busy'|'critical'}>(points:T[], patients:Patient[], minute:number):T[] {
  const waiting = present(patients,minute).filter(s=>isWaiting(s));
  return points.map(sp=>{
    const list = waiting.filter(s=>pointSteps[sp.id]?.includes(s.step.kind));
    const avg = list.length ? Math.round(list.reduce((n,s)=>n+s.stepWait,0)/list.length) : 0;
    return {...sp,queue:list.length,waitMinutes:avg,status:avg>LONG_WAIT||list.some(s=>s.status==='long')?'critical':avg>20?'busy':'normal'};
  });
}

// Why a view may look empty: outside OPD hours. (The ER and the wards run all day.)
export function serviceNote(minute:number):string|null {
  const OPD_OPEN = opdOpenMin(), OPD_LAST_ARRIVAL = opdLastArrivalMin();
  if (minute<OPD_OPEN) return `ช่องบริการ OPD เปิด ${fmtMin(OPD_OPEN)} · ผู้ที่มาก่อนรับบัตรคิวที่ตู้ Kiosk แล้วรอหน้าช่องลงทะเบียน · ห้องฉุกเฉินเปิด 24 ชั่วโมง`;
  if (minute>=OPD_LAST_ARRIVAL+60) return `OPD ไม่รับผู้ป่วยใหม่หลัง ${fmtMin(OPD_LAST_ARRIVAL)} · ที่เห็นคือผู้ที่รอรับบริการให้ครบ · ห้องฉุกเฉินเปิด 24 ชั่วโมง · ปรับเวลาให้บริการหรือเวลาทดสอบได้ที่เมนูตั้งค่า`;
  return null;
}

// ---- Alerts -----------------------------------------------------------------------------------------------
export type AlertRuleId = 'longWait'|'queueLength'|'missed'|'erTarget'|'erBoarding'|'bedFull'|'kiosk';
export type AlertRule = {id:AlertRuleId; name:string; unit?:string; threshold?:number; enabled:boolean; route:string};
export const defaultRules:AlertRule[] = [
  {id:'longWait',name:'ผู้ป่วยรอนานในขั้นเดียว',unit:'นาที',threshold:LONG_WAIT,enabled:true,route:'หัวหน้าพยาบาล OPD'},
  {id:'queueLength',name:'คิวรอที่จุดบริการยาว',unit:'คน',threshold:25,enabled:true,route:'หัวหน้าพยาบาล OPD'},
  {id:'missed',name:'เรียกคิวแล้วไม่มา',enabled:true,route:'งานประชาสัมพันธ์'},
  {id:'erTarget',name:'ER รอเกินเป้าหมายตามระดับคัดแยก',enabled:true,route:'หัวหน้าเวร ER'},
  {id:'erBoarding',name:'ผู้ป่วย ER รอเตียงนาน',unit:'นาที',threshold:60,enabled:true,route:'ศูนย์ประสานงานเตียง'},
  {id:'bedFull',name:'หอผู้ป่วยใกล้เต็ม',unit:'%',threshold:90,enabled:true,route:'ศูนย์ประสานงานเตียง'},
  {id:'kiosk',name:'ตู้ Kiosk มีปัญหา',enabled:true,route:'IT / งานเวชระเบียน'},
];
export type Alert = {id:string; rule:AlertRuleId; severity:'critical'|'warning'; title:string; detail:string; route:string; patientIds:string[]};
// One alert per place / rule (not per patient), so a busy morning doesn't bury the list.
export function alertsFor(patients:Patient[], minute:number, rules:AlertRule[]):Alert[] {
  const on = (id:AlertRuleId) => rules.find(r=>r.id===id && r.enabled);
  const out:Alert[] = [], now = present(patients,minute);
  const r1 = on('longWait');
  if (r1) {
    const groups = new Map<string,PatientState[]>();
    now.filter(s=>isWaiting(s) && s.stepWait>r1.threshold!).forEach(s=>{
      const g = byDept.includes(s.step.kind) ? s.p.deptWhere : s.step.place.where;
      groups.set(`${s.step.kind}|${g}`,[...(groups.get(`${s.step.kind}|${g}`)??[]),s]);
    });
    groups.forEach((list,key)=>{ const worst = Math.max(...list.map(s=>s.stepWait)), where = key.split('|')[1];
      out.push({id:`longWait:${key}`,rule:'longWait',severity:list.length>=5||worst>r1.threshold!*2?'critical':'warning',
        title:`${list.length} คน${stepText[list[0].step.kind].wait}เกิน ${r1.threshold} นาที`,detail:`${where} · นานสุด ${Math.round(worst)} นาที`,route:r1.route,patientIds:list.map(s=>s.p.id)}); });
  }
  const r2 = on('queueLength');
  if (r2) queueBoard(patients,minute).filter(q=>q.waiting>=r2.threshold!).forEach(q=>out.push({id:`queueLength:${q.key}`,rule:'queueLength',
    severity:q.waiting>=r2.threshold!*1.5?'critical':'warning',title:`คิว${q.label.replace(/^รอ/,'')}ยาว ${q.waiting} คน`,detail:`${q.where} · รอเฉลี่ย ${q.avgWait} นาที`,route:r2.route,patientIds:[]}));
  const r3 = on('missed');
  if (r3) { const list = now.filter(s=>s.status==='missed');
    if (list.length) out.push({id:`missed:${list.map(s=>s.p.id).join(',')}`,rule:'missed',severity:'warning',title:`เรียกคิวแล้วไม่มา ${list.length} คน`,
      detail:list.map(s=>`${s.p.queue} (${s.p.dept})`).join(', '),route:r3.route,patientIds:list.map(s=>s.p.id)}); }
  const er = erBoard(patients,minute);
  const r4 = on('erTarget');
  if (r4) er.rows.filter(r=>r.overTarget).forEach(r=>out.push({id:`erTarget:${r.s.p.id}`,rule:'erTarget',severity:r.triage<=3?'critical':'warning',
    title:`${r.s.p.queue} ระดับ ${r.triage} (${triageLevels[r.triage-1].name}) รอเกินเป้า`,detail:`รอรักษา ${Math.round(r.s.stepWait)} นาที · เป้าหมาย ${triageLevels[r.triage-1].target} นาที`,route:r4.route,patientIds:[r.s.p.id]}));
  const r5 = on('erBoarding');
  if (r5) er.boarding.filter(r=>r.s.stepWait>r5.threshold!).forEach(r=>out.push({id:`erBoarding:${r.s.p.id}`,rule:'erBoarding',severity:r.s.stepWait>r5.threshold!*2?'critical':'warning',
    title:`${r.s.p.queue} รอเตียงหอผู้ป่วย ${Math.round(r.s.stepWait)} นาที`,detail:`ค้างอยู่ในเตียง ER · ${r.s.step.place.where}`,route:r5.route,patientIds:[r.s.p.id]}));
  const r6 = on('bedFull');
  if (r6) bedBoard(patients,minute).floors.filter(f=>f.occupancy*100>=r6.threshold!).forEach(f=>out.push({id:`bedFull:${f.level}`,rule:'bedFull',
    severity:f.free===0?'critical':'warning',title:`หอผู้ป่วยชั้น ${f.level} ครองเตียง ${Math.round(f.occupancy*100)}%`,detail:`ว่าง ${f.free} · ทำความสะอาด ${f.cleaning} · รอเข้า ${f.waitingAdmit}`,route:r6.route,patientIds:[]}));
  const r7 = on('kiosk');
  if (r7) kiosks.filter(k=>k.status!=='online').forEach(k=>out.push({id:`kiosk:${k.id}:${k.status}`,rule:'kiosk',severity:k.status==='offline'?'critical':'warning',
    title:`${k.name}: ${kioskStatusLabel[k.status]}`,detail:'สถานะที่ตู้รายงานเอง',route:r7.route,patientIds:[]}));
  return out.sort((a,b)=>(a.severity==='critical'?0:1)-(b.severity==='critical'?0:1));
}

// ---- Stats ------------------------------------------------------------------------------------------------
export const WEEK = [{key:'mon',name:'จันทร์',volume:1.15},{key:'tue',name:'อังคาร',volume:1.05},{key:'wed',name:'พุธ',volume:1},{key:'thu',name:'พฤหัสบดี',volume:0.98},
  {key:'fri',name:'ศุกร์',volume:0.95},{key:'sat',name:'เสาร์',volume:0.45},{key:'sun',name:'อาทิตย์',volume:0.35}];
export const STAT_HOURS = Array.from({length:24},(_,i)=>i); // 00–23
export const STEP_ORDER:StepKind[] = ['registration','screening','exam','lab','xray','followup','pharmacy','finance','triage','treatment'];
export type DaySummary = {name:string; arrivals:number[]; total:number; finished:number; medianTime:number; p90Time:number; stepWait:Partial<Record<StepKind,number>>; stepCount:Partial<Record<StepKind,number>>};
const quantile = (xs:number[], q:number) => { if (!xs.length) return 0; const s = [...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1,Math.floor(q*s.length))]; };
// cutoff: only what has happened by that minute (arrived, called, finished) — used for "today so far".
export function summarize(name:string, patients:Patient[], cutoff=24*60):DaySummary {
  const visits = patients.filter(p=>p.flow!=='ipd' && p.arrival<=cutoff);
  const arrivals = STAT_HOURS.map(h=>visits.filter(p=>Math.floor(p.arrival/60)===h).length);
  const opdTimes = visits.filter(p=>p.flow==='opd' && p.steps[p.steps.length-1].start<=cutoff).map(p=>p.steps[p.steps.length-1].start-p.arrival);
  const sums = new Map<StepKind,number[]>();
  visits.forEach(p=>p.steps.forEach(s=>{ if (STEP_ORDER.includes(s.kind) && s.called<=cutoff) sums.set(s.kind,[...(sums.get(s.kind)??[]),s.called-s.start]); }));
  return {name,arrivals,total:visits.length,finished:opdTimes.length,medianTime:Math.round(quantile(opdTimes,0.5)),p90Time:Math.round(quantile(opdTimes,0.9)),
    stepWait:Object.fromEntries([...sums.entries()].map(([k,v])=>[k,Math.round(v.reduce((a,b)=>a+b,0)/v.length)])),
    stepCount:Object.fromEntries([...sums.entries()].map(([k,v])=>[k,v.length]))};
}
export const weekSummaries = () => WEEK.map(d=>summarize(d.name,generatePatients(`demo-week-${d.key}`,{volume:d.volume})));

// What-if: the same day's patients replayed with different staffing.
export type Scenario = {summary:DaySummary; longWaiters:number; lastOut:string};
export function runScenario(capacity:Capacity):Scenario {
  const ps = generatePatients('demo-day',{capacity});
  const longWaiters = ps.filter(p=>p.flow!=='ipd' && p.steps.some(s=>STEP_ORDER.includes(s.kind) && s.called-s.start>LONG_WAIT)).length;
  const lastOut = Math.max(...ps.filter(p=>p.flow==='opd').map(p=>p.steps[p.steps.length-1].start));
  return {summary:summarize('scenario',ps),longWaiters,lastOut:fmtMin(lastOut)};
}
export function toCsv(rows:(string|number)[][]) { return '﻿'+rows.map(r=>r.map(v=>/[",\n]/.test(String(v))?`"${String(v).replace(/"/g,'""')}"`:v).join(',')).join('\n'); }
