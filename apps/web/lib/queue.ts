'use client';
// Queue system: staff actions (call, recall, start, hold, return, done) are an append-only event log kept by the
// API and broadcast to every screen. Each screen replays the log over the simulated day, so the staff console,
// the map, the wall TV and the patient's QR page always agree. Without the API the log stays in this browser.
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { apiSocket } from './api-url';
import { DEFAULT_CAPACITY, NO_SHOW, generatePatients, labStationSpots, livePatients, opdClinics, patientAt, patientToken, screeningCounters, screeningStationId, xrayRoomSpots, type LiveVisit, type Patient, type PatientState, type StepKind } from './patients';
import { buildings, counterSpot, doctorName, isOff, layoutRevision, roomDutyAt, roomSpot, setLayout, setServiceHours, waitingSpot, type Layout, type Spot } from './scene-data';

const DAY = 24*60;

// ---- Stations: where queue staff work ----------------------------------------------------------------
export type Station = {id:string; label:string; section:string; group:string; kinds:StepKind[]; buildingId:string; level:number; spot:Spot; roomId?:string; clinicKey?:string};
const counters:[StepKind,string,string,number,(i:number,n:number)=>{spot:Spot;buildingId:string;level:number;label?:string}][] = [
  ['registration','ลงทะเบียน','ช่องลงทะเบียน',DEFAULT_CAPACITY.registration,(i,n)=>({spot:counterSpot('opd',1,0,(i+0.5)/n),buildingId:'opd',level:1})],
  ['pharmacy','ห้องยา','ช่องจ่ายยา',DEFAULT_CAPACITY.pharmacy,(i,n)=>({spot:counterSpot('opd',1,1,(i+0.5)/n),buildingId:'opd',level:1})],
  ['finance','การเงิน','ช่องการเงิน',DEFAULT_CAPACITY.finance,(i,n)=>({spot:counterSpot('opd',1,2,(i+0.5)/n),buildingId:'opd',level:1})],
  ['lab','ห้องเจาะเลือด','จุดเจาะเลือด',DEFAULT_CAPACITY.lab,i=>({spot:labStationSpots()[i].spot,buildingId:'diagnostics',level:1})],
  ['xray','รังสีวิทยา','ห้องเอกซเรย์',DEFAULT_CAPACITY.xray,i=>{ const r = xrayRoomSpots()[i]; return {spot:r.spot,buildingId:'diagnostics',level:2,label:r.name}; }],
  ['triage','ห้องฉุกเฉิน','จุดคัดแยก',DEFAULT_CAPACITY.triage,(i,n)=>({spot:counterSpot('er',1,0,(i+0.5)/n),buildingId:'er',level:1})],
];
// everyStation: every room and counter, including those switched off in Settings (the Settings page lists them).
// allStations: the ones in use — what pickers, moves, the assistant and the boards work with.
let stationCache:{rev:number; every:Station[]; on:Station[]}|null = null;
export function everyStation():Station[] { return stationsNow().every; }
export function allStations():Station[] { return stationsNow().on; }
export const stationOff = (st:Station) => isOff(st.id) || (!!st.clinicKey && isOff(`dept:${opdClinics().find(c=>c.key===st.clinicKey)?.dept}`));
function stationsNow() {
  if (stationCache?.rev===layoutRevision()) return stationCache;
  const list:Station[] = [];
  opdClinics().forEach(c=>{
    const n = screeningCounters(c);
    for (let i=0;i<n;i++) list.push({id:screeningStationId(c.key,i),label:`ซักประวัติ ${c.dept} ${i+1}`,section:`OPD ชั้น ${c.level} · ${c.dept}`,group:`screening:${c.key}`,kinds:['screening'],
      buildingId:'opd',level:c.level,spot:counterSpot('opd',c.level,c.deptIndex,(i+0.5)/n),clinicKey:c.key});
    c.rooms.forEach(room=>list.push({id:`room:${room.id}`,label:room.name,section:`OPD ชั้น ${c.level} · ${c.dept}`,group:`exam:${c.key}`,kinds:['exam','followup'],
      buildingId:'opd',level:c.level,spot:roomSpot(room.id),roomId:room.id,clinicKey:c.key}));
  });
  counters.forEach(([kind,section,name,n,at])=>{ for (let i=0;i<n;i++) { const a = at(i,n);
    list.push({id:`counter:${kind}:${i+1}`,label:a.label ?? `${name} ${i+1}`,section,group:`counter:${kind}`,kinds:[kind],buildingId:a.buildingId,level:a.level,spot:a.spot}); } });
  return stationCache = {rev:layoutRevision(),every:list,on:list.filter(st=>!stationOff(st))};
}
export const counterServices = counters.map(([kind,section,name])=>({kind,section,name}));
export const stationById = (id?:string) => id ? allStations().find(s=>s.id===id) : undefined;
// Which queue a patient's step belongs to (clinic queues are shared by the clinic's rooms).
export function groupOf(p:Patient, kind:StepKind) {
  if (kind==='exam' || kind==='followup') return p.clinicKey ? `exam:${p.clinicKey}` : undefined;
  if (kind==='screening') return p.clinicKey ? `screening:${p.clinicKey}` : undefined;
  return ['registration','pharmacy','finance','lab','xray','triage'].includes(kind) ? `counter:${kind}` : undefined;
}
export function stationDoctor(st:Station, minute:number) {
  if (!st.roomId) return undefined;
  const d = roomDutyAt(st.roomId,minute/60);
  return d?.current && d.status!=='vacant' ? {name:doctorName(d.current.doctor,true),status:d.status} : {name:'',status:d?.status ?? 'vacant'};
}
const buildingShort = (id:string) => id==='opd'?'OPD':id==='er'?'ER':id==='diagnostics'?'ศูนย์การแพทย์':buildings.find(b=>b.id===id)?.name ?? id;
export const stationWhere = (st:Station) => `${st.label} · ${buildingShort(st.buildingId)} ชั้น ${st.level}`;
// Stations of one queue group share a waiting area: moving between them never sends the patient anywhere.
export const sameZone = (a:Station, b:Station) => a.group===b.group;
// What the patient has to do after a move — said plainly on their QR page and in the move dialog.
export function moveNote(from:Station|undefined, to:Station) {
  if (from && sameZone(from,to)) return 'รอที่เดิมได้เลย ไม่ต้องย้ายที่นั่ง · จะเรียกเข้า'+to.label;
  const zone = to.clinicKey ? `พื้นที่รอ ${to.section.split(' · ').slice(-1)[0]}` : to.section;
  return from && from.buildingId===to.buildingId && from.level===to.level ? `ไปรอที่${zone} (ชั้นเดียวกัน)` : `ไปรอที่${zone} · ${buildingShort(to.buildingId)} ชั้น ${to.level}`;
}
const clinicWaitSpot = (clinicKey:string, seed:string) => { const c = opdClinics().find(x=>x.key===clinicKey); if (!c) return undefined;
  const h = hash(seed); return waitingSpot('opd',c.level,c.deptIndex,(h%1000)/1000,((h>>10)%1000)/1000); };

