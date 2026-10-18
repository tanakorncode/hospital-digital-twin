// How one floor of the facility is laid out — the single set of rules behind the 3D map, the patients' positions and
// the settings page's floor preview (which feeds it the draft). Pure: give it facility data (published or draft) and
// a floor, get positions back. Coordinates are local to the building's centre: x across the width (−W/2 … W/2), z from
// the back wall (−D/2) to the front (D/2).
//   back wall ─┬ rooms along the wall (their share of the width each), in department order, then group order
//              ├ corridor (1.2)
//   front     ─┴ one waiting band per department on the floor: its counters at the front of the band (one long
//                counter, or booths across it), chairs facing them, beds out in the band (resuscitation bays)
// Open-ward beds stand in one row along the front wall; beds in a room sit side by side by its back wall.
// A floor's own layout (floor.layout) changes this: other proportions (the rooms' depth, the order and widths of rooms and
// waiting bands), or — mode 'manual' — every room and waiting area where it was put, with no corridor; anything not
// placed yet stands where the automatic layout would put it. Counters, chairs and beds follow their waiting area.
import type { Facility, FDoor, FFloorLayout, FGroup, FPoint, FRect, FRoomKind } from './facility';

type Data = Pick<Facility,'buildings'|'floors'|'departments'|'groups'|'points'>;
export type PlanRoomKind = 'exam'|'scan'|'treatment'|'ward'|'office';
export type Spot2 = {x:number; z:number};
// A department's waiting band: its area (x0…x1 × z0…z1), counters along its top edge (z0), chairs facing them.
export type PlanBand = {deptId:string; name:string; index:number; x0:number; x1:number; z0:number; z1:number; seats:Spot2[]};
// door: the wall the door is in — 's' towards the front (+z, rooms along the back wall), 'n' towards the back, 'e' / 'w'.
export type Door = FDoor;
// doorAt: where along the door wall the doorway's middle is (0…1, from the left looking out); not set = at the left.
export type PlanRoom = {point:FPoint; group:FGroup; deptId:string; index:number; count:number; x0:number; x1:number; z0:number; z1:number; w:number; door:Door; doorAt?:number; kind:PlanRoomKind};
export type PlanCounter = {point:FPoint; group:FGroup; index:number; count:number; booth:boolean; at:Spot2};
export type PlanBed = {point:FPoint; group:FGroup; room?:PlanRoom; ward:boolean; at:Spot2};
// corridor: the band between the rooms and the waiting areas (z from … to), when the floor is laid out automatically.
// manual: rooms and areas placed by hand. background: the floor-plan picture under the plan, if any. lift: where the lift /
// stairs are (set on the floor, else the front-left corner by the corridor).
export type FloorPlan = {floorId:string; buildingId:string; level:number; buildingKind:string; cx:number; cz:number; W:number; D:number; roomFront:number; front0:number;
  corridor:[number,number]|null; manual:boolean; background?:FFloorLayout['background']; lift:Spot2; bands:PlanBand[]; rooms:PlanRoom[]; counters:PlanCounter[]; beds:PlanBed[]};

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
// The reverse: a point on the floor as (across, deep) in the room's own frame.
export function roomLocal(r:{x0:number; x1:number; z0:number; z1:number; door:Door}, p:Spot2) {
  const f = roomFrame(r), c = Math.cos(f.yaw), s = Math.sin(f.yaw), dx = p.x-f.cx, dz = p.z-f.cz;
  return {a:dx*c-dz*s+f.across/2,d:dx*s+dz*c+f.deep/2};
}
// The doorway along the door wall (from, to — across): DOORWAY wide, its middle at doorAt, kept inside the wall.
export function doorSpan(r:{x0:number; x1:number; z0:number; z1:number; door:Door; doorAt?:number}):[number,number] {
  const W = roomFrame(r).across, g = Math.min(DOORWAY,W);
  if (r.doorAt===undefined) return [0,g];
  const a0 = Math.min(W-g,Math.max(0,r.doorAt*W-g/2)); return [a0,a0+g];
}

