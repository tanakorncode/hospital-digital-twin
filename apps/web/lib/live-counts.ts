'use client';
import { patientAt, type Patient } from './patients';
import { allStations, openStations, type QueueEvent } from './queue';
import type { RealCounts } from './scene-data';

// Live data mode: how many real patients are on each floor at an hour, how many wait and for how long, and how many
// exam rooms are open — all from today's visits and queue log. Past hours use the middle of the hour, the current hour
// uses now; hours still to come are unknown (0) rather than guessed.
export function realCounts(patients:Patient[], now:number, events:QueueEvent[]):RealCounts {
 const cache = new Map<number,{floors:Map<string,number>; wait:Map<string,{n:number; sum:number}>}|null>();
 const at = (hour:number) => {
  const h = Math.floor(hour);
  if (cache.has(h)) return cache.get(h)!;
  const nowHour = Math.floor(now/60), minute = h===nowHour ? now : h*60+30;
  if (h>nowHour) { cache.set(h,null); return null; }
  const floors = new Map<string,number>(), wait = new Map<string,{n:number; sum:number}>();
  patients.forEach(p=>{
   const s = patientAt(p,minute);
   if (!s || s.step.kind==='leave' || !s.area.buildingId || !s.area.level) return;
   const k = `${s.area.buildingId}:${s.area.level}`; floors.set(k,(floors.get(k) ?? 0)+1);
   if (s.status==='waiting' || s.status==='long') { const w = wait.get(s.area.buildingId) ?? {n:0,sum:0}; w.n++; w.sum += s.stepWait; wait.set(s.area.buildingId,w); }
  });
  const v = {floors,wait}; cache.set(h,v); return v;
 };
 const open = new Set(openStations(events).map(st=>st.id));
 return {
  floor:(id,level,hour)=>at(hour)?.floors.get(`${id}:${level}`) ?? 0,
  waiting:(id,hour)=>{ const w = at(hour)?.wait.get(id); return {n:w?.n ?? 0,avgWait:w?.n ? Math.round(w.sum/w.n) : 0}; },
  rooms:(id)=>{ const rooms = allStations().filter(st=>st.roomId && st.buildingId===id); return [rooms.filter(st=>open.has(st.id)).length,rooms.length]; },
 };
}