// ---- Events ------------------------------------------------------------------------------------------------
// lock/unlock: keep a patient with this room (the assistant never moves them) · pause/resume: a station stops taking
// new patients for a while · config: a settings change, logged for the audit trail.
// report / resolve: a patient asks for help from their QR page, and the station or supervisor takes it on.
export type QueueAction = 'open'|'close'|'call'|'recall'|'start'|'hold'|'return'|'done'|'transfer'|'lock'|'unlock'|'pause'|'resume'|'config'|'report'|'resolve';
export type QueueEvent = {id:string; at:number; station:string; action:QueueAction; patientId?:string; step?:number; reason?:string; returnAfter?:number; target?:string; position?:'keep'|'end'; by?:string; key?:string};
export const SYSTEM_BY = 'ระบบ'; // `by` of moves made by the queue assistant
// ticket: a patient's help request carries their own page link (checked by the API, not stored).
export type QueueCommand = Omit<QueueEvent,'id'> & {ticket?:string};

// Replays staff events over the simulated journeys. A station that is open (staffed) takes over the steps the
// simulator would have given it from that moment; a call from any station takes over that patient's step.
// Steps after a manually finished step move by however much earlier/later it finished.
export function applyQueueEvents(patients:Patient[], events:QueueEvent[]):Patient[] {
  if (!events.length) return patients;
  const sorted = [...events].sort((a,b)=>a.at-b.at);
  const windows = new Map<string,{from:number;to:number}[]>();
  const byStep = new Map<string,QueueEvent[]>();
  sorted.forEach(e=>{
    if (e.action==='open') windows.set(e.station,[...(windows.get(e.station)??[]),{from:e.at,to:DAY}]);
    else if (e.action==='close') { const w = windows.get(e.station)?.at(-1); if (w && w.to===DAY) w.to = e.at; }
    else if (e.action==='report' || e.action==='resolve' || e.action==='config') return; // not queue moves
    else if (e.patientId!==undefined && e.step!==undefined) byStep.set(`${e.patientId}#${e.step}`,[...(byStep.get(`${e.patientId}#${e.step}`)??[]),e]);
  });
  const staffed = (station:string|undefined, t:number) => !!station && !!windows.get(station)?.some(w=>t>=w.from && t<w.to);
  return patients.map(p=>{
    let shift = 0, changed = false;
    const steps = p.steps.map((orig,i)=>{
      const s = {...orig};
      if (shift && !p.live) { s.start = Math.min(DAY,s.start+shift); s.called = Math.min(DAY,s.called+shift); s.end = Math.min(DAY,s.end+shift); changed = true; }
      const all = byStep.get(`${p.id}#${i}`) ?? [];
      const lockEv = all.filter(e=>e.action==='lock'||e.action==='unlock').at(-1);
      if (lockEv) { s.locked = lockEv.action==='lock'; changed = true; }
      const evs = all.filter(e=>e.action!=='lock' && e.action!=='unlock');
      const takenOver = staffed(orig.stationId,orig.called);
      if (!evs.length && !takenOver) return s;
      changed = true;
      const before = s.end;
      let station = takenOver ? orig.stationId : undefined, start:number|undefined, done:number|undefined, assigned:string|undefined, moved:QueueEvent|undefined, acted = false;
      const calls:number[] = [], holds:{at:number;until?:number;reason:string}[] = [];
      evs.forEach(e=>{
        if (e.action!=='transfer') acted = true;
        if (e.action==='call' || e.action==='recall') { calls.push(e.at); station = e.station; }
        else if (e.action==='start') { start ??= e.at; station = e.station; }
        else if (e.action==='hold') holds.push({at:e.at,until:e.returnAfter!==undefined?e.at+e.returnAfter:undefined,reason:e.reason ?? 'อื่น ๆ'});
        else if (e.action==='return') { const h = holds.at(-1); if (h && (h.until===undefined || h.until>e.at)) h.until = e.at; }
        else if (e.action==='done') { done = e.at; start ??= calls.at(-1) ?? e.at; } // done without "arrived": service ran from the last call
        // Moved to another room / counter: back to waiting there (keeps its place by arrival time, or joins the end).
        else if (e.action==='transfer' && e.target) { assigned = e.target; station = e.target; moved = e; acted = false; start = undefined; calls.length = 0;
          holds.forEach(h=>{ if (h.until===undefined || h.until>e.at) h.until = e.at; }); }
      });
      // A new call ends any hold still open.
      holds.forEach(h=>{ const next = calls.find(c=>c>h.at); if (next!==undefined && (h.until===undefined || h.until>next)) h.until = next; });
      const st = stationById(station);
      s.manual = station; s.calls = calls; s.holds = holds;
      if (assigned) { s.assigned = assigned; s.group = stationById(assigned)?.group; }
      if (moved?.position==='end') s.requeue = moved.at;
      if (moved) s.movedFrom = moved.station;
      s.called = start ?? DAY; s.end = done ?? DAY;
      // Moved to a room nobody runs on screen (now or later): the simulator serves it there, after the move.
      if (moved && !acted && !windows.get(moved.target!)?.some(w=>w.to>moved!.at)) {
        const dur = Math.max(5,orig.end-orig.called);
        s.called = Math.max(orig.called,moved.at+(moved.position==='end'?12:3)); s.end = s.called+dur; s.manual = undefined;
      }
      if (st) s.place = {...s.place,where:stationWhere(st),buildingId:st.buildingId,level:st.level,serve:st.spot};
      // Moved to another clinic's room: they wait in that clinic's waiting area from then on.
      const fromSt = stationById(orig.stationId);
      if (moved && st?.clinicKey && (!fromSt || !sameZone(fromSt,st)) && st.clinicKey!==p.clinicKey) { const w = clinicWaitSpot(st.clinicKey,`${p.id}#${i}`); if (w) s.place = {...s.place,wait:w}; }
      shift = s.end>=DAY ? DAY : shift+(s.end-before);
      return s;
    });
    return changed ? {...p,steps} : p;
  });
}

