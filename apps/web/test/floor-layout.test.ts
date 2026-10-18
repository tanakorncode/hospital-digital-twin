import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { sampleFacility as template } from '../../api/src/facility-template';
import { facility, setFacility, type Facility } from '../lib/facility';
import { CORRIDOR, SEAT_DX, SEAT_DZ, floorFrame, floorRoute, planFloor, roomFrame, roomPoint, seatCapacity } from '../lib/floor-layout';
import { layoutFloor } from '../lib/floor-preview';
import { erBedSpots, erResusSpots, wardBeds } from '../lib/patients';
import { allStations } from '../lib/queue';
import { buildings, floorRooms, waitingSeats } from '../lib/scene-data';
import { useLayout } from './facility-helpers';

// One set of layout rules (lib/floor-layout.ts) behind the 3D map, the patients' positions and the settings page's
// floor preview: what the preview shows for a draft is where things stand on the map once it is published.
afterEach(() => useLayout(undefined));
let v = 5000;
const publish = (f:Omit<Facility,'version'|'publishedAt'>) => setFacility({...f,version:++v,publishedAt:`layout-${v}`});
const near = (a:number, b:number) => Math.abs(a-b)<1e-9;
const data = () => { const {version:_v, publishedAt:_p, ...d} = structuredClone(facility()); return d; };

// The map's positions on a floor, relative to the building's centre (as the preview draws them).
function mapOf(buildingId:string, level:number) {
  const b = buildings.find(x=>x.id===buildingId)!, rel = (s:{x:number; z:number}) => ({x:s.x-b.x,z:s.z-b.z});
  const rooms = floorRooms(buildingId,level).map(r=>({id:r.pointId,x0:-b.width/2+r.index*b.width/r.count}));
  const counters = allStations().filter(s=>s.buildingId===buildingId && s.level===level && !s.roomId && !s.id.startsWith('room:') && floorRooms(buildingId,level).every(r=>r.pointId!==s.id)).map(s=>({id:s.id,...rel(s.spot)}));
  const beds = [...wardBeds().filter(w=>w.buildingId===buildingId && w.level===level),...erBedSpots(),...erResusSpots()].filter(x=>Math.abs(x.spot.y-((level-1)*0.8+0.11))<1e-9 && Math.abs(x.spot.x-b.x)<=b.width/2 && Math.abs(x.spot.z-b.z)<=b.depth/2)
    .map(x=>({id:x.id,...rel(x.spot)}));
  return {rooms,counters,beds};
}

test('the preview of every floor is where the map puts things (sample hospital)', () => {
  useLayout(undefined);
  const f = data();
  for (const floor of f.floors) {
    const L = layoutFloor(f,floor.id)!, map = mapOf(floor.buildingId,floor.level);
    assert.deepEqual(L.rooms.map(r=>r.id),map.rooms.map(r=>r.id),`${floor.id} rooms`);
    L.rooms.forEach((r,i)=>assert.ok(near(r.x0,map.rooms[i].x0),`${floor.id} ${r.id}`));
    for (const c of map.counters) { const p = L.counters.find(x=>x.id===c.id); assert.ok(p,`${floor.id} ${c.id}`); assert.ok(near(p.x,c.x) && near(p.z,c.z),`${floor.id} ${c.id} at`); }
    for (const bd of map.beds) { const p = L.beds.find(x=>x.id===bd.id); assert.ok(p,`${floor.id} ${bd.id}`); assert.ok(near(p.x,bd.x) && near(p.z,bd.z),`${floor.id} ${bd.id} at`); }
  }
});

test('waiting chairs are seated where the 3D map always seated them', () => {
  useLayout(undefined);
  const f = data();
  for (const floor of f.floors) {
    const plan = planFloor(f,floor.id)!, b = f.buildings.find(x=>x.id===floor.buildingId)!, hd = plan.D/2, {front0} = floorFrame(plan.W,plan.D);
    plan.bands.forEach((band,i)=>{
      // The 3D map's old rule: chairs in every band, from the corridor (behind the booths for a booth band), none in wards,
      // support buildings or a band with beds out in it.
      const booths = plan.counters.some(c=>c.booth && c.group.departmentId===band.deptId), resus = plan.beds.some(x=>!x.room && !x.ward && x.group.departmentId===band.deptId);
      const expected:{x:number; z:number}[] = [];
      if (b.kind!=='inpatient' && b.kind!=='support' && !resus)
        for (let z=front0+(booths?2:CORRIDOR); z<hd-0.3; z+=SEAT_DZ) for (let x=band.x0+0.45; x<band.x1-0.3; x+=SEAT_DX) expected.push({x,z});
      assert.deepEqual(band.seats,expected,`${floor.id} band ${i}`);
    });
  }
});

