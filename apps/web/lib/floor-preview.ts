// The settings page's floor preview: the shared floor layout (lib/floor-layout.ts — the same function the 3D map and the
// patients' positions use) run on the draft, plus what the preview adds: names, what is on / off, the group being
// edited and its call-out. Pure, so tests can hold it against the map.
import type { Facility, FGroup, FPoint } from './facility';
import { planFloor, type Door, type FloorPlan } from './floor-layout';

type Data = Omit<Facility,'version'|'publishedAt'>;
const label = (g:FGroup|undefined, p:FPoint) => p.name || `${g?.pointNoun ?? ''} ${p.number}`.trim();
const live = (x?:{active:boolean; retiredAt?:string}) => !!x && x.active && !x.retiredAt;
type Item = {id:string; x:number; z:number; on:boolean; hi:boolean; number:number};
// Rooms and waiting areas are rectangles x0…x0+w × z0…z0+d (building-local); a room's door is in its `door` wall.
export type FloorLayout = {title:string; W:number; D:number; roomFront:number; front0:number; corridor:[number,number]|null; background?:FloorPlan['background'];
  bands:{id:string; name:string; x0:number; w:number; z0:number; d:number; on:boolean; focus:boolean}[];
  rooms:{id:string; x0:number; w:number; z0:number; d:number; door:Door; doorAt?:number; name:string; short:string; on:boolean; hi:boolean}[];
  counters:(Item & {booth:boolean})[]; beds:Item[]; seats:{x:number; z:number; focus:boolean}[]; tag:string; tagAt?:{x:number; z:number}; focusKind?:string};
// The preview is the shared floor layout (lib/floor-layout.ts — the same function the 3D map and the patients'
// positions use) run on the draft, plus what the preview adds: names, what is on / off, the group being edited.
export function layoutFloor(data:Data, floorId:string, focus?:string):FloorLayout|null {
  const plan = planFloor(data,floorId); if (!plan) return null;
  const b = data.buildings.find(x=>x.id===plan.buildingId)!, floor = data.floors.find(x=>x.id===floorId)!;
  const dept = new Map(data.departments.map(d=>[d.id,d]));
  const on = (p:FPoint, g:FGroup) => live(p) && live(g), fg = focus ? data.groups.find(g=>g.id===focus) : undefined;
  const item = (p:FPoint, g:FGroup, at:{x:number; z:number}):Item => ({id:p.id,x:at.x,z:at.z,on:on(p,g),hi:g.id===focus,number:p.number});
  const rooms = plan.rooms.map(r=>({id:r.point.id,x0:r.x0,w:r.x1-r.x0,z0:r.z0,d:r.z1-r.z0,door:r.door,doorAt:r.doorAt,name:label(r.group,r.point),short:r.point.roomCode ?? String(r.point.number),on:on(r.point,r.group),hi:r.group.id===focus}));
  const counters = plan.counters.map(c=>({...item(c.point,c.group,c.at),booth:c.booth}));
  const beds = plan.beds.map(bd=>item(bd.point,bd.group,bd.at));
  const seats = plan.bands.flatMap(bd=>bd.seats.map(st=>({...st,focus:!!fg && fg.departmentId===bd.deptId})));
  // The group being edited, called out with its name and its numbers, by the first of its rooms / counters / beds.
  const mine = [...rooms.filter(r=>r.hi).map(r=>({x:r.x0+r.w/2,z:r.z0+r.d})),...counters.filter(c=>c.hi),...beds.filter(c=>c.hi)];
  const nums = fg ? [...plan.rooms,...plan.counters,...plan.beds].filter(x=>x.group.id===fg.id).map(x=>x.point.number).sort((a,c)=>a-c) : [];
  const tag = fg && mine.length ? `${fg.pointNoun} ${nums.length>1 ? `${nums[0]}–${nums[nums.length-1]}` : nums[0] ?? ''}`.trim() : '';
  return {title:`${b.shortName || b.name} ${floor.name}`,W:plan.W,D:plan.D,roomFront:plan.roomFront,front0:plan.front0,corridor:plan.corridor,background:plan.background,rooms,counters,beds,seats,tag,
    tagAt:mine[0] ? {x:Math.min(...mine.map(m=>m.x)),z:Math.max(...mine.map(m=>m.z))} : undefined,focusKind:fg?.pointKind,
    bands:plan.bands.map(bd=>({id:bd.deptId,name:bd.name,x0:bd.x0,w:bd.x1-bd.x0,z0:bd.z0,d:bd.z1-bd.z0,on:live(dept.get(bd.deptId)),focus:!!fg && fg.departmentId===bd.deptId}))};
}