// ---- Station console view ----------------------------------------------------------------------------------
// ---- Priority lanes ---------------------------------------------------------------------------------------
// Elderly and wheelchair users come from the patient record; monks, pregnancy and disability are flagged at registration
// (simulated here by a stable hash, so the same patients carry the flag on every screen).
export type Priority = {key:'monk'|'pregnant'|'wheelchair'|'disabled'|'elderly'; label:string};
const hash = (str:string) => { let h = 2166136261; for (let i=0;i<str.length;i++) { h ^= str.charCodeAt(i); h = Math.imul(h,16777619); } return h>>>0; };
const priorityLabel:Record<Priority['key'],string> = {monk:'พระภิกษุ',pregnant:'หญิงตั้งครรภ์',wheelchair:'ใช้รถเข็น',disabled:'ผู้พิการ',elderly:'ผู้สูงอายุ'};
export const priorityKeys = Object.keys(priorityLabel) as Priority['key'][];
export const priorityText = (k:Priority['key']) => priorityLabel[k];
export function priorityOf(p:Patient):Priority|undefined {
  if (p.live) return p.priority ? {key:p.priority,label:priorityLabel[p.priority]} : undefined; // set by staff at registration
  const h = hash(`prio:${p.id}`)%100;
  if (!p.female && p.age!=='child' && h<2) return {key:'monk',label:'พระภิกษุ'};
  if (p.female && p.age==='adult' && h<6) return {key:'pregnant',label:'หญิงตั้งครรภ์'};
  if (p.help==='รถเข็น') return {key:'wheelchair',label:'ใช้รถเข็น'};
  if (p.age!=='child' && h>=6 && h<9) return {key:'disabled',label:'ผู้พิการ'};
  if (p.age==='elderly') return {key:'elderly',label:'ผู้สูงอายุ'};
  return undefined;
}
// Interleave: after `every` regular patients, the next call goes to the longest-waiting priority patient.
export type PriorityPolicy = {enabled:boolean; every:number};
export const DEFAULT_POLICY:PriorityPolicy = {enabled:true,every:3};

// ---- Station console view ----------------------------------------------------------------------------------
export type QueueEntry = {s:PatientState; key:number; mine:boolean; priority?:Priority};
export const stepGroup = (s:PatientState) => s.step.group ?? groupOf(s.p,s.step.kind);
// Everyone waiting for the station's queue group (a returned hold rejoins at its return time), ordered by arrival
// with priority patients interleaved per the policy, counting this station's recent calls.
export function stationQueue(patients:Patient[], st:Station, minute:number, policy:PriorityPolicy=DEFAULT_POLICY, events:QueueEvent[]=[]) {
  const now = patients.map(p=>patientAt(p,minute)).filter((x):x is PatientState=>!!x && st.kinds.includes(x.step.kind) && stepGroup(x)===st.group);
  const mine = now.filter(x=>x.step.manual===st.id);
  const current = mine.find(x=>x.status==='calling' || x.status==='serving');
  const fifo = now.filter(x=>x!==current && (x.status==='waiting' || x.status==='long') && (!x.step.assigned || x.step.assigned===st.id)
      && (!x.step.manual || x.step.manual===st.id || !(x.step.calls?.length)))
    .map(x=>({s:x,key:Math.max(x.step.start,x.step.requeue ?? 0,...(x.step.holds ?? []).filter(h=>h.until!==undefined && h.until<=minute).map(h=>h.until!)),mine:x.step.manual===st.id,priority:priorityOf(x.p)}))
    .sort((a,b)=>a.key-b.key);
  let waiting:QueueEntry[] = fifo;
  if (policy.enabled) {
    const byId = new Map(patients.map(p=>[p.id,p]));
    let streak = 0; // regular calls at this station since its last priority call
    for (const e of [...events].filter(e=>e.station===st.id && e.action==='call' && e.at<=minute).sort((a,b)=>b.at-a.at)) {
      const p = e.patientId ? byId.get(e.patientId) : undefined;
      if (p && priorityOf(p)) break; streak++;
    }
    const pri = fifo.filter(x=>x.priority), reg = fifo.filter(x=>!x.priority);
    waiting = [];
    while (pri.length || reg.length) {
      if (pri.length && (streak>=policy.every || !reg.length)) { waiting.push(pri.shift()!); streak = 0; }
      else { waiting.push(reg.shift()!); streak++; }
    }
  }
  const held = now.filter(x=>x.step.manual===st.id && (x.status==='held' || x.status==='missed'));
  const calledElsewhere = now.filter(x=>x.status==='calling' && x.step.manual && x.step.manual!==st.id);
  return {current,waiting,held,calledElsewhere};
}
// Stations currently staffed (opened and not closed) — the only valid targets for moving a queue.
export function openStations(events:QueueEvent[]) {
  const last = new Map<string,QueueAction>();
  [...events].filter(e=>e.action==='open'||e.action==='close').sort((a,b)=>a.at-b.at).forEach(e=>last.set(e.station,e.action));
  return allStations().filter(s=>last.get(s.id)==='open');
}
export const actionText:Record<QueueAction,string> = {open:'เปิดจุดบริการ',close:'ปิดจุดบริการ',call:'เรียก',recall:'เรียกซ้ำ',start:'เริ่มให้บริการ',hold:'พักคิว',return:'คืนคิว',done:'เสร็จ',transfer:'ย้ายคิว',
  lock:'ล็อกคิวไว้กับห้อง',unlock:'ปลดล็อกคิว',pause:'พักช่องชั่วคราว',resume:'กลับมาให้บริการ',config:'ตั้งค่า',report:'ผู้ป่วยแจ้งขอความช่วยเหลือ',resolve:'รับเรื่องแล้ว'};