// A room's walls as segments (building-local): the back wall, both sides, and the door wall either side of its doorway
// (doorSpan). The doorway itself is returned as `door`.
export const DOORWAY = 0.8;
export function roomWalls(r:{x0:number; x1:number; z0:number; z1:number; door:Door; doorAt?:number}) {
  const f = roomFrame(r), W = f.across, D = f.deep, [g0,g1] = doorSpan(r), seg = (a0:number, d0:number, a1:number, d1:number) => { const p = roomPoint(r,a0,d0), q = roomPoint(r,a1,d1); return {x0:p.x,z0:p.z,x1:q.x,z1:q.z}; };
  const walls = [seg(0,0,W,0),seg(0,0,0,D),seg(W,0,W,D)];
  if (g0>0.01) walls.push(seg(0,D,g0,D));
  if (g1<W-0.01) walls.push(seg(g1,D,W,D));
  return {walls,door:seg(g0,D,g1,D)};
}
// Fixed proportions of a floor (the same in every building).
export const ROOM_DEPTH = 0.42, CORRIDOR = 1.2, SEAT_DX = 0.46, SEAT_DZ = 0.68;
export const floorFrame = (W:number, D:number, depth = ROOM_DEPTH) => { const roomFront = -D/2+D*depth; return {roomFront,front0:roomFront+CORRIDOR}; };
// Ids in their usual order, with those named in `first` moved to the front in that order.
const ordered = (ids:string[], first?:string[]) => { const f = (first ?? []).filter(x=>ids.includes(x)); return [...new Set(f)].concat(ids.filter(x=>!f.includes(x))); };
// Spans side by side across [lo, hi], each as wide as its weight (1 = an equal share).
const spans = (ids:string[], lo:number, hi:number, weights?:Record<string,number>):[number,number][] => {
  const w = ids.map(id=>Math.min(10,Math.max(0.2,weights?.[id] ?? 1)));
  if (w.every(x=>x===1)) { const step = (hi-lo)/Math.max(1,ids.length); return ids.map((_,k)=>[lo+k*step,lo+k*step+step]); }
  const total = w.reduce((a,b)=>a+b,0); let at = lo;
  return w.map(x=>{ const a = at; at += (hi-lo)*x/total; return [a,at] as [number,number]; });
};
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
  const L:FFloorLayout = floor.layout ?? {}, manual = L.mode==='manual';
  const bandIds = ordered([...ids].sort((x,y)=>order.get(x)!-order.get(y)!),L.bandOrder);
  const W = b.map.width, D = b.map.depth, hw = W/2, hd = D/2, {roomFront,front0} = floorFrame(W,D,Math.min(0.7,Math.max(0.2,L.roomDepth ?? ROOM_DEPTH)));
  // Waiting areas: bands across the front (automatic), or where they were put.
  const bandSpan = spans(bandIds,-hw,hw,L.bandWeights);
  const area = new Map<string,FRect>(bandIds.map((id,i)=>[id,(manual && L.areas?.[id]) || {x0:bandSpan[i][0],x1:bandSpan[i][1],z0:front0,z1:hd}]));
  const bandIndex = (deptId:string) => Math.max(0,bandIds.indexOf(deptId)), areaOf = (deptId:string) => area.get(deptId) ?? {x0:-hw,x1:hw,z0:front0,z1:hd};
  // Rooms
  const roomPts = here.filter(p=>group.get(p.groupId)!.pointKind==='room')
    .sort((a,c)=>bandIndex(group.get(a.groupId)!.departmentId)-bandIndex(group.get(c.groupId)!.departmentId) || gOrder.get(a.groupId)!-gOrder.get(c.groupId)! || a.number-c.number);
  const roomIds = ordered(roomPts.map(p=>p.id),L.roomOrder), byId = new Map(roomPts.map(p=>[p.id,p]));
  const roomSpan = spans(roomIds,-hw,hw,L.roomWeights);
  const roomKind = (p:FPoint, g:FGroup):PlanRoomKind => { const k:FRoomKind|undefined = p.roomKind;
    return k==='lab' ? 'office' : k ?? (g.steps.includes('exam') ? 'exam' : kind==='er' ? 'treatment' : kind==='inpatient' ? 'ward' : 'office'); };
  const rooms:PlanRoom[] = roomIds.map((id,k)=>{ const p = byId.get(id)!, g = group.get(p.groupId)!, placed = manual ? L.rooms?.[id] : undefined;
    const r = placed ?? {x0:roomSpan[k][0],x1:roomSpan[k][1],z0:-hd,z1:roomFront,door:'s' as Door};
    return {point:p,group:g,deptId:g.departmentId,index:k,count:roomIds.length,x0:r.x0,x1:r.x1,z0:r.z0,z1:r.z1,w:r.x1-r.x0,door:r.door,...(placed?.doorAt!==undefined ? {doorAt:placed.doorAt} : {}),kind:roomKind(p,g)}; });
  const roomOf = new Map(rooms.map(r=>[r.point.id,r]));
  // Counters / booths along the top of their waiting area, in each group's own order
  const counters:PlanCounter[] = [];
  for (const g of [...group.values()].filter(x=>x.pointKind==='counter' && x.floorId===floorId)) {
    const mine = here.filter(p=>p.groupId===g.id).sort((a,c)=>a.number-c.number), booth = g.options?.arrange==='booths', a = areaOf(g.departmentId);
    mine.forEach((p,i)=>counters.push({point:p,group:g,index:i,count:mine.length,booth,at:booth ? boothAt(a.x0,a.x1-a.x0,a.z0,i,mine.length) : counterAt(a.x0,a.z0,(i+0.5)/mine.length)}));
  }
  // Beds: in their room; the open ward in one row along the front (along the back of its own area, by hand); other open
  // beds across their area
  const bedPts = here.filter(p=>group.get(p.groupId)!.pointKind==='bed');
  const inRoom = bedPts.filter(p=>p.inRoomId && roomOf.has(p.inRoomId)).sort((a,c)=>roomOf.get(a.inRoomId!)!.index-roomOf.get(c.inRoomId!)!.index || a.number-c.number);
  const open = bedPts.filter(p=>!p.inRoomId || !roomOf.has(p.inRoomId)).sort((a,c)=>bandIndex(group.get(a.groupId)!.departmentId)-bandIndex(group.get(c.groupId)!.departmentId) || a.number-c.number);
  const beds:PlanBed[] = [];
  inRoom.forEach(p=>{ const room = roomOf.get(p.inRoomId!)!, mates = inRoom.filter(o=>o.inRoomId===p.inRoomId), k = mates.indexOf(p);
    beds.push({point:p,group:group.get(p.groupId)!,room,ward:group.get(p.groupId)!.steps.includes('ward'),at:roomPoint(room,roomFrame(room).across*bedRow(k,mates.length),0.9)}); });
  const wardRow = open.filter(p=>group.get(p.groupId)!.steps.includes('ward'));
  if (!manual) wardRow.forEach((p,j)=>beds.push({point:p,group:group.get(p.groupId)!,ward:true,at:{x:-hw+0.55+j*((W-1.1)/Math.max(1,wardRow.length-1)),z:hd-0.8}}));
  else for (const id of bandIds) { const row = wardRow.filter(p=>group.get(p.groupId)!.departmentId===id), a = areaOf(id), w = a.x1-a.x0;
    row.forEach((p,j)=>beds.push({point:p,group:group.get(p.groupId)!,ward:true,at:{x:row.length>1 ? a.x0+0.55+j*((w-1.1)/(row.length-1)) : (a.x0+a.x1)/2,z:a.z1-0.8}})); }
  open.filter(p=>!wardRow.includes(p)).forEach(p=>{ const g = group.get(p.groupId)!, mates = open.filter(o=>o.groupId===p.groupId), k = mates.indexOf(p), a = areaOf(g.departmentId);
    beds.push({point:p,group:g,ward:false,at:{x:a.x0+(a.x1-a.x0)*bedRow(k,mates.length),z:a.z1-0.8}}); });
  // Waiting chairs per area: a number set on the area's groups wins (0 = none); otherwise rows facing the counters,
  // except in wards (nurse station and open beds), support buildings (desks) and areas with beds out in them.
  const bands:PlanBand[] = bandIds.map((id,i)=>{
    const a = areaOf(id), mine = [...group.values()].filter(g=>g.departmentId===id && g.floorId===floorId);
    const set = mine.filter(g=>g.options?.seats!==undefined), grid = seatGrid(a,mine.some(g=>g.pointKind==='counter' && g.options?.arrange==='booths'));
    const auto = kind!=='inpatient' && kind!=='support' && !beds.some(bd=>!bd.room && !bd.ward && bd.group.departmentId===id);
    const seats = set.length ? grid.slice(0,set.reduce((n,g)=>n+(g.options!.seats ?? 0),0)) : auto ? grid : [];
    return {deptId:id,name:dept.get(id)!.name,index:i,x0:a.x0,x1:a.x1,z0:a.z0,z1:a.z1,seats};
  });
  return {floorId,buildingId:b.id,level:floor.level,buildingKind:kind,cx:b.map.x,cz:b.map.z,W,D,roomFront,front0,corridor:manual ? null : [roomFront,front0],manual,
    background:L.background,lift:L.lift ? {x:L.lift.x,z:L.lift.z} : {x:-hw+0.6,z:roomFront+0.6},bands,rooms,counters,beds};
}
// The most chairs a band of this floor can hold (the number the settings page caps a group's seats at).
export function seatCapacity(plan:FloorPlan, deptId:string) {
  const band = plan.bands.find(x=>x.deptId===deptId); if (!band) return 0;
  return seatGrid(band,plan.counters.some(c=>c.booth && c.group.departmentId===deptId)).length;
}
// Chair spots in a waiting area: rows from in front of its counters (further back behind booths) to its far edge.
function seatGrid(a:FRect, booths:boolean):Spot2[] {
  const grid:Spot2[] = [];
  for (let z=a.z0+(booths ? 2 : CORRIDOR); z<a.z1-0.3; z+=SEAT_DZ) for (let x=a.x0+0.45; x<a.x1-0.3; x+=SEAT_DX) grid.push({x,z});
  return grid;
}

