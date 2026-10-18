// How one floor of the facility is laid out — the single set of rules behind the 3D map, the patients' positions and
// the settings page's floor preview (which feeds it the draft). Pure: give it facility data (published or draft) and
// a floor, get positions back. Coordinates are local to the building's centre: x across the width (−W/2 … W/2), z from
// the back wall (−D/2) to the front (D/2).
//   back wall ─┬ rooms along the wall (their share of the width each), in department order, then group order
//              ├ corridor (1.2)
//   front     ─┴ one waiting band per department on the floor: its counters at the front of the band (one long
//                counter, or booths across it), chairs facing them, beds out in the band (resuscitation bays)
// Open-ward beds stand in one row along the front wall; beds in a room sit side by side by its back wall.
import type { Facility, FGroup, FPoint, FRoomKind } from './facility';

type Data = Pick<Facility,'buildings'|'floors'|'departments'|'groups'|'points'>;
export type PlanRoomKind = 'exam'|'scan'|'treatment'|'ward'|'office';
export type Spot2 = {x:number; z:number};
// A department's waiting band: its area (x0…x1 × z0…z1), counters along its top edge (z0), chairs facing them.
export type PlanBand = {deptId:string; name:string; index:number; x0:number; x1:number; z0:number; z1:number; seats:Spot2[]};
// door: the wall the door is in — 's' towards the front (+z, rooms along the back wall), 'n' towards the back, 'e' / 'w'.
export type Door = 'n'|'s'|'e'|'w';
export type PlanRoom = {point:FPoint; group:FGroup; deptId:string; index:number; count:number; x0:number; x1:number; z0:number; z1:number; w:number; door:Door; kind:PlanRoomKind};
export type PlanCounter = {point:FPoint; group:FGroup; index:number; count:number; booth:boolean; at:Spot2};
export type PlanBed = {point:FPoint; group:FGroup; room?:PlanRoom; ward:boolean; at:Spot2};
// corridor: the band between the rooms and the waiting areas (z from … to), when the floor is laid out automatically.
export type FloorPlan = {floorId:string; buildingId:string; level:number; buildingKind:string; cx:number; cz:number; W:number; D:number; roomFront:number; front0:number;
  corridor:[number,number]|null; bands:PlanBand[]; rooms:PlanRoom[]; counters:PlanCounter[]; beds:PlanBed[]};

// Inside a room, from where its door is: `across` along the door wall (from the left, looking out of the door), `deep`
// from the back wall towards the door. yaw turns things drawn for a front-door room (door 's') to face this room's door.
export function roomFrame(r:{x0:number; x1:number; z0:number; z1:number; door:Door}) {
  const side = r.door==='s' || r.door==='n', across = side ? r.x1-r.x0 : r.z1-r.z0, deep = side ? r.z1-r.z0 : r.x1-r.x0;
  const yaw = r.door==='s' ? 0 : r.door==='n' ? Math.PI : r.door==='e' ? Math.PI/2 : -Math.PI/2;
  return {cx:(r.x0+r.x1)/2,cz:(r.z0+r.z1)/2,across,deep,yaw};
}
export function roomPoint(r:{x0:number; x1:number; z0:number; z1:number; door:Door}, a:number, d:number):Spot2 {
  const f = roomFrame(r), lx = a-f.across/2, lz = d-f.deep/2, c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  return {x:f.cx+lx*c+lz*s,z:f.cz-lx*s+lz*c};
}