// Help topics a patient can send from their QR page (no free text: nothing personal goes in).
export const helpTopics = ['หาห้อง / จุดบริการไม่เจอ','รอนานผิดปกติ','เรียกแล้วไม่ได้ยิน / คิวผิด','ต้องการรถเข็น / ผู้ช่วย','ไม่สบายระหว่างรอ'];
// A help request's life: reported → (assigned to a porter: resolve with reason "assign:<name>") → closed (resolve).
export type HelpRequest = {report:QueueEvent; assigned?:QueueEvent; closed?:QueueEvent};
export function helpRequests(events:QueueEvent[]):HelpRequest[] {
  const res = events.filter(e=>e.action==='resolve');
  return events.filter(e=>e.action==='report').map(report=>{ const mine = res.filter(e=>e.target===report.id);
    return {report,assigned:mine.filter(e=>e.reason?.startsWith('assign:')).at(-1),closed:mine.find(e=>!e.reason?.startsWith('assign:'))}; });
}
// Open help requests nobody has taken on yet (shown to the station and the supervisor).
export function openReports(events:QueueEvent[]) { return helpRequests(events).filter(h=>!h.closed && !h.assigned).map(h=>h.report); }
export const PORTER_TOPIC = 'ต้องการรถเข็น / ผู้ช่วย';
// Porters (wheelchair / patient transport) on duty — staff, not patients. Base = where they wait between jobs.
export const porters = [{id:'po-1',name:'เวรเปล 1',buildingId:'opd',level:1},{id:'po-2',name:'เวรเปล 2',buildingId:'opd',level:1},
  {id:'po-3',name:'เวรเปล 3',buildingId:'diagnostics',level:1},{id:'po-4',name:'เวรเปล 4',buildingId:'er',level:1}];

// ---- Settings: hospital defaults → per service group → per station ----------------------------------------
// A group (one clinic's exam rooms, one clinic's screening counters, all pharmacy counters…) uses the hospital
// default for every rule it does not set itself. Stations only carry a queue cap.
export type AssistMode = 'off'|'suggest'|'auto';
export type QueueRules = {mode:AssistMode; cap:number; stallMin:number; slowFactor:number; imbalance:number};
// hours: OPD service hours the simulated day is built on · demoOffset: minutes every screen adds to the real clock (testing).
// layout: departments added and departments / rooms / counters switched off (see setLayout in scene-data).
export type QueueSettings = {system:QueueRules; groups:Record<string,Partial<QueueRules>>; stations:Record<string,{cap?:number}>; hours?:{opdOpen:number; opdClose:number}; demoOffset?:number; layout?:Layout; dataMode?:DataMode; updatedAt?:string; updatedBy?:string};
// demo: the simulated day (default) · live: only real patients taken into the queue (visits), no simulation.
export type DataMode = 'demo'|'live';
export type SettingsPatch = {system?:Partial<QueueRules>; groups?:Record<string,Partial<Record<keyof QueueRules,QueueRules[keyof QueueRules]|null>>|null>; stations?:Record<string,{cap?:number|null}|null>; hours?:{opdOpen:number; opdClose:number}|null; demoOffset?:number|null; layout?:Layout|null; dataMode?:DataMode|null};
export const DEFAULT_RULES:QueueRules = {mode:'suggest',cap:12,stallMin:5,slowFactor:2,imbalance:4};
export const DEFAULT_SETTINGS:QueueSettings = {system:DEFAULT_RULES,groups:{},stations:{}};
// The simulated day is built on the OPD hours and the layout: every screen applies them before generating patients
// and regenerates when worldKey changes.
export const worldKey = (s:QueueSettings) => JSON.stringify([s.hours ?? null,s.layout ?? null]);
let liveMode = false;
export function applyWorld(s:QueueSettings) { setServiceHours(s.hours); setLayout(s.layout); liveMode = s.dataMode==='live'; }
export const isLive = (s:QueueSettings) => s.dataMode==='live';
// The patients every screen starts from: the simulated day, or (live mode) today's real visits. Live patients
// depend on the log (each step starts when the previous one was finished), so they are rebuilt with it.
export function basePatients(s:QueueSettings, visits:LiveVisit[], events:QueueEvent[]):Patient[] {
  applyWorld(s);
  return isLive(s) ? livePatients(visits,events) : generatePatients('demo-day');
}
export const modeText:Record<AssistMode,string> = {off:'ปิด',suggest:'แนะนำ',auto:'อัตโนมัติ'};
export const rulesFor = (s:QueueSettings, group:string):QueueRules => ({...s.system,...(s.groups[group] ?? {})});
export const capFor = (s:QueueSettings, st:Station) => s.stations[st.id]?.cap ?? rulesFor(s,st.group).cap; // 0 = no cap
// Same merge on the API and offline: null clears an override (back to the inherited value).
export function mergeSettings(s:QueueSettings, patch:SettingsPatch):QueueSettings {
  const out:QueueSettings = {system:{...s.system,...(patch.system ?? {})},groups:{...s.groups},stations:{...s.stations},hours:s.hours,demoOffset:s.demoOffset,layout:s.layout,dataMode:s.dataMode,updatedAt:s.updatedAt,updatedBy:s.updatedBy};
  if (patch.layout!==undefined) { if (patch.layout===null) delete out.layout; else out.layout = {off:[...(patch.layout.off ?? [])],depts:[...(patch.layout.depts ?? [])]}; }
  if (!out.layout) delete out.layout;
  if (patch.hours!==undefined) { if (patch.hours===null) delete out.hours; else out.hours = {...patch.hours}; }
  if (patch.demoOffset!==undefined) { if (patch.demoOffset===null) delete out.demoOffset; else out.demoOffset = patch.demoOffset; }
  if (patch.dataMode!==undefined) { if (patch.dataMode===null || patch.dataMode==='demo') delete out.dataMode; else out.dataMode = patch.dataMode; }
  if (!out.dataMode) delete out.dataMode;
  for (const [g,v] of Object.entries(patch.groups ?? {})) {
    if (v===null) { delete out.groups[g]; continue; }
    const next:Record<string,unknown> = {...(out.groups[g] ?? {})};
    for (const [k,x] of Object.entries(v)) { if (x===null || x===undefined) delete next[k]; else next[k] = x; }
    if (Object.keys(next).length) out.groups[g] = next as Partial<QueueRules>; else delete out.groups[g];
  }
  for (const [id,v] of Object.entries(patch.stations ?? {})) {
    if (v===null || v.cap===null || v.cap===undefined) delete out.stations[id]; else out.stations[id] = {cap:v.cap};
  }
  return out;
}
export type QueueGroup = {id:string; name:string; section:string; stations:Station[]};
let groupCache:{rev:number; list:QueueGroup[]}|null = null;
export function queueGroups():QueueGroup[] {
  if (groupCache?.rev===layoutRevision()) return groupCache.list;
  const map = new Map<string,Station[]>();
  allStations().forEach(st=>map.set(st.group,[...(map.get(st.group) ?? []),st]));
  const list = [...map.entries()].map(([id,list])=>{ const st = list[0], dept = st.section.split(' · ').slice(-1)[0];
    const name = id.startsWith('exam:') ? `ห้องตรวจ ${dept}` : id.startsWith('screening:') ? `ซักประวัติ ${dept}` : st.section;
    return {id,name,section:st.clinicKey?st.section.split(' · ')[0]:'จุดบริการร่วม',stations:list}; });
  groupCache = {rev:layoutRevision(),list};
  return list;
}
export const groupName = (id:string) => queueGroups().find(g=>g.id===id)?.name ?? id;
// Name of what an event or setting applies to: the hospital, a service group or one station.
export const scopeName = (id:string) => id==='system' ? 'ทั้งโรงพยาบาล' : stationById(id)?.label ?? groupName(id);