test('a group can set its waiting chairs: a number, none, or chairs where the building type has none', () => {
  const f = structuredClone(template());
  const pharmacy = f.groups.find(g=>g.id==='counter:pharmacy')!, opd1 = 'opd-1';
  pharmacy.options = {seats:12};
  let plan = planFloor(f,opd1)!;
  assert.equal(plan.bands.find(x=>x.deptId===pharmacy.departmentId)!.seats.length,12);
  pharmacy.options = {seats:0};
  plan = planFloor(f,opd1)!;
  assert.equal(plan.bands.find(x=>x.deptId===pharmacy.departmentId)!.seats.length,0);
  pharmacy.options = {seats:9999};
  plan = planFloor(f,opd1)!;
  assert.equal(plan.bands.find(x=>x.deptId===pharmacy.departmentId)!.seats.length,seatCapacity(plan,pharmacy.departmentId),'never more than the band holds');
  // A ward normally has no waiting chairs; a group there can ask for some.
  const ward = f.groups.find(g=>g.id==='beds:inpatient-3-0')!;
  assert.equal(planFloor(f,'inpatient-3')!.bands[0].seats.length,0);
  ward.options = {seats:6};
  assert.equal(planFloor(f,'inpatient-3')!.bands[0].seats.length,6);
  // The map follows once published, and counts them for the waiting area.
  pharmacy.options = {seats:12};
  publish(f);
  assert.equal(waitingSeats('opd',1,pharmacy.departmentId),12);
  assert.equal(waitingSeats('inpatient',3,'inpatient-3-0'),6);
});

test('a department added in the draft: the preview shows it where the map puts it after publishing', () => {
  const f = structuredClone(template());
  f.departments.push({id:'d_kidney',name:'คลินิกโรคไต',type:'clinic',queuePrefix:'K',features:{booking:true,appointments:true,walkIn:true},firstGroupId:'g_ks',active:true});
  f.groups.push({id:'g_ks',departmentId:'d_kidney',name:'ซักประวัติโรคไต',floorId:'opd-4',pointKind:'counter',pointNoun:'ช่องบริการ',steps:['screening'],serves:'department',minOpen:1,active:true},
    {id:'g_ke',departmentId:'d_kidney',name:'ห้องตรวจโรคไต',floorId:'opd-4',pointKind:'room',pointNoun:'ห้องตรวจ',steps:['exam','followup'],serves:'department',minOpen:1,active:true});
  f.points.push({id:'p_ks1',groupId:'g_ks',number:1,active:true},{id:'p_ks2',groupId:'g_ks',number:2,active:true},
    {id:'p_ke1',groupId:'g_ke',number:1,roomCode:'407',active:true},{id:'p_ke2',groupId:'g_ke',number:2,roomCode:'408',active:true});
  const preview = layoutFloor(f,'opd-4','g_ke')!;
  assert.deepEqual(preview.bands.map(b=>b.name),['คลินิกพิเศษ','ตา','หู คอ จมูก','คลินิกโรคไต'],'its own waiting band, after the others');
  assert.equal(preview.tag,'ห้องตรวจ 1–2');
  publish(f);
  const map = mapOf('opd',4);
  assert.deepEqual(preview.rooms.map(r=>r.id),map.rooms.map(r=>r.id));
  for (const id of ['p_ks1','p_ks2']) { const p = preview.counters.find(x=>x.id===id)!, m = map.counters.find(x=>x.id===id)!; assert.ok(near(p.x,m.x) && near(p.z,m.z),id); }
  assert.ok(preview.seats.some(s=>s.focus),'its waiting chairs');
});

const inside = (p:{x:number; z:number}, r:{x0:number; x1:number; z0:number; z1:number}) => p.x>=r.x0-1e-9 && p.x<=r.x1+1e-9 && p.z>=r.z0-1e-9 && p.z<=r.z1+1e-9;

