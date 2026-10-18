// Today's doctors, room by room, from the appointment schedules (Settings → รายชื่อแพทย์), as the API sends them
// (appt:duty — doctor names and rooms only). When doctors are on file (`known`), the map, the duty panel, the queue
// screens' doctor names and the patient simulator follow these sessions (lib/scene-data.ts roomShifts) instead of the
// demo roster; until then, the demo roster.
export type DutySession = {providerCode:string; providerName:string; clinicCode:string; roomId?:string; startsAt:string; endsAt:string; status:'OPEN'|'CLOSED'};
// today: the sessions are today's (false: the next day with sessions, for the simulated day — live data shows none).
export type Duty = {known:boolean; day:string; today:boolean; sessions:DutySession[]};
let current:Duty = {known:false,day:'',today:true,sessions:[]}, revision = 0;
const listeners = new Set<()=>void>();
const same = (a:Duty, b:Duty) => a.known===b.known && a.day===b.day && a.today===b.today && JSON.stringify(a.sessions)===JSON.stringify(b.sessions);
export function setDuty(d:unknown):boolean {
  const x = d as Partial<Duty>|null;
  if (!x || typeof x!=='object' || typeof x.known!=='boolean' || !Array.isArray(x.sessions)) return false;
  const next:Duty = {known:x.known,day:typeof x.day==='string' ? x.day : '',today:x.today!==false,sessions:x.sessions.filter(s=>s && typeof s.startsAt==='string' && typeof s.endsAt==='string' && typeof s.providerName==='string')};
  if (same(current,next)) return false;
  current = next; revision++; listeners.forEach(fn=>fn());
  return true;
}
export const duty = () => current;
// Bumps on every change of today's doctors: memoised duty (and what the simulator plans from it) keys on it.
export const dutyRevision = () => revision;
export const onDuty = (fn:()=>void) => { listeners.add(fn); return ()=>{ listeners.delete(fn); }; };