// ---- Station health & the queue assistant -----------------------------------------------------------------
// Everything here is worked out from what staff already do (call, start, done, pause) — nobody reports status.
export type HealthState = 'ok'|'auto'|'paused'|'stalled'|'slow'|'away';
export type StationHealth = {state:HealthState; text:string; until?:number};
export const healthText:Record<HealthState,string> = {ok:'ทันงาน',auto:'ตัวจำลองดูแล',paused:'พักช่อง',stalled:'ไม่ตอบรับ',slow:'ช้ากว่าปกติ',away:'แพทย์ไม่อยู่'};
const typicalMin:Partial<Record<StepKind,number>> = {screening:5,exam:8,followup:5,registration:3,pharmacy:3,finance:2,lab:4,xray:10,triage:5};
export function pausedUntil(st:Station, events:QueueEvent[], minute:number) {
  const last = events.filter(e=>e.station===st.id && (e.action==='pause'||e.action==='resume'||e.action==='close') && e.at<=minute).sort((a,b)=>a.at-b.at).at(-1);
  if (!last || last.action!=='pause') return undefined;
  const until = last.returnAfter!==undefined ? last.at+last.returnAfter : DAY;
  return until>minute ? until : undefined;
}
// Average minutes from first call to done at this station today (falls back to a typical value for the service).
export function serviceMinutes(st:Station, events:QueueEvent[]) {
  const mine = events.filter(e=>e.station===st.id), done = mine.filter(e=>e.action==='done');
  const mins = done.map(d=>{ const f = mine.find(x=>x.patientId===d.patientId && x.step===d.step && (x.action==='call'||x.action==='start')); return f ? d.at-f.at : undefined; }).filter((x):x is number=>x!==undefined);
  return mins.length>=3 ? mins.reduce((a,b)=>a+b,0)/mins.length : typicalMin[st.kinds[0]] ?? 5;
}
export function stationHealth(st:Station, minute:number, events:QueueEvent[], rules:QueueRules, cur:PatientState|undefined, load:number, open:boolean):StationHealth {
  const pause = pausedUntil(st,events,minute);
  if (pause!==undefined) return {state:'paused',text:pause>=DAY?'พักช่อง (ไม่กำหนดเวลา)':`พักช่องถึง ${String(Math.floor(pause/60)).padStart(2,'0')}:${String(Math.floor(pause%60)).padStart(2,'0')}`,until:pause};
  const doc = stationDoctor(st,minute);
  if (doc && doc.status!=='active') return {state:'away',text:doc.status==='break'?'แพทย์พัก':'ไม่มีแพทย์เข้าเวร'};
  if (!open) return {state:'auto',text:liveMode?'ยังไม่เปิดช่อง · ไม่มีผู้เรียกคิว':'ตัวจำลองเรียกคิวแทน'};
  if (cur?.status==='calling') { const last = cur.step.calls?.at(-1) ?? minute;
    if (minute-last>=rules.stallMin) return {state:'stalled',text:`เรียก ${cur.p.queue} แล้วไม่มีการตอบรับ ${Math.floor(minute-last)} นาที`}; }
  else if (cur?.status==='serving') { const took = minute-cur.step.called, avg = serviceMinutes(st,events);
    if (took>=avg*rules.slowFactor && took>=avg+4) return {state:'slow',text:`ให้บริการ ${cur.p.queue} นาน ${Math.floor(took)} นาที (ปกติ ~${Math.round(avg)})`}; }
  else if (load>0) { const lastAct = Math.max(-1,...events.filter(e=>e.station===st.id && e.at<=minute).map(e=>e.at));
    if (lastAct>=0 && minute-lastAct>=rules.stallMin) return {state:'stalled',text:`มีคนรอ ${load} คน แต่ไม่ได้เรียกคิว ${Math.floor(minute-lastAct)} นาที`}; }
  return {state:'ok',text:'ทันงาน'};
}
export type Suggestion = {key:string; kind:'paused'|'stalled'|'slow'|'away'|'cap'|'imbalance'; group:string; from:Station; to:Station; moves:PatientState[]; reason:string};
// stranded: a station that should hand its queue over but has no healthy station in its group to take it.
export type AssistView = {loads:Map<string,PatientState[]>; health:Map<string,StationHealth>; suggestions:Suggestion[]; lockedStuck:Map<string,PatientState[]>; full:Set<string>; stranded:Map<string,number>};
const recentlyMoved = (events:QueueEvent[], s:PatientState, minute:number) =>
  events.some(e=>e.action==='transfer' && e.patientId===s.p.id && e.step===s.index && minute-e.at<15);
