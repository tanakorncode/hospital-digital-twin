// Public queue screens: what a waiting-area display (one department / counter group) and a door display
// (one exam room or counter) show. Used by the 3D screens on the map and by the /tv pages, so both always agree.
// Queue numbers only — never names or HN — because these are shown in public.
import { clinicOpen, opdClinics, patientAt, type Patient, type PatientState, type StepKind } from './patients';
import { DEFAULT_POLICY, counterServices, pausedUntil, stationById, stationDoctor, stationQueue, type QueueEvent } from './queue';

export type ScreenRow = {label:string; queue:string; calling:boolean; station?:string};
// link: the /tv page showing this same screen full size · place: where the waiting area is (for the TV's floor plan)
// · waiting: everyone still waiting (next[] is only the first few).
export type ScreenPlace = {buildingId:string; level:number; zone?:number};
export type ScreenData = {title:string; letter?:string; rows:ScreenRow[]; next:string[]; waiting:number; closed?:boolean; link:string; place?:ScreenPlace};

// OPD floor 1: the three counter groups, one per waiting band (same order as the floor plan).
export const counterZones:[StepKind,string][] = [['registration','ลงทะเบียน'],['pharmacy','ห้องยา · รับยา'],['finance','การเงิน']];
const stationShort = (id?:string) => !id ? '' : id.startsWith('room:') ? `ห้อง ${id.split('-').pop()}`
 : id.startsWith('screen:') ? `ซักประวัติ ${id.split(':')[2] ?? '1'}` : id.startsWith('counter:') ? `ช่อง ${id.split(':')[2]}` : '';
// Being called: a staff call, or the simulator's call during its first minute and a half (the patient walking in).
const callOf = (st:PatientState, m:number) => st.status==='calling' || (m>=st.step.called && m-st.step.called<1.5);
const stationOf = (st:PatientState) => st.step.manual ?? st.step.assigned ?? st.step.stationId;
const stillWaiting = (st:PatientState, m:number) => m<st.step.called && st.status!=='calling' && st.status!=='held' && st.status!=='missed';
export const nowStates = (patients:Patient[], m:number) => patients.map(p=>patientAt(p,m)).filter((x):x is PatientState=>!!x);

// Waiting-area screen for the department (or counter group) in band `zone` of OPD floor `level`.
export function screenData(level:number, zone:number, now:PatientState[], m:number):ScreenData|null {
 if (level===1) { const z = counterZones[zone]; return z ? {...counterScreen(z[0],z[1],now,m),place:{buildingId:'opd',level:1,zone}} : null; }
 const c = opdClinics().find(x=>x.level===level && x.deptIndex===zone); if (!c) return null;
 const link = `/tv?dept=${encodeURIComponent(c.dept)}`;
 const place = {buildingId:'opd',level:c.level,zone:c.deptIndex};
 if (!clinicOpen(c)) return {title:c.dept,letter:c.letter,rows:[],next:[],waiting:0,closed:true,link,place};
 const mine = now.filter(st=>st.p.clinicKey===c.key && ['screening','exam','followup'].includes(st.step.kind));
 const rows = mine.filter(st=>m>=st.step.called || st.status==='calling')
  .sort((a,b)=>Number(callOf(b,m))-Number(callOf(a,m)) || Number(b.step.kind!=='screening')-Number(a.step.kind!=='screening') || b.step.called-a.step.called)
  .slice(0,3).map(st=>({label:stationShort(stationOf(st)),queue:st.p.queue,calling:callOf(st,m),station:stationOf(st)}));
 const waiting = mine.filter(st=>(st.step.kind==='exam'||st.step.kind==='followup') && stillWaiting(st,m)).sort((a,b)=>a.step.start-b.step.start);
 return {title:c.dept,letter:c.letter,rows,next:waiting.slice(0,10).map(st=>st.p.queue),waiting:waiting.length,link,place};
}
// A shared counter group (registration, pharmacy, cashier, lab, x-ray, ER triage).
function counterScreen(kind:StepKind, title:string, now:PatientState[], m:number):ScreenData {
 const mine = now.filter(st=>st.step.kind===kind);
 const rows = mine.filter(st=>m>=st.step.called || st.status==='calling').sort((a,b)=>Number(callOf(b,m))-Number(callOf(a,m)) || b.step.called-a.step.called)
  .slice(0,3).map(st=>({label:stationShort(stationOf(st)) || 'ช่องบริการ',queue:st.p.queue,calling:callOf(st,m),station:stationOf(st)}));
 const waiting = mine.filter(st=>stillWaiting(st,m)).sort((a,b)=>a.step.start-b.step.start);
 const first = stationById(`counter:${kind}:1`);
 return {title,rows,next:waiting.slice(0,10).map(st=>st.p.queue),waiting:waiting.length,link:`/tv?dept=${encodeURIComponent(title.split(' · ')[0])}`,
  place:first ? {buildingId:first.buildingId,level:first.level} : undefined};
}
// The same screen looked up by department name (a clinic, or ลงทะเบียน / ห้องยา / การเงิน).
export function deptScreen(name:string, now:PatientState[], m:number):ScreenData|null {
 const zone = counterZones.findIndex(z=>z[1].split(' · ')[0]===name);
 if (zone>=0) return screenData(1,zone,now,m);
 const c = opdClinics().find(x=>x.dept===name);
 if (c) return screenData(c.level,c.deptIndex,now,m);
 const svc = counterServices.find(x=>x.section===name);
 return svc ? counterScreen(svc.kind,svc.section,now,m) : null;
}
// Departments that have a screen, for the /tv index.
export const screenDepts = () => [...opdClinics().map(c=>({name:c.dept,where:`OPD ชั้น ${c.level}`,letter:c.letter as string|undefined})),
 ...counterServices.map(c=>({name:c.section,where:'จุดบริการร่วม',letter:undefined as string|undefined}))];

// Door screen for one exam room or counter: who is called / inside now and the next few for this station.
export type StationScreen = {title:string; sub:string; letter?:string; calling?:string; serving?:string; next:string[]; waiting:number; note?:string};
export function stationScreen(id:string, patients:Patient[], now:PatientState[], m:number, events:QueueEvent[]):StationScreen|null {
 const st = stationById(id); if (!st) return null;
 const letter = st.clinicKey ? opdClinics().find(c=>c.key===st.clinicKey)?.letter : undefined;
 const sub = st.section.split(' · ').slice(-1)[0];
 const q = stationQueue(patients,st,m,DEFAULT_POLICY,events);
 // Staff-run first; otherwise the simulator's patient at this station.
 const here = q.current ?? now.find(x=>x.step.stationId===id && !x.step.manual && m>=x.step.called && st.kinds.includes(x.step.kind));
 const calling = here && callOf(here,m) ? here.p.queue : undefined, serving = here && !calling ? here.p.queue : undefined;
 const doc = stationDoctor(st,m);
 const note = pausedUntil(st,events,m)!==undefined ? 'พักชั่วคราว' : st.roomId && (!doc?.name || doc.status==='vacant') ? 'ไม่มีแพทย์ออกตรวจ' : st.roomId && doc?.status==='break' ? 'แพทย์พัก' : undefined;
 return {title:st.label,sub:st.roomId && doc?.name ? `${sub} · ${doc.name}` : sub,letter,calling,serving,next:q.waiting.slice(0,8).map(w=>w.s.p.queue),waiting:q.waiting.length,note};
}