test('a floor\'s proportions: room depth, the order and widths of rooms and waiting bands', () => {
  const f = structuredClone(template()), floor = f.floors.find(x=>x.id==='opd-2')!;
  const before = planFloor(f,'opd-2')!;
  floor.layout = {roomDepth:0.3, bandOrder:['opd-2-2'], bandWeights:{'opd-2-2':2}, roomOrder:['room:opd-206'], roomWeights:{'room:opd-206':3}};
  const plan = planFloor(f,'opd-2')!;
  assert.ok(near(plan.roomFront,-plan.D/2+plan.D*0.3),'shallower rooms');
  assert.ok(plan.rooms.every(r=>near(r.z1,plan.roomFront)));
  assert.equal(plan.bands[0].deptId,'opd-2-2','moved to the left');
  const w = plan.bands.map(b=>b.x1-b.x0);
  assert.ok(near(w[0],2*w[1]) && near(w[1],w[2]),'twice as wide');
  assert.ok(near(plan.bands[0].x0,-plan.W/2) && near(plan.bands.at(-1)!.x1,plan.W/2),'still the whole width');
  assert.equal(plan.rooms[0].point.id,'room:opd-206');
  assert.ok(near(plan.rooms[0].w,3*plan.rooms[1].w));
  assert.deepEqual(plan.rooms.map(r=>r.point.id).sort(),before.rooms.map(r=>r.point.id).sort(),'the same rooms');
  // Counters and chairs follow their band.
  for (const c of plan.counters) assert.ok(inside(c.at,plan.bands.find(b=>b.deptId===c.group.departmentId)!),c.point.id);
  for (const b of plan.bands) for (const st of b.seats) assert.ok(inside(st,b));
});

test('a floor laid out by hand: rooms with their door, waiting areas, the rest where they would be', () => {
  const f = structuredClone(template()), floor = f.floors.find(x=>x.id==='er-1')!;
  const auto = planFloor(f,'er-1')!, hw = auto.W/2, hd = auto.D/2;
  const room = auto.rooms[0], other = auto.rooms[1];
  floor.layout = {mode:'manual', rooms:{[room.point.id]:{x0:-hw,z0:0,x1:-hw+3,z1:4,door:'e'}}, areas:{[auto.bands[0].deptId]:{x0:0,z0:-hd,x1:hw,z1:-hd+5}}};
  const plan = planFloor(f,'er-1')!;
  assert.equal(plan.manual,true); assert.equal(plan.corridor,null,'no corridor by hand');
  const r0 = plan.rooms.find(r=>r.point.id===room.point.id)!;
  assert.deepEqual([r0.x0,r0.z0,r0.x1,r0.z1,r0.door],[-hw,0,-hw+3,4,'e']);
  const r1 = plan.rooms.find(r=>r.point.id===other.point.id)!;
  assert.deepEqual([r1.x0,r1.z0,r1.x1,r1.z1,r1.door],[other.x0,other.z0,other.x1,other.z1,'s'],'not placed yet: where the automatic layout puts it');
  // Beds stay in their room — along the back wall, away from the door on the east side.
  const inR0 = plan.beds.filter(b=>b.room?.point.id===room.point.id);
  assert.ok(inR0.length>0);
  for (const b of inR0) { assert.ok(inside(b.at,r0),b.point.id); assert.ok(b.at.x<(r0.x0+r0.x1)/2,'by the wall opposite the door'); }
  const area = plan.bands[0];
  assert.deepEqual([area.x0,area.z0,area.x1,area.z1],[0,-hd,hw,-hd+5]);
  for (const c of plan.counters.filter(c=>c.group.departmentId===area.deptId)) assert.ok(inside(c.at,area),c.point.id);
  for (const b of plan.beds.filter(b=>!b.room && b.group.departmentId===area.deptId)) assert.ok(inside(b.at,area),b.point.id);
  // Switching back to automatic keeps the placements but uses the automatic layout.
  floor.layout.mode = 'auto';
  assert.deepEqual(planFloor(f,'er-1')!.rooms.map(r=>[r.x0,r.z0]),auto.rooms.map(r=>[r.x0,r.z0]));
});