// Who is effectively waiting for each station: patients sent or booked to it, and its share of the simulator's plan.
export function stationLoads(states:PatientState[]) {
  const loads = new Map<string,PatientState[]>();
  states.forEach(s=>{ if (s.status!=='waiting' && s.status!=='long') return; const id = s.step.assigned ?? s.step.stationId; if (id) loads.set(id,[...(loads.get(id) ?? []),s]); });
  return loads;
}
export function queueAssist(patients:Patient[], minute:number, events:QueueEvent[], settings:QueueSettings):AssistView {
  const states = patients.map(p=>patientAt(p,minute)).filter((x):x is PatientState=>!!x);
  const loads = stationLoads(states), open = new Set(openStations(events).map(s=>s.id));
  const health = new Map<string,StationHealth>(), suggestions:Suggestion[] = [], lockedStuck = new Map<string,PatientState[]>(), full = new Set<string>(), stranded = new Map<string,number>();
  for (const g of queueGroups()) {
    const rules = rulesFor(settings,g.id);
    g.stations.forEach(st=>{ const cur = states.find(s=>s.step.manual===st.id && (s.status==='calling'||s.status==='serving'));
      health.set(st.id,stationHealth(st,minute,events,rules,cur,loads.get(st.id)?.length ?? 0,open.has(st.id))); });
    if (rules.mode==='off' || g.stations.length<2) continue;
    const good = (st:Station) => ['ok','auto'].includes(health.get(st.id)!.state);
    const room = new Map(g.stations.map(st=>{ const cap = capFor(settings,st); return [st.id,cap>0?cap-(loads.get(st.id)?.length ?? 0):Infinity]; }));
    const taken = new Set<string>();
    const plan = (from:Station, list:PatientState[], kind:Suggestion['kind'], reason:string) => {
      // Never move the same patient twice, never someone who was just called (they may be walking over).
      const movable = list.filter(s=>!s.step.locked && !s.step.movedFrom && !taken.has(s.p.id) && !recentlyMoved(events,s,minute) && !(s.step.calls ?? []).some(c=>minute-c<5));
      const stuck = list.filter(s=>s.step.locked); if (stuck.length && kind!=='cap' && kind!=='imbalance') lockedStuck.set(from.id,stuck);
      const targets = g.stations.filter(t=>t.id!==from.id && good(t) && room.get(t.id)!>0);
      if (!movable.length) return;
      // Nowhere to send them: worth flagging only for stations people run (a simulated room on a planned break just waits).
      if (!targets.length) { if (kind==='cap') full.add(g.id); else if (open.has(from.id) || kind==='paused') stranded.set(from.id,movable.length); return; }
      const by = new Map<string,PatientState[]>();
      movable.forEach(s=>{ const t = targets.filter(x=>room.get(x.id)!>0).sort((a,b)=>(loads.get(a.id)?.length ?? 0)+(by.get(a.id)?.length ?? 0)-((loads.get(b.id)?.length ?? 0)+(by.get(b.id)?.length ?? 0)))[0];
        if (!t) return; by.set(t.id,[...(by.get(t.id) ?? []),s]); room.set(t.id,room.get(t.id)!-1); taken.add(s.p.id); });
      if (movable.some(s=>!taken.has(s.p.id)) && kind==='cap') full.add(g.id);
      by.forEach((moves,tid)=>suggestions.push({key:`${kind}:${from.id}:${tid}:${moves.map(m=>m.p.id).join(',')}`,kind,group:g.id,from,to:stationById(tid)!,moves,reason}));
    };
    const sortFront = (list:PatientState[]) => [...list].sort((a,b)=>a.step.start-b.step.start);
    for (const st of g.stations) {
      const h = health.get(st.id)!, list = sortFront(loads.get(st.id) ?? []);
      if (!list.length) continue;
      if (h.state==='paused' || h.state==='away' || h.state==='stalled') plan(st,list,h.state,`${st.label}: ${h.text}`);
      else if (h.state==='slow') plan(st,list.slice(1),'slow',`${st.label}: ${h.text}`);
      else { const cap = capFor(settings,st); if (cap>0 && list.length>cap) plan(st,list.slice(cap).reverse(),'cap',`${st.label} มีคนรอ ${list.length} คน เกินเพดาน ${cap}`); }
    }
    // Uneven queues between healthy stations: send the longest-waiting few to the emptiest one.
    const healthy = g.stations.filter(good).map(st=>({st,n:(loads.get(st.id) ?? []).filter(s=>!taken.has(s.p.id)).length})).sort((a,b)=>b.n-a.n);
    if (healthy.length>=2 && healthy[0].n-healthy.at(-1)!.n>=rules.imbalance) {
      const hi = healthy[0], lo = healthy.at(-1)!, k = Math.floor((hi.n-lo.n)/2);
      const list = sortFront(loads.get(hi.st.id) ?? []).filter(s=>!taken.has(s.p.id) && !s.step.locked && !s.step.movedFrom && !recentlyMoved(events,s,minute) && !(s.step.calls ?? []).some(c=>minute-c<5)).slice(0,k);
      if (list.length) { list.forEach(s=>taken.add(s.p.id));
        suggestions.push({key:`imbalance:${hi.st.id}:${lo.st.id}:${list.map(m=>m.p.id).join(',')}`,kind:'imbalance',group:g.id,from:hi.st,to:lo.st,moves:list,reason:`${hi.st.label} รอ ${hi.n} คน · ${lo.st.label} รอ ${lo.n} คน`}); }
    }
  }
  return {loads,health,suggestions,lockedStuck,full,stranded};
}
export const suggestionText:Record<Suggestion['kind'],string> = {paused:'ช่องพักชั่วคราว',stalled:'ไม่มีการตอบรับ',slow:'ให้บริการช้ากว่าปกติ',away:'แพทย์ไม่อยู่',cap:'คิวเกินเพดาน',imbalance:'คิวไม่สมดุล'};

