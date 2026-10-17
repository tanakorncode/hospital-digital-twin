import { etaOf, type Patient, type PatientState } from './patients';
import { allStations, serviceMinutes, stationById, stationDoctor, stationQueue, stepGroup, type QueueEvent } from './queue';

// "Where am I in the queue": people ahead and the waiting time as a range — the same numbers on the patient's own QR page
// (/q/<token>) and on the Digital Reception kiosk ("คิวของฉัน"), so the two never disagree.

// People ahead in the same queue (what the station console would call next); undefined when not waiting.
export function peopleAhead(st:PatientState|null|undefined, patients:Patient[], m:number, events:QueueEvent[]):number|undefined {
 if (!st || m>=st.step.called || st.status==='calling' || st.status==='held' || st.status==='missed') return undefined;
 const g = stepGroup(st); if (!g) return undefined;
 const station = stationById(st.step.assigned ?? st.step.stationId) ?? allStations().find(x=>x.group===g); if (!station) return undefined;
 const i = stationQueue(patients,station,m,undefined,events).waiting.findIndex(x=>x.s.p.id===st.p.id);
 return i<0 ? undefined : i;
}
// Estimate from the queue itself when the position is known: people ahead × minutes each ÷ rooms/counters working,
// shown as a range. Otherwise the planned time (none for real patients — nothing is guessed).
export function waitRange(st:PatientState, ahead:number|undefined, m:number, events:QueueEvent[]) {
 const grp = stepGroup(st), serving = grp ? allStations().filter(x=>x.group===grp && (!x.roomId || stationDoctor(x,m)?.status==='active')) : [];
 const per = serving.length ? serviceMinutes(serving[0],events) : 0, eta = etaOf(st,m);
 const center = ahead!==undefined && serving.length ? (ahead+0.5)*per/serving.length : eta;
 const lo = Math.max(ahead===0?0:1,Math.floor(center*0.7)), hi = Math.max(lo+2,Math.ceil(center*1.4)+2);
 return {center,lo,hi,known:eta>0 || ahead!==undefined};
}
