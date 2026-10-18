'use client';
import { buildings, floorPlan, floorRooms, isOff } from '../lib/scene-data';

// Light 2D plan of one floor, drawn from the floor's layout as the 3D scene is (lib/floor-layout.ts: rooms, the corridor
// when laid out automatically, one waiting area per department). Small enough for a phone: used for wayfinding on the patient's
// QR page and as the station's own mini map in the staff console.
export type PlanPoint = {x:number; z:number};
export type PlanDot = PlanPoint & {tone:'me'|'called'|'next'|'target'; label?:string; num?:string}; // num: drawn inside the dot (queue order)
const LIFT_LABEL = 'ลิฟต์ / บันได';
export const liftSpot = (buildingId:string):PlanPoint => { const b = buildings.find(x=>x.id===buildingId)!; return {x:b.x-b.width/2+0.6,z:b.z-b.depth/2+b.depth*0.42+0.6}; };
const inside = (p:PlanPoint, r:{x0:number; x1:number; z0:number; z1:number}) => p.x>=r.x0 && p.x<=r.x1 && p.z>=r.z0 && p.z<=r.z1;

export default function FloorPlanSvg({buildingId,level,highlightRoom,highlightZone,zoneAt,dots=[],route,showLift,height=220}:{buildingId:string;level:number;highlightRoom?:string;highlightZone?:number;zoneAt?:PlanPoint;
  dots?:PlanDot[];route?:{from:PlanPoint;to:PlanPoint};showLift?:boolean;height?:number}) {
 const b = buildings.find(x=>x.id===buildingId);
 if (!b) return null;
 const x0 = b.x-b.width/2, z0 = b.z-b.depth/2, pad = 0.5;
 const plan = floorPlan(buildingId,level), rooms = floorRooms(buildingId,level), corr = plan?.corridor;
 const w = (r:{x0:number; x1:number; z0:number; z1:number}) => ({x0:b.x+r.x0,x1:b.x+r.x1,z0:b.z+r.z0,z1:b.z+r.z1}); // building-local → world
 const bands = (plan?.bands ?? []).map(bd=>({...w(bd),name:bd.name}));
 // zoneAt: highlight the waiting area that contains this point (a little slack towards the counters).
 const zone = highlightZone ?? (zoneAt ? (i=>i<0 ? undefined : i)(bands.findIndex(bd=>inside(zoneAt,{...bd,z0:bd.z0-0.2}))) : undefined);
 // Route: out to the corridor, along it, then into the room / to the counter; without a corridor, across then along.
 const path = route ? (()=>{ if (!corr) return [route.from,{x:route.to.x,z:route.from.z},route.to]; const cz = b.z+(corr[0]+corr[1])/2; return [route.from,{x:route.from.x,z:cz},{x:route.to.x,z:cz},route.to]; })() : [];
 const lift = liftSpot(buildingId);
 return <svg className="planSvg" viewBox={`${x0-pad} ${z0-pad} ${b.width+pad*2} ${b.depth+pad*2}`} style={{height}} role="img" aria-label="ผังชั้น">
  <defs><marker id="planArrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#1677ff"/></marker></defs>
  <rect x={x0} y={z0} width={b.width} height={b.depth} rx={0.3} className="pBld"/>
  {bands.map((d,i)=><g key={d.name+i}>
   <rect x={d.x0+0.05} y={d.z0} width={d.x1-d.x0-0.1} height={d.z1-d.z0-0.05} rx={0.15} className={'pZone'+(zone===i?' on':'')+(isOff(`dept:${d.name}`)?' off':'')}/>
   <text x={(d.x0+d.x1)/2} y={d.z1-0.35} className="pZoneText">{d.name}</text></g>)}
  {corr && <rect x={x0} y={b.z+corr[0]} width={b.width} height={corr[1]-corr[0]} className="pCorr"/>}
  {rooms.map(room=>{ const r = w(room), on = room.id===highlightRoom, off = isOff(`room:${room.id}`) || isOff(`dept:${room.dept}`);
   return <g key={room.id}><rect x={r.x0+0.06} y={r.z0+0.06} width={r.x1-r.x0-0.12} height={r.z1-r.z0-0.12} rx={0.12} className={'pRoom'+(on?' on':'')+(off?' off':'')}/>
    <text x={(r.x0+r.x1)/2} y={(r.z0+r.z1)/2+0.18} className={'pRoomText'+(on?' on':'')}>{room.number}</text></g>; })}
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