// ---- Sync hook ---------------------------------------------------------------------------------------------
const storeKey = () => `hdt.queueEvents.${new Date().toISOString().slice(0,10)}`;
const loadLocal = ():QueueEvent[] => { try { return JSON.parse(localStorage.getItem(storeKey()) ?? '[]'); } catch { return []; } };
const saveLocal = (ev:QueueEvent[]) => { try { localStorage.setItem(storeKey(),JSON.stringify(ev)); } catch { /* ignore */ } };
const settingsKey = 'hdt.queueSettings';
const loadSettings = ():QueueSettings => { try { const v = JSON.parse(localStorage.getItem(settingsKey) ?? 'null'); return v ? mergeSettings(DEFAULT_SETTINGS,v) : DEFAULT_SETTINGS; } catch { return DEFAULT_SETTINGS; } };
// ---- Staff accounts (the API checks every action; the screens only hide what a role cannot do) ----
export type Role = 'admin'|'supervisor'|'staff';
// clinics: the clinics a staff member / supervisor works for (clinic keys, 'er' = emergency room); empty = every clinic.
export type AuthUser = {id:number; username:string; name:string; role:Role; active:boolean; lastLogin?:string; clinics?:string[]};
// Same rule as the server (apps/api/src/flow.gateway.ts `covers`): administrators and accounts without a list cover all.
export const covers = (u:AuthUser|null|undefined, clinic:string) => !u || u.role==='admin' || !u.clinics?.length || u.clinics.includes(clinic);
export const roleText:Record<Role,string> = {admin:'ผู้ดูแลระบบ',supervisor:'หัวหน้างาน',staff:'เจ้าหน้าที่'};
const roleRank:Record<Role,number> = {staff:1,supervisor:2,admin:3};
export const canDo = (u:AuthUser|null|undefined, role:Role) => !!u && roleRank[u.role]>=roleRank[role];
export type UserInput = {id?:number; username?:string; name?:string; role?:Role; active?:boolean; password?:string; clinics?:string[]};
type Res = {ok:boolean; reason?:string; auth?:boolean};
const sessionKey = 'hdt.session';
const loadToken = () => { try { return localStorage.getItem(sessionKey) ?? ''; } catch { return ''; } };
export type QueueSync = {events:QueueEvent[]; online:boolean; send:(cmd:QueueCommand)=>Promise<Res>;
  settings:QueueSettings; saveSettings:(patch:SettingsPatch, audit:{at:number; scope:string; summary:string; by?:string})=>Promise<Res>;
  // authReady: the API has said who this session is (null = not signed in). Offline there is no sign-in.
  user:AuthUser|null; authReady:boolean; login:(username:string, password:string)=>Promise<Res>; logout:()=>void;
  listUsers:()=>Promise<{ok:boolean; reason?:string; users?:AuthUser[]}>; saveUser:(u:UserInput)=>Promise<{ok:boolean; reason?:string; users?:AuthUser[]}>;
  resolveTicket:(token:string)=>Promise<TicketRes>; familyTicket:(token:string)=>Promise<TicketRes>;
  // features: what the API has switched on (LINE notifications need the hospital's OA settings).
  features:Features; lineLink:(token:string, queue:string)=>Promise<Res & {code?:string; url?:string; expiresAt?:string}>;
  // Real patients (live data mode): today's visits, and the staff commands that take patients in and send them on.
  visits:LiveVisit[]; enterVisit:(v:VisitInput, key:string)=>Promise<VisitRes>; addVisitStep:(visitId:string, kind:StepKind, at:number, key:string)=>Promise<VisitRes>;
  cancelVisit:(visitId:string, reason:string)=>Promise<VisitRes>;
  // Phase 2 screens (booking …): any API command, and a counter that moves when bookings change somewhere.
  api:<T extends Res = Res & Record<string,unknown>>(event:string, body:unknown)=>Promise<T & {code?:string}>; bookingRev:number; apptRev:number};