// A room's walls as segments (building-local): the back wall, both sides, and the door wall with its doorway (`gap` wide,
// at its left looking out). The doorway itself is returned as `door`.
export const DOORWAY = 0.8;
export function roomWalls(r:{x0:number; x1:number; z0:number; z1:number; door:Door}, gap = DOORWAY) {
  const f = roomFrame(r), W = f.across, D = f.deep, seg = (a0:number, d0:number, a1:number, d1:number) => { const p = roomPoint(r,a0,d0), q = roomPoint(r,a1,d1); return {x0:p.x,z0:p.z,x1:q.x,z1:q.z}; };
  return {walls:[seg(0,0,W,0),seg(0,0,0,D),seg(W,0,W,D),seg(Math.min(gap,W),D,W,D)],door:seg(0,D,Math.min(gap,W),D)};
}
// Fixed proportions of a floor (the same in every building).
export const ROOM_DEPTH = 0.42, CORRIDOR = 1.2, SEAT_DX = 0.46, SEAT_DZ = 0.68;
export const floorFrame = (W:number, D:number) => { const roomFront = -D/2+D*ROOM_DEPTH; return {roomFront,front0:roomFront+CORRIDOR}; };
// Where a patient stands at the u-th place (0…1) of a band's long counter, and at booth i of n across a band.
export const counterAt = (bandX0:number, front0:number, u:number):Spot2 => ({x:bandX0+0.5+u*0.9,z:front0+0.85});
export const boothAt = (bandX0:number, bandW:number, front0:number, i:number, n:number):Spot2 => ({x:bandX0+(i+0.5)*bandW/n,z:front0+0.95});
// Spread k of m beds across a width (two beds: at 30% and 72%).
export const bedRow = (k:number, m:number) => m<=1 ? 0.5 : 0.3+0.42*k/(m-1);
const live = (x?:{retiredAt?:string}) => !!x && !x.retiredAt;

