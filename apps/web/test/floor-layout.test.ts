import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { sampleFacility as template } from '../../api/src/facility-template';
import { facility, setFacility, type Facility } from '../lib/facility';
import { CORRIDOR, SEAT_DX, SEAT_DZ, floorFrame, planFloor, seatCapacity } from '../lib/floor-layout';
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
