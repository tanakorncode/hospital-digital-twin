'use client';
import { buildings, buildingStats, floorRooms, isOff } from '../lib/scene-data';

// Light 2D plan of one floor, drawn from the same geometry as the 3D scene (rooms along the back wall, a corridor,
// one waiting band per department at the front). Small enough for a phone: used for wayfinding on the patient's
// QR page and as the station's own mini map in the staff console.
export type PlanPoint = {x:number; z:number};
export type PlanDot = PlanPoint & {tone:'me'|'called'|'next'|'target'; label?:string; num?:string}; // num: drawn inside the dot (queue order)
const LIFT_LABEL = 'ลิฟต์ / บันได';
export const liftSpot = (buildingId:string):PlanPoint => { const b = buildings.find(x=>x.id===buildingId)!; return {x:b.x-b.width/2+0.6,z:b.z-b.depth/2+b.depth*0.42+0.6}; };

export default function FloorPlanSvg({buildingId,level,highlightRoom,highlightZone,zoneAt,dots=[],route,showLift,height=220}:{buildingId:string;level:number;highlightRoom?:string;highlightZone?:number;zoneAt?:PlanPoint;
  dots?:PlanDot[];route?:{from:PlanPoint;to:PlanPoint};showLift?:boolean;height?:number}) {
 const b = buildings.find(x=>x.id===buildingId);
 if (!b) return null;
 const x0 = b.x-b.width/2, z0 = b.z-b.depth/2, pad = 0.5;
 const rooms = floorRooms(buildingId,level), rw = b.width/Math.max(1,rooms.length), roomD = b.depth*0.42, corr0 = z0+roomD, corr1 = corr0+1.2;
 const depts = buildingStats[buildingId]?.floors.find(f=>f.level===level)?.depts ?? [], bandW = b.width/Math.max(1,depts.length);
 // zoneAt: highlight the waiting band that contains this point (when it is in front of the corridor).
 const zone = highlightZone ?? (zoneAt && zoneAt.z>corr1-0.2 ? Math.floor((zoneAt.x-x0)/bandW) : undefined);
 // Route: out to the corridor, along it, then into the room / to the counter.
 const path = route ? (()=>{ const cz = (corr0+corr1)/2; return [route.from,{x:route.from.x,z:cz},{x:route.to.x,z:cz},route.to]; })() : [];
 const lift = liftSpot(buildingId);
 return <svg className="planSvg" viewBox={`${x0-pad} ${z0-pad} ${b.width+pad*2} ${b.depth+pad*2}`} style={{height}} role="img" aria-label="ผังชั้น">
  <defs><marker id="planArrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#1677ff"/></marker></defs>
  <rect x={x0} y={z0} width={b.width} height={b.depth} rx={0.3} className="pBld"/>
  {depts.map((d,i)=><g key={d+i}>
   <rect x={x0+i*bandW+0.05} y={corr1} width={bandW-0.1} height={z0+b.depth-corr1-0.05} rx={0.15} className={'pZone'+(zone===i?' on':'')+(isOff(`dept:${d}`)?' off':'')}/>
   <text x={x0+(i+0.5)*bandW} y={z0+b.depth-0.35} className="pZoneText">{d}</text></g>)}
  <rect x={x0} y={corr0} width={b.width} height={corr1-corr0} className="pCorr"/>
  {rooms.map(r=>{ const rx = x0+r.index*rw, on = r.id===highlightRoom, off = isOff(`room:${r.id}`) || isOff(`dept:${r.dept}`);
   return <g key={r.id}><rect x={rx+0.06} y={z0+0.06} width={rw-0.12} height={roomD-0.12} rx={0.12} className={'pRoom'+(on?' on':'')+(off?' off':'')}/>
    <text x={rx+rw/2} y={z0+roomD/2+0.18} className={'pRoomText'+(on?' on':'')}>{r.number}</text></g>; })}
  {showLift && <g><rect x={lift.x-0.35} y={lift.z-0.35} width={0.7} height={0.7} rx={0.12} className="pLift"/><text x={lift.x} y={lift.z+0.15} className="pLiftText">⇅</text>
   <text x={lift.x+0.5} y={lift.z-0.45} className="pLabel">{LIFT_LABEL}</text></g>}
  {path.length>0 && <polyline points={path.map(p=>`${p.x},${p.z}`).join(' ')} className="pRoute" markerEnd="url(#planArrow)"/>}
  {dots.map((d,i)=><g key={i} className={'pDot '+d.tone}>
   {d.tone==='me' && <circle cx={d.x} cy={d.z} r={0.55} className="pPulse"/>}
   <circle cx={d.x} cy={d.z} r={d.num?0.34:d.tone==='target'?0.32:0.26}/>
   {d.num && <text x={d.x} y={d.z+0.15} className="pNum">{d.num}</text>}
   {d.label && <text x={d.x} y={d.z-0.45} className="pLabel">{d.label}</text>}</g>)}
 </svg>;
}