export function planFloor(data:Data, floorId:string):FloorPlan|null {
  const floor = data.floors.find(f=>f.id===floorId && live(f)), b = floor && data.buildings.find(x=>x.id===floor.buildingId && live(x));
  if (!floor || !b) return null;
  const kind = b.kind==='other' ? 'support' : b.kind;
  const dept = new Map(data.departments.filter(live).map(d=>[d.id,d])), group = new Map(data.groups.filter(g=>live(g) && dept.has(g.departmentId)).map(g=>[g.id,g]));
  const order = new Map(data.departments.map((d,i)=>[d.id,i])), gOrder = new Map(data.groups.map((g,i)=>[g.id,i]));
  const pts = data.points.filter(p=>live(p) && group.has(p.groupId));
  const pointFloor = (p:FPoint) => p.floorId ?? group.get(p.groupId)!.floorId;
  const here = pts.filter(p=>pointFloor(p)===floorId);
  // Bands: departments with a group on this floor, or a room / counter / bed of theirs placed here (kiosks aside).
  const ids = new Set<string>();
  for (const g of group.values()) if (g.pointKind!=='kiosk' && g.floorId===floorId) ids.add(g.departmentId);
  for (const p of here) { const g = group.get(p.groupId)!; if (g.pointKind!=='kiosk' && p.floorId) ids.add(g.departmentId); }
  const bandIds = [...ids].sort((x,y)=>order.get(x)!-order.get(y)!);
  const W = b.map.width, D = b.map.depth, hw = W/2, hd = D/2, {roomFront,front0} = floorFrame(W,D), bandW = W/Math.max(1,bandIds.length);
  const bandIndex = (deptId:string) => Math.max(0,bandIds.indexOf(deptId)), bandX0 = (deptId:string) => -hw+bandIndex(deptId)*bandW;
  // Rooms
  const roomPts = here.filter(p=>group.get(p.groupId)!.pointKind==='room')
    .sort((a,c)=>bandIndex(group.get(a.groupId)!.departmentId)-bandIndex(group.get(c.groupId)!.departmentId) || gOrder.get(a.groupId)!-gOrder.get(c.groupId)! || a.number-c.number);
  const rw = W/Math.max(1,roomPts.length);
  const roomKind = (p:FPoint, g:FGroup):PlanRoomKind => { const k:FRoomKind|undefined = p.roomKind;
    return k==='lab' ? 'office' : k ?? (g.steps.includes('exam') ? 'exam' : kind==='er' ? 'treatment' : kind==='inpatient' ? 'ward' : 'office'); };
  const rooms:PlanRoom[] = roomPts.map((p,k)=>{ const g = group.get(p.groupId)!, x0 = -hw+k*rw;
    return {point:p,group:g,deptId:g.departmentId,index:k,count:roomPts.length,x0,x1:x0+rw,z0:-hd,z1:roomFront,w:rw,door:'s',kind:roomKind(p,g)}; });
  const roomOf = new Map(rooms.map(r=>[r.point.id,r]));
  // Counters / booths, in each group's own order
  const counters:PlanCounter[] = [];
  for (const g of [...group.values()].filter(x=>x.pointKind==='counter' && x.floorId===floorId)) {
    const mine = here.filter(p=>p.groupId===g.id).sort((a,c)=>a.number-c.number), booth = g.options?.arrange==='booths', x0 = bandX0(g.departmentId);
    mine.forEach((p,i)=>counters.push({point:p,group:g,index:i,count:mine.length,booth,at:booth ? boothAt(x0,bandW,front0,i,mine.length) : counterAt(x0,front0,(i+0.5)/mine.length)}));
  }
  // Beds: in their room; the open ward in one row along the front; other open beds across their band
  const bedPts = here.filter(p=>group.get(p.groupId)!.pointKind==='bed');
  const inRoom = bedPts.filter(p=>p.inRoomId && roomOf.has(p.inRoomId)).sort((a,c)=>roomOf.get(a.inRoomId!)!.index-roomOf.get(c.inRoomId!)!.index || a.number-c.number);
  const open = bedPts.filter(p=>!p.inRoomId || !roomOf.has(p.inRoomId)).sort((a,c)=>bandIndex(group.get(a.groupId)!.departmentId)-bandIndex(group.get(c.groupId)!.departmentId) || a.number-c.number);
  const beds:PlanBed[] = [];
  inRoom.forEach(p=>{ const room = roomOf.get(p.inRoomId!)!, mates = inRoom.filter(o=>o.inRoomId===p.inRoomId), k = mates.indexOf(p);
    beds.push({point:p,group:group.get(p.groupId)!,room,ward:group.get(p.groupId)!.steps.includes('ward'),at:roomPoint(room,(room.door==='s'||room.door==='n' ? room.x1-room.x0 : room.z1-room.z0)*bedRow(k,mates.length),0.9)}); });
  const wardRow = open.filter(p=>group.get(p.groupId)!.steps.includes('ward'));
  wardRow.forEach((p,j)=>beds.push({point:p,group:group.get(p.groupId)!,ward:true,at:{x:-hw+0.55+j*((W-1.1)/Math.max(1,wardRow.length-1)),z:hd-0.8}}));
  open.filter(p=>!wardRow.includes(p)).forEach(p=>{ const g = group.get(p.groupId)!, mates = open.filter(o=>o.groupId===p.groupId), k = mates.indexOf(p);
    beds.push({point:p,group:g,ward:false,at:{x:bandX0(g.departmentId)+bandW*bedRow(k,mates.length),z:hd-0.8}}); });
  // Waiting chairs per band: a number set on the band's groups wins (0 = none); otherwise rows facing the counters,
  // except in wards (nurse station and open beds), support buildings (desks) and bands with beds out in them.
  const bands:PlanBand[] = bandIds.map((id,i)=>{
    const x0 = -hw+i*bandW, x1 = x0+bandW, mine = [...group.values()].filter(g=>g.departmentId===id && g.floorId===floorId);
    const booths = mine.some(g=>g.pointKind==='counter' && g.options?.arrange==='booths');
    const z0 = front0+(booths ? 2 : CORRIDOR), grid:Spot2[] = [];
    for (let z=z0; z<hd-0.3; z+=SEAT_DZ) for (let x=x0+0.45; x<x1-0.3; x+=SEAT_DX) grid.push({x,z});
    const set = mine.filter(g=>g.options?.seats!==undefined);
    const auto = kind!=='inpatient' && kind!=='support' && !beds.some(bd=>!bd.room && !bd.ward && bd.group.departmentId===id);
    const seats = set.length ? grid.slice(0,set.reduce((n,g)=>n+(g.options!.seats ?? 0),0)) : auto ? grid : [];
    return {deptId:id,name:dept.get(id)!.name,index:i,x0,x1,z0:front0,z1:hd,seats};
  });
  return {floorId,buildingId:b.id,level:floor.level,buildingKind:kind,cx:b.map.x,cz:b.map.z,W,D,roomFront,front0,corridor:[roomFront,front0],bands,rooms,counters,beds};
}
// The most chairs a band of this floor can hold (the number the settings page caps a group's seats at).
export function seatCapacity(plan:FloorPlan, deptId:string) {
  const band = plan.bands.find(x=>x.deptId===deptId); if (!band) return 0;
  const booths = plan.counters.some(c=>c.booth && c.group.departmentId===deptId), z0 = plan.front0+(booths ? 2 : CORRIDOR);
  let n = 0; for (let z=z0; z<plan.D/2-0.3; z+=SEAT_DZ) for (let x=band.x0+0.45; x<band.x1-0.3; x+=SEAT_DX) n++;
  return n;
}