// What the API has switched on: LINE notifications (needs the hospital's OA settings) and the Phase 2 switches.
export type Phase2Flag = 'accountLinking'|'generalBooking'|'appointments'|'notifications'|'wayfinding'|'staffOverrides';
export type Features = {line:boolean; phase2:Partial<Record<Phase2Flag,boolean>>};
// hn: optional, after the ID card was checked — links the visit to the patient's record (their LINE sees it). Never shown.
export type VisitInput = {flow:'opd'|'er'; clinicKey?:string; dept?:string; prefix?:string; priority?:Priority['key']; triage?:number; at:number; hn?:string};
export type VisitRes = Res & {code?:string; visit?:LiveVisit};
// One key per intended action, kept by the form until it succeeds: tapping again after "no reply" returns the
// first result instead of a second patient / step.
export const actionKey = () => `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;

// ---- Patient links (/q/<token>) ----------------------------------------------------------------------------
// The API issues random tokens that expire at the end of the day; staff can re-issue (older links stop working).
// Offline (no API) the demo falls back to a link derived from the patient id — fine for a local demo only.
export type Ticket = {token:string; patientId:string; kind:'patient'|'family'; expiresAt:string};
export type TicketRes = {ok:boolean; reason?:string; code?:string; ticket?:Ticket};
let ticketApi:((patientId:string, renew:boolean)=>Promise<TicketRes>)|null = null;
const ticketListeners = new Set<()=>void>(), ticketCache = new Map<string,Ticket>();
const setTicketApi = (fn:typeof ticketApi) => { ticketApi = fn; if (!fn) ticketCache.clear(); ticketListeners.forEach(l=>l()); };
// The link for a patient's QR: {token, expiresAt} from the API, or the offline demo link. `active` = only ask when shown.
export function useTicket(p:Patient, active:boolean) {
  const [state,setState] = useState<{token:string; expiresAt?:string; offline?:boolean; error?:string}|null>(null);
  const [rev,setRev] = useState(0);
  useEffect(()=>{ const l = ()=>setRev(r=>r+1); ticketListeners.add(l); return ()=>{ ticketListeners.delete(l); }; },[]);
  const load = useCallback(async (renew=false)=>{
    if (!ticketApi) { setState({token:patientToken(p),offline:true}); return; }
    const hit = ticketCache.get(p.id);
    if (hit && !renew && hit.expiresAt>new Date().toISOString()) { setState({token:hit.token,expiresAt:hit.expiresAt}); return; }
    const r = await ticketApi(p.id,renew);
    if (r.ok && r.ticket) { ticketCache.set(p.id,r.ticket); setState({token:r.ticket.token,expiresAt:r.ticket.expiresAt}); }
    else setState({token:'',error:r.reason ?? 'ออก QR ไม่สำเร็จ'});
  },[p]);
  useEffect(()=>{ if (active) void load(); },[active,load,rev]);
  return {...(state ?? {token:''}),renew:()=>load(true)};
}
export function useQueueEvents():QueueSync {
  const [events,setEvents] = useState<QueueEvent[]>([]);
  const [online,setOnline] = useState(false);
  const [settings,setSettings] = useState<QueueSettings>(DEFAULT_SETTINGS);
  const [user,setUser] = useState<AuthUser|null>(null);
  const [authReady,setAuthReady] = useState(false);
  const [features,setFeatures] = useState<Features>({line:false,phase2:{}});
  const [bookingRev,setBookingRev] = useState(0);
  const [apptRev,setApptRev] = useState(0);
  const [visits,setVisits] = useState<LiveVisit[]>([]);
  const socket = useRef<Socket|null>(null);
  useEffect(()=>{
    setEvents(loadLocal()); setSettings(loadSettings());
    // The session token rides in the handshake (read again on every reconnect).
    const api = apiSocket(), s = io(`${api.url}/hospital`,{...api.opts,reconnectionDelay:3000,auth:cb=>cb({token:loadToken()})});
    socket.current = s;
    s.on('connect',()=>setOnline(true));
    s.on('auth:me',(u:AuthUser|null)=>{ setUser(u); setAuthReady(true); if (!u) { try { localStorage.removeItem(sessionKey); } catch { /* ignore */ } } });
    s.on('features',(f:{line?:boolean; phase2?:Features['phase2']})=>setFeatures({line:!!f?.line,phase2:f?.phase2 ?? {}}));
    s.on('booking:changed',()=>setBookingRev(r=>r+1));
    s.on('appointment:changed',()=>setApptRev(r=>r+1));
    s.on('disconnect',()=>setOnline(false));
    s.on('visits',(list:LiveVisit[])=>setVisits(Array.isArray(list)?list:[]));
    s.on('visit',(v:LiveVisit)=>setVisits(prev=>{ const i = prev.findIndex(x=>x.id===v.id); if (i<0) return [...prev,v]; const next = [...prev]; next[i] = v; return next; }));
    s.on('connect_error',()=>setOnline(false));
    s.on('queue:events',(list:QueueEvent[])=>{ setEvents(list); saveLocal(list); });
    s.on('queue:event',(e:QueueEvent)=>setEvents(prev=>{ if (prev.some(x=>x.id===e.id)) return prev; const next = [...prev,e]; saveLocal(next); return next; }));
    s.on('queue:settings',(v:QueueSettings)=>{ const m = mergeSettings(DEFAULT_SETTINGS,v); setSettings(m); try { localStorage.setItem(settingsKey,JSON.stringify(m)); } catch { /* ignore */ } });
    return ()=>{ s.close(); };
  },[]);
  const addLocal = (cmd:QueueCommand) => {
    const e = {...cmd,id:`local-${Date.now()}-${Math.random().toString(36).slice(2,7)}`};
    setEvents(prev=>{ if (cmd.key && prev.some(x=>x.key===cmd.key)) return prev; const next = [...prev,e]; saveLocal(next); return next; });
  };
  const request = useCallback(<T extends Res>(event:string, body:unknown) => new Promise<T>(resolve=>{
    const s = socket.current;
    if (!s?.connected) { resolve({ok:false,reason:'เชื่อมต่อระบบไม่ได้'} as T); return; }
    s.timeout(5000).emit(event,body,(err:unknown,res?:T)=>{ const r = err ? {ok:false,reason:'API ไม่ตอบกลับ'} as T : res ?? {ok:true} as T;
      if (r.auth) setUser(null); // session expired / signed out elsewhere
      resolve(r); });
  }),[]);
  const login = useCallback(async (username:string, password:string)=>{
    const r = await request<Res & {token?:string; user?:AuthUser}>('auth:login',{username,password});
    if (r.ok && r.token && r.user) { try { localStorage.setItem(sessionKey,r.token); } catch { /* ignore */ } setUser(r.user); }
    return r;
  },[request]);
  const logout = useCallback(()=>{ void request('auth:logout',{}); try { localStorage.removeItem(sessionKey); } catch { /* ignore */ } setUser(null); },[request]);
  const listUsers = useCallback(()=>request<Res & {users?:AuthUser[]}>('users:list',{}),[request]);
  const saveUser = useCallback((u:UserInput)=>request<Res & {users?:AuthUser[]}>('users:save',u),[request]);
  const resolveTicket = useCallback((token:string)=>request<TicketRes>('ticket:resolve',{token}),[request]);
  const familyTicket = useCallback((token:string)=>request<TicketRes>('ticket:family',{token}),[request]);
  const lineLink = useCallback((token:string, queue:string)=>request<Res & {code?:string; url?:string; expiresAt?:string}>('line:link',{token,queue}),[request]);
  // Signed-in staff on a connected screen: QR buttons get real links from the API.
  useEffect(()=>{ setTicketApi(online && canDo(user,'staff') ? (patientId,renew)=>request<TicketRes>('ticket:issue',{patientId,renew}) : null); },[online,user,request]);
  const send = useCallback(async (cmd:QueueCommand)=>{
    const s = socket.current;
    if (s?.connected) return await request<Res>('queue:command',cmd);
    // Offline: keep it in this browser only.
    addLocal(cmd);
    return {ok:true};
  },[request]);
  const saveSettings = useCallback(async (patch:SettingsPatch, audit:{at:number; scope:string; summary:string; by?:string})=>{
    const s = socket.current;
    if (s?.connected) return await request<Res>('queue:settings:set',{patch,...audit});
    setSettings(prev=>{ const m = mergeSettings(prev,patch); try { localStorage.setItem(settingsKey,JSON.stringify(m)); } catch { /* ignore */ } return m; });
    addLocal({at:audit.at,station:audit.scope,action:'config',reason:audit.summary,by:audit.by});
    return {ok:true};
  },[request]);
  const enterVisit = useCallback((v:VisitInput, key:string)=>request<VisitRes>('visit:enter',{...v,key}),[request]);
  const addVisitStep = useCallback((visitId:string, kind:StepKind, at:number, key:string)=>request<VisitRes>('visit:step',{visitId,kind,at,key}),[request]);
  const cancelVisit = useCallback((visitId:string, reason:string)=>request<VisitRes>('visit:cancel',{visitId,reason}),[request]);
  const api = useCallback(<T extends Res>(event:string, body:unknown)=>request<T & {code?:string}>(event,body),[request]) as QueueSync['api'];
  return {events,online,send,settings,saveSettings,user,authReady,login,logout,listUsers,saveUser,resolveTicket,familyTicket,features,lineLink,visits,enterVisit,addVisitStep,cancelVisit,api,bookingRev,apptRev};
}

// Thai announcement, read character by character so queue numbers are unambiguous.
const letterTh:Record<string,string> = {A:'เอ',B:'บี',C:'ซี',D:'ดี',E:'อี',F:'เอฟ',G:'จี',H:'เอช',I:'ไอ',R:'อาร์'};
const digitTh = ['ศูนย์','หนึ่ง','สอง','สาม','สี่','ห้า','หก','เจ็ด','แปด','เก้า'];
export function announce(queue:string, where:string) {
  if (typeof window==='undefined' || !('speechSynthesis' in window)) return false;
  const spoken = queue.split('').map(c=>/\d/.test(c)?digitTh[Number(c)]:letterTh[c] ?? c).join(' ');
  // Room and counter numbers are read digit by digit, as Thai hospitals announce them: 204 → "สอง ศูนย์ สี่" (not "สองร้อยสี่").
  const place = where.replace(/\d+/g,n=>` ${n.split('').map(d=>digitTh[Number(d)]).join(' ')} `).replace(/\s+/g,' ').trim();
  const u = new SpeechSynthesisUtterance(`ขอเชิญหมายเลข ${spoken} ที่ ${place}`);
  u.lang = 'th-TH'; u.rate = 0.9;
  window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
  return true;
}
export { NO_SHOW };