// A walking route on a floor (building-local): out of the room through its door, to the target, in through the target
// room's door. Laid out automatically: along the corridor. By hand: around the other rooms, on a grid (0.25), four
// directions, turns cost extra, so the line keeps to a few straight legs; without a way through, a plain line.
export function floorRoute(plan:FloorPlan, from:Spot2, to:Spot2):Spot2[] {
  const G = 0.25, hw = plan.W/2, hd = plan.D/2, nx = Math.max(1,Math.round(plan.W/G)), nz = Math.max(1,Math.round(plan.D/G));
  const inRoom = (p:Spot2) => plan.rooms.find(r=>p.x>r.x0 && p.x<r.x1 && p.z>r.z0 && p.z<r.z1);
  const door = (r:PlanRoom, d:number) => { const [g0,g1] = doorSpan(r); return roomPoint(r,(g0+g1)/2,roomFrame(r).deep+d); };
  const a = inRoom(from), b = inRoom(to);
  const head = a && a!==b ? [from,door(a,-0.3),door(a,0.4)] : [from], tail = b && a!==b ? [door(b,0.4),door(b,-0.3),to] : [to];
  if (a && a===b) return [from,to];
  if (plan.corridor) { // out to the corridor (through the door), along it, in (through the door)
    const cz = (plan.corridor[0]+plan.corridor[1])/2, s = head[head.length-1], t = tail[0];
    const out = [...head.slice(0,-1),{x:s.x,z:s.z},{x:s.x,z:cz},{x:t.x,z:cz},{x:t.x,z:t.z},...tail.slice(1)];
    return out.filter((p,k)=>k===0 || Math.hypot(p.x-out[k-1].x,p.z-out[k-1].z)>1e-9);
  }
  const s = head[head.length-1], t = tail[0];
  const cell = (p:Spot2) => [Math.min(nx-1,Math.max(0,Math.floor((p.x+hw)/G))),Math.min(nz-1,Math.max(0,Math.floor((p.z+hd)/G)))] as const;
  const centre = (i:number, j:number):Spot2 => ({x:-hw+(i+0.5)*G,z:-hd+(j+0.5)*G});
  const blocked = new Uint8Array(nx*nz);
  for (let j=0; j<nz; j++) for (let i=0; i<nx; i++) { const c = centre(i,j);
    if (plan.rooms.some(r=>c.x>r.x0-0.1 && c.x<r.x1+0.1 && c.z>r.z0-0.1 && c.z<r.z1+0.1)) blocked[j*nx+i] = 1; }
  const [si,sj] = cell(s), [ti,tj] = cell(t), start = sj*nx+si, goal = tj*nx+ti;
  blocked[start] = 0; blocked[goal] = 0;
  // A* over (cell, heading): cost 1 a step, +2 a turn.
  const cost = new Float64Array(nx*nz*4).fill(Infinity), prev = new Int32Array(nx*nz*4).fill(-1), open:number[] = [];
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]], h = (k:number) => Math.abs(k%nx-ti)+Math.abs(Math.floor(k/nx)-tj);
  for (let d=0; d<4; d++) { cost[start*4+d] = 0; open.push(start*4+d); }
  let found = -1;
  while (open.length) {
    let bi = 0; for (let k=1; k<open.length; k++) if (cost[open[k]]+h(open[k]>>2)<cost[open[bi]]+h(open[bi]>>2)) bi = k;
    const st = open[bi]; open[bi] = open[open.length-1]; open.pop();
    const c = st>>2, d0 = st&3; if (c===goal) { found = st; break; }
    const ci = c%nx, cj = Math.floor(c/nx);
    for (let d=0; d<4; d++) { const ni = ci+dirs[d][0], nj = cj+dirs[d][1]; if (ni<0 || nj<0 || ni>=nx || nj>=nz) continue;
      const n = nj*nx+ni; if (blocked[n]) continue;
      const k = n*4+d, v = cost[st]+1+(d===d0 ? 0 : 2); if (v<cost[k]) { cost[k] = v; prev[k] = st; open.push(k); } }
  }
  if (found<0) return [...head,...tail];
  const cells:Spot2[] = []; for (let st = found; st>=0; st = prev[st]) cells.push(centre((st>>2)%nx,Math.floor((st>>2)/nx)));
  cells.reverse();
  // Keep the corners only, and start / end exactly where asked.
  const pts = [s,...cells.slice(1,-1),t], out:Spot2[] = [pts[0]];
  for (let k=1; k<pts.length-1; k++) { const p = out[out.length-1], q = pts[k], r = pts[k+1];
    if (Math.abs((q.x-p.x)*(r.z-q.z)-(q.z-p.z)*(r.x-q.x))>1e-9) out.push(q); }
  out.push(pts[pts.length-1]);
  return [...head.slice(0,-1),...out,...tail.slice(1)];
}