test('a floor laid out by hand: the map, the patients and the preview agree once published', () => {
  const f = structuredClone(template()), floor = f.floors.find(x=>x.id==='opd-4')!;
  const auto = planFloor(f,'opd-4')!, hw = auto.W/2, hd = auto.D/2;
  const rooms:Record<string,{x0:number; z0:number; x1:number; z1:number; door:'n'|'s'|'e'|'w'}> = {};
  auto.rooms.forEach((r,k)=>{ rooms[r.point.id] = {x0:-hw+(k%6)*2,z0:k<6 ? -hd : hd-3,x1:-hw+(k%6)*2+2,z1:k<6 ? -hd+3 : hd,door:k<6 ? 's' : 'n'}; });
  const areas = Object.fromEntries(auto.bands.map((b,i)=>[b.deptId,{x0:-hw+i*(auto.W/auto.bands.length),z0:-hd+3.5,x1:-hw+(i+1)*(auto.W/auto.bands.length),z1:hd-3.5}]));
  floor.layout = {mode:'manual',rooms,areas};
  const preview = layoutFloor(f,'opd-4')!;
  publish(f);
  const b = buildings.find(x=>x.id==='opd')!;
  const mapRooms = floorRooms('opd',4);
  assert.deepEqual(mapRooms.map(r=>[r.pointId,r.x0,r.z0,r.x1,r.z1,r.door]),preview.rooms.map(r=>[r.id,r.x0,r.z0,r.x0+r.w,r.z0+r.d,r.door]));
  // Each exam room's doctor station and the clinic's screening counters stand where the preview shows them.
  for (const s of allStations().filter(s=>s.buildingId==='opd' && s.level===4 && !s.id.startsWith('room:'))) {
    const p = preview.counters.find(c=>c.id===s.id); if (!p) continue;
    assert.ok(near(p.x,s.spot.x-b.x) && near(p.z,s.spot.z-b.z),s.id);
  }
  for (const r of mapRooms) { const at = allStations().find(s=>s.id===r.pointId)?.spot; if (at) assert.ok(inside({x:at.x-b.x,z:at.z-b.z},r),`${r.pointId} patient inside its room`); }
});

test('the lift: by the corridor at the front-left, or where it was put on the floor', () => {
  const f = structuredClone(template()), floor = f.floors.find(x=>x.id==='opd-2')!;
  let plan = planFloor(f,'opd-2')!;
  assert.ok(near(plan.lift.x,-plan.W/2+0.6) && near(plan.lift.z,-plan.D/2+plan.D*0.42+0.6),'where it always was');
  floor.layout = {lift:{x:3,z:-1}};
  plan = planFloor(f,'opd-2')!;
  assert.deepEqual(plan.lift,{x:3,z:-1});
});

test('directions on a floor laid out by hand: out of the door, around the rooms, in through the target\'s door', () => {
  const f = structuredClone(template()), floor = f.floors.find(x=>x.id==='opd-4')!;
  const auto = planFloor(f,'opd-4')!, hw = auto.W/2, hd = auto.D/2;
  // A row of rooms across the middle with their doors facing the front; the lift behind them.
  const rooms:Record<string,{x0:number; z0:number; x1:number; z1:number; door:'n'|'s'|'e'|'w'}> = {};
  auto.rooms.forEach((r,k)=>{ const w = (auto.W-2)/auto.rooms.length; rooms[r.point.id] = {x0:-hw+k*w,z0:-1.5,x1:-hw+(k+1)*w,z1:1.5,door:'s'}; });
  floor.layout = {mode:'manual',rooms,lift:{x:0,z:-hd+0.6}};
  const plan = planFloor(f,'opd-4')!, target = plan.rooms[3], inside = roomPoint(target,roomFrame(target).across/2,1);
  const path = floorRoute(plan,plan.lift,inside);
  assert.deepEqual(path[0],plan.lift); assert.deepEqual(path.at(-1),inside);
  // Every step of the way: in the building, and inside no room except the target (entered at its door).
  const strictlyIn = (p:{x:number; z:number}, r:{x0:number; x1:number; z0:number; z1:number}) => p.x>r.x0+1e-6 && p.x<r.x1-1e-6 && p.z>r.z0+1e-6 && p.z<r.z1-1e-6;
  for (let k=0; k<path.length-1; k++) for (let u=0; u<=1; u+=0.02) {
    const p = {x:path[k].x+(path[k+1].x-path[k].x)*u,z:path[k].z+(path[k+1].z-path[k].z)*u};
    assert.ok(Math.abs(p.x)<=hw+1e-6 && Math.abs(p.z)<=hd+1e-6,'inside the building');
    for (const r of plan.rooms) if (r!==target) assert.ok(!strictlyIn(p,r),`through ${r.point.id} at ${p.x.toFixed(2)},${p.z.toFixed(2)}`);
  }
  // It goes round the end of the row (the gap on the right) and comes in from the front, where the door is.
  assert.ok(path.some(p=>p.x>plan.rooms.at(-1)!.x1),'round the end of the row');
  assert.ok(path.at(-3)!.z>target.z1,'from in front of the door');
  // A few straight legs, not a staircase.
  assert.ok(path.length<=10,`${path.length} points`);
});
