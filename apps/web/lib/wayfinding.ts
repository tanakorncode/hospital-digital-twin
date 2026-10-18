'use client';
import { apiBase } from './api-url';
import { servicePlace } from './patients';
import { buildingStats, buildings, deptDirectory } from './scene-data';

// Wayfinding (stage 2.8): public places with stable codes that QR signs carry, and plain-Thai directions between them.
// Places only — a sign or this page never holds anything about a patient.
export type Destination = {code:string; nameTh:string; buildingId:string; level:number; zoneIndex?:number; roomId?:string; landmarkTh?:string;
 descriptionTh?:string; isPublic:boolean; status:'ACTIVE'|'RETIRED'; replacedBy?:string};
type Res<T> = ({ok:true} & T) | {ok:false; code?:string; reason:string};
async function get<T>(path:string):Promise<Res<T>> {
 try {
  const r = await fetch(`${apiBase()}/api/v1/wayfinding${path}`), j = await r.json().catch(()=>({})) as Record<string,unknown>;
  return r.ok ? {ok:true,...j} as Res<T> : {ok:false,code:j.code as string|undefined,reason:(j.reason as string) ?? 'โหลดข้อมูลไม่สำเร็จ'};
 } catch { return {ok:false,code:'NETWORK',reason:'เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'}; }
}
export const fetchDestinations = () => get<{destinations:Destination[]}>('/destinations');
export const fetchDestination = (code:string) => get<{destination?:Destination; retired?:boolean; replacedBy?:Destination}>(`/destinations/${encodeURIComponent(code)}`);

export const buildingName = (id:string) => buildings.find(b=>b.id===id)?.name ?? id;
export const whereText = (d:{buildingId:string; level:number}) => `${buildingName(d.buildingId)} ชั้น ${d.level}`;
// The address a sign / QR leads to.
export const signUrl = (code:string, kind:'at'|'to'='at') => `${typeof window==='undefined' ? '' : window.location.origin}/wayfinding?${kind}=${encodeURIComponent(code)}`;

// Steps from where the patient stands (or the main entrance) to a place. Lifts are named first, for wheelchairs and
// the elderly; the place's own landmark (set by the hospital) finishes the route.
export function directions(from:Destination|undefined, to:Destination):string[] {
 const steps:string[] = [];
 // Without a starting point: the main entrance — the ground floor of the building with registration.
 const reg = servicePlace('registration'), entryB = reg?.buildingId ?? to.buildingId, entryL = Math.min(...(buildingStats[entryB]?.floors ?? [{level:1}]).map(f=>f.level));
 const start = from ?? {buildingId:entryB,level:entryL,nameTh:`ทางเข้าหลัก ${buildingName(entryB)}`} as Destination;
 if (!from) steps.push(`เริ่มจากทางเข้าหลัก ${buildingName(entryB)} ชั้น ${entryL}`);
 if (from && from.code===to.code) return ['คุณอยู่ที่นี่แล้ว'];
 if (start.buildingId!==to.buildingId) {
  if (start.level!==1) steps.push(`ใช้ลิฟต์หรือบันไดลงไปชั้น 1 ของ${buildingName(start.buildingId)}`);
  steps.push(`ออกไปทาง${buildingName(to.buildingId)} ตามป้ายบอกทาง`);
  if (to.level!==1) steps.push(`ขึ้นลิฟต์หรือบันไดไปชั้น ${to.level}`);
 } else if (start.level!==to.level) steps.push(`${to.level>start.level?'ขึ้น':'ลง'}ลิฟต์หรือบันไดไปชั้น ${to.level}`);
 else steps.push('อยู่ชั้นเดียวกัน เดินตามทางเดินกลาง');
 steps.push(`${to.nameTh}${to.landmarkTh ? ` · ${to.landmarkTh}` : ''}`);
 return steps;
}

// The department directory as places (for "import" in Settings): one per department per floor, code like OPD-2A.
export function directoryPlaces():Omit<Destination,'status'|'isPublic'>[] {
 return deptDirectory().map(d=>({code:`${d.buildingId.toUpperCase()}-${d.level}${String.fromCharCode(65+d.deptIndex)}`,nameTh:d.name,buildingId:d.buildingId,level:d.level,zoneIndex:d.deptIndex,
  descriptionTh:d.rooms ? `${d.rooms}` : undefined}));
}
