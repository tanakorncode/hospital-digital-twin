'use client';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Instances, Instance, Line } from '@react-three/drei';
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import * as THREE from 'three';
import { screenData, type ScreenData } from '../lib/queue-screen';
import { BedDouble, DoorOpen, FlaskConical, Plus, Settings, SquareParking, Ticket, type LucideIcon } from 'lucide-react';
import { bandBeds, bandBooths, fmtMin, patientAt, statusColor as patientColor, stepText, wardBeds, type Patient, type PatientState, type StepKind } from '../lib/patients';
import { REF_HOUR, entranceSpot, floorBands, isOff, layoutRevision, plazas, kioskY, kiosks, type KioskStatus, buildingDensityAt, doctorName, findRoom, floorDutyAt, floorRooms, type DutyStatus, buildings, buildingStats, demoFlows, densityColor, fillerBuildings, floorCountAt, floorDepartments, floorPresence, isRealMode, kindPresence, peakFloorCount, parkingLots, personTypes, roads, type BuildingKind, type PersonType, type BuildingSpec, type Department, type Rect } from '../lib/scene-data';
import { buildingShort, facility } from '../lib/facility';

export type SceneMode = '2d'|'3d';
export type SceneView = 'campus'|'building'|'floor'|'department';
export type SceneApi = { zoomBy:(factor:number)=>void; reset:()=>void };

const floorH = 0.8, bandH = 0.3, glassH = floorH-bandH;
type V3 = [number,number,number];

// Deterministic so the campus looks the same on every load.
function seeded(seed:number) { return ()=>{ seed=(seed*16807)%2147483647; return (seed-1)/2147483646; }; }
const pick = <T,>(r:()=>number, list:readonly T[]) => list[Math.floor(r()*list.length)];
const inRect = (x:number,z:number,[x0,z0,x1,z1]:Rect,m=0) => x>x0-m && x<x1+m && z>z0-m && z<z1+m;
const footprint = (b:BuildingSpec):Rect => [b.x-b.width/2,b.z-b.depth/2,b.x+b.width/2,b.z+b.depth/2];

const personColor = Object.fromEntries(personTypes.map(t=>[t.id,t.color])) as Record<PersonType,string>;
// Relative weights of who is found where in the ambient crowd (demo assumption, not live data).
// No patient types here: every patient on the map is a tracked patient with a record you can open.
type Mix = Partial<Record<PersonType,number>>;
const outdoorMix:Mix = {visitor:3,staff:1,doctor:0.3};
const floorMix:Record<BuildingKind,Mix> = {opd:{visitor:3,staff:1,doctor:0.3},er:{visitor:3,staff:2,doctor:0.8},inpatient:{visitor:3,staff:2,doctor:0.4},diagnostics:{visitor:2,staff:2,doctor:0.5},support:{staff:1}};
const entranceMix:Partial<Record<BuildingKind,Mix>> = {er:{visitor:2,staff:2},inpatient:{visitor:4,staff:2}};
// Who walks a route, by the kind of building it leads to.
const flowMix:Record<BuildingKind,Mix> = {er:{visitor:2,staff:1,doctor:0.4},inpatient:{visitor:3,staff:2,doctor:0.5},opd:{visitor:4,staff:0.5},diagnostics:{visitor:2,staff:1},support:{staff:1}};
function weighted<K extends string>(r:()=>number,mix:Partial<Record<K,number>>):K {
 const entries = Object.entries(mix) as [K,number][];
 let roll = r()*entries.reduce((n,[,w])=>n+w,0);
 for (const [k,w] of entries) { if ((roll-=w)<0) return k; }
 return entries[0][0];
}
const pickType = (r:()=>number,mix:Mix) => weighted<PersonType>(r,mix);

// Demographics shape each figure: children are small with big heads, elderly are hunched with white
// hair (some with a cane), middle-aged have greying hair, most women have long hair and some wear a skirt.
type Age = 'child'|'adult'|'middle'|'elderly';
const ageMix:Record<PersonType,Partial<Record<Age,number>>> = {
 patient:{child:1.5,adult:3,middle:3,elderly:3}, emergency:{child:1,adult:3,middle:3,elderly:2}, inpatient:{child:1,adult:2,middle:3,elderly:4},
 visitor:{child:2,adult:4,middle:3,elderly:1}, staff:{adult:3,middle:2}, doctor:{adult:3,middle:2},
};
const skinTones = ['#f1c9a5','#e8b78f','#d49a72','#f6d7bb','#c58b63'];
// Mid-tone everyday trousers (jeans, khaki, beige, light grey) so figures don't read as dark blobs.
const pantsColors = ['#5b7bb3','#7d8da3','#a48e6c','#4f6b8a','#c2b59b','#8a94a3'];
const hairByAge:Record<Age,string[]> = {child:['#1f1a17','#2b211b','#3a2a1f'],adult:['#1f1a17','#2b211b','#3a2a1f','#4a3222'],middle:['#4a4440','#5d5650','#2b211b'],elderly:['#ecebe8','#d4d5d7','#c4c4c4']};
// presence: shown while the hour's crowd share is above it, so quieter hours show fewer of the same people.
type Person = {x:number;y:number;z:number;type:PersonType;age:Age;female:boolean;yaw:number;skin:string;hair:string;pants:string;dress:boolean;cane:boolean;longHair:boolean;presence:number;dutyRoom?:string;lying?:boolean};
// dutyRoom: a doctor tied to that room's roster — only shown while the roster says they are examining.
function makePerson(r:()=>number,x:number,y:number,z:number,type:PersonType):Person {
 const age = weighted<Age>(r,ageMix[type]);
 const female = type==='staff' ? r()<0.8 : r()<0.5;
 const uniformed = type==='staff' || type==='doctor';
 return {x,y,z,type,age,female,presence:r(),yaw:r()*Math.PI*2,skin:pick(r,skinTones),hair:pick(r,hairByAge[age]),
  pants:type==='staff'?'#ffffff':type==='doctor'?personColor.doctor:pick(r,pantsColors),
  // Female nurses wear the classic white dress; some other women and girls wear a skirt.
  dress:female && (type==='staff' || (!uniformed && type!=='inpatient' && r()<0.45)),
  cane:age==='elderly' && !uniformed && r()<0.55,
  longHair:female && age!=='elderly' && r()<0.75};
}
const carColors = ['#f4f6f8','#d9dde1','#3c4650','#c7372f','#2f6fb5','#9aa4ad','#f4f6f8'];
const treeGreens = ['#3e8b45','#4c9a4c','#2f7a3e','#5aa653','#47914a'];
const statusColor = (s:Department['status']) => s==='critical'?'#ef4444':s==='busy'?'#f5a524':'#22c58b';

const labelIcons:Record<BuildingKind,{Icon:LucideIcon;color:string;bg?:string}> = {
 opd:{Icon:Plus,color:'#1677ff'},
 inpatient:{Icon:BedDouble,color:'#1677ff'},
 er:{Icon:Plus,color:'#fff',bg:'#e5383b'},
 diagnostics:{Icon:FlaskConical,color:'#1677ff'},
 support:{Icon:Settings,color:'#1677ff'},
};
type SignKind = 'room'|'counter'|'area';
// minZoom: only shown once the camera is zoomed past this multiple of the base zoom.
// What a label shows, for the map's "labels" menu (route pins, beds and floor tags are always shown).
export type LabelKind = 'building'|'zone'|'room'|'counter'|'area'|'kiosk';
const labelKindOf = (l:LabelSpec):LabelKind|undefined => l.kiosk ? 'kiosk' : l.variant==='zone' ? 'zone' : l.variant==='room' || l.variant==='counter' || l.variant==='area' ? l.variant : l.variant==='tag' || l.variant==='pin' ? 'building' : undefined;
type LabelSpec = {id:string;pos:V3;text:string;variant:'tag'|'pin'|'floor'|'zone'|'route'|'bed'|SignKind;bedState?:string;bedId?:string;routeState?:'done'|'now'|'next';num?:string;sub?:string;building?:string;floor?:number;room?:string;kiosk?:string;tone?:DutyStatus;Icon?:LucideIcon;iconColor?:string;iconBg?:string;dot?:string;minZoom?:number};
const buildingTag = (b:BuildingSpec,y:number):LabelSpec => ({id:b.id,pos:[b.x,y,b.z],text:b.name,variant:'tag',building:b.id,Icon:labelIcons[b.kind].Icon,iconColor:labelIcons[b.kind].color,iconBg:labelIcons[b.kind].bg});
// Campus labels from the facility: every building (the OPD as a pin with its short name), the main entrance, the car park.
const campusLabels = ():LabelSpec[] => { const e = entranceSpot(), lot = parkingLots[0];
 return [...buildings.map<LabelSpec>(b=>b.kind==='opd'
  ? {id:b.id,pos:[b.x+2.5,b.floors*floorH+0.7,b.z+1],text:buildingShort(b.id),variant:'pin',building:b.id}
  : buildingTag(b,b.floors*floorH+0.9)),
 {id:'entrance',pos:[e.x,1.6,e.z],text:'ทางเข้า',variant:'tag',Icon:DoorOpen,iconColor:'#1677ff'},
 ...(lot ? [{id:'parking',pos:[(lot[0]+lot[2])/2,0.4,(lot[1]+lot[3])/2],text:'ลานจอดรถ',variant:'tag',Icon:SquareParking,iconColor:'#fff',iconBg:'#111b26'} as LabelSpec] : [])]; };

function Flat({r,y,color}:{r:Rect;y:number;color:string}) {
 return <mesh rotation-x={-Math.PI/2} position={[(r[0]+r[2])/2,y,(r[1]+r[3])/2]} receiveShadow><planeGeometry args={[r[2]-r[0],r[3]-r[1]]}/><meshStandardMaterial color={color}/></mesh>;
}
function Box({p,s,color,cast=true,...mat}:{p:V3;s:V3;color:string;cast?:boolean;emissive?:string;emissiveIntensity?:number;metalness?:number;roughness?:number}) {
 return <mesh position={p} castShadow={cast} receiveShadow><boxGeometry args={s}/><meshStandardMaterial color={color} {...mat}/></mesh>;
}

function Ground() {
 const dashes = useMemo(()=>{
  const out:{p:V3;rotY:number}[] = [];
  roads.forEach((r,i)=>{
   const alongX = r[2]-r[0] > r[3]-r[1];
   if (Math.min(r[2]-r[0],r[3]-r[1])<1.9) return;
   const [a0,a1] = alongX ? [r[0],r[2]] : [r[1],r[3]];
   const c = alongX ? (r[1]+r[3])/2 : (r[0]+r[2])/2;
   for (let a=Math.max(a0,-40); a<Math.min(a1,45); a+=1.6) {
    const [x,z] = alongX ? [a,c] : [c,a];
    if (!roads.some((o,j)=>j!==i && inRect(x,z,o,0.6))) out.push({p:[x,0.035,z],rotY:alongX?0:Math.PI/2});
   }
  });
  return out;
 },[]);
 const stalls = useMemo(()=>parkingLots.flatMap(([x0,z0,x1,z1])=>{
  const out:V3[] = [], zm = (z0+z1)/2;
  for (let x=x0+0.1; x<=x1; x+=1.1) out.push([x,0.04,(z0+zm)/2],[x,0.04,(zm+z1)/2]);
  return out;
 }),[]);
 return <group>
  <Flat r={[-150,-150,150,150]} y={0} color="#8fbc6c"/>
  {plazas.map((r,i)=><Flat key={'plaza'+i} r={r} y={0.012} color="#e4e6e1"/>)}
  {roads.map((r,i)=><Flat key={'walk'+i} r={[r[0]-0.4,r[1]-0.4,r[2]+0.4,r[3]+0.4]} y={0.016} color="#d3d8d8"/>)}
  {roads.map((r,i)=><Flat key={'road'+i} r={r} y={0.022} color="#59656d"/>)}
  {parkingLots.map((r,i)=><Flat key={'lot'+i} r={r} y={0.026} color="#626e76"/>)}
  <Instances limit={dashes.length}><boxGeometry args={[0.7,0.01,0.08]}/><meshStandardMaterial color="#f2f2ea"/>
   {dashes.map((d,i)=><Instance key={i} position={d.p} rotation={[0,d.rotY,0]}/>)}
  </Instances>
  <Instances limit={stalls.length}><boxGeometry args={[0.05,0.01,2.6]}/><meshStandardMaterial color="#eef0f0"/>
   {stalls.map((p,i)=><Instance key={i} position={p}/>)}
  </Instances>
 </group>;
}

function Trees() {
 const trees = useMemo(()=>{
  const r = seeded(7), out:{x:number;z:number;s:number;c:string}[] = [];
  const blocked = (x:number,z:number) => roads.some(o=>inRect(x,z,o,0.8)) || parkingLots.some(o=>inRect(x,z,o,0.7)) || plazas.some(o=>inRect(x,z,o,0.3)) || fillerBuildings.some(b=>inRect(x,z,footprint(b),0.9));
  for (let i=0; out.length<900 && i<20000; i++) {
   const x = -42+r()*82, z = -42+r()*66;
   if (!blocked(x,z)) out.push({x,z,s:0.75+r()*0.6,c:pick(r,treeGreens)});
  }
  return out;
 },[]);
 return <group>
  <Instances limit={trees.length} castShadow><cylinderGeometry args={[0.07,0.1,0.6,6]}/><meshStandardMaterial color="#7a5a3f"/>
   {trees.map((t,i)=><Instance key={i} position={[t.x,0.3*t.s,t.z]} scale={t.s}/>)}
  </Instances>
  <Instances limit={trees.length} castShadow><icosahedronGeometry args={[0.55,1]}/><meshStandardMaterial roughness={0.9} flatShading/>
   {trees.map((t,i)=><Instance key={i} position={[t.x,0.95*t.s,t.z]} scale={[t.s,t.s*1.05,t.s]} color={t.c}/>)}
  </Instances>
 </group>;
}

function Cars() {
 const cars = useMemo(()=>{
  const r = seeded(11), out:{p:V3;rotY:number;c:string}[] = [];
  parkingLots.forEach(([x0,z0,x1,z1])=>{
   const zm = (z0+z1)/2;
   for (let x=x0+0.65; x<x1-0.3; x+=1.1) for (const z of [(z0+zm)/2,(zm+z1)/2]) if (r()<0.72) out.push({p:[x,0,z],rotY:0,c:pick(r,carColors)});
  });
  // A car or two driving on each road wide enough for two lanes, in its lanes.
  roads.forEach(([x0,z0,x1,z1])=>{ const alongX = x1-x0>z1-z0, lane = (alongX ? z1-z0 : x1-x0)/4; if (lane*4<1.9) return;
   for (let k=0;k<2;k++) { const t = -24+r()*48, side = k ? lane : -lane;
    const x = alongX ? Math.min(x1-1,Math.max(x0+1,t)) : (x0+x1)/2+side, z = alongX ? (z0+z1)/2+side : Math.min(z1-1,Math.max(z0+1,t));
    out.push({p:[x,0,z],rotY:alongX?Math.PI/2:0,c:pick(r,carColors)}); } });
  return out;
 },[]);
 return <group>
  <Instances limit={cars.length} castShadow><boxGeometry args={[0.6,0.3,1.15]}/><meshStandardMaterial roughness={0.4} metalness={0.2}/>
   {cars.map((c,i)=><Instance key={i} position={[c.p[0],0.2,c.p[2]]} rotation={[0,c.rotY,0]} color={c.c}/>)}
  </Instances>
  <Instances limit={cars.length}><boxGeometry args={[0.52,0.2,0.6]}/><meshStandardMaterial color="#2b3a47" roughness={0.2} metalness={0.4}/>
   {cars.map((c,i)=><Instance key={i} position={[c.p[0],0.44,c.p[2]]} rotation={[0,c.rotY,0]}/>)}
  </Instances>
 </group>;
}

function ClosedFloors({b,from,to,tints}:{b:BuildingSpec;from:number;to:number;tints?:string[]}) {
 const fins = useMemo(()=>{
  const out:V3[] = [];
  for (let i=from; i<to; i++) {
   const y = i*floorH+bandH+glassH/2;
   for (let x=-b.width/2+0.35; x<b.width/2; x+=0.7) out.push([x,y,b.depth/2],[x,y,-b.depth/2]);
   for (let z=-b.depth/2+0.35; z<b.depth/2; z+=0.7) out.push([b.width/2,y,z],[-b.width/2,y,z]);
  }
  return out;
 },[b,from,to]);
 return <group>
  {Array.from({length:to-from},(_,k)=>{const i=from+k;return <group key={i}>
   <Box p={[0,i*floorH+bandH/2,0]} s={[b.width,bandH,b.depth]} color={tints?.[i]??b.color}/>
   <Box p={[0,i*floorH+bandH+glassH/2,0]} s={[b.width-0.14,glassH,b.depth-0.14]} color="#7fb2d9" metalness={0.35} roughness={0.25}/>
  </group>;})}
  {/* key: drei <Instances> allocates buffers from its first `limit`; remount when the count changes. */}
  {fins.length>0 && <Instances key={fins.length} limit={fins.length}><boxGeometry args={[0.07,glassH,0.07]}/><meshStandardMaterial color="#f5f7f9"/>
   {fins.map((p,i)=><Instance key={i} position={p}/>)}
  </Instances>}
 </group>;
}

function Roof({b,active,tint}:{b:BuildingSpec;active:boolean;tint?:string}) {
 const top = b.floors*floorH;
 const units = useMemo(()=>{const r=seeded(b.width*100+b.depth);return Array.from({length:3},()=>[(r()-0.5)*(b.width-2.4),(r()-0.5)*(b.depth-2.4),0.5+r()*0.7] as V3);},[b]);
 return <group>
  <Box p={[0,top+0.09,0]} s={[b.width+0.12,0.18,b.depth+0.12]} color={tint??(active?'#1677ff':'#dfe5ea')}/>
  <Box p={[0,top+0.19,0]} s={[b.width-0.3,0.04,b.depth-0.3]} color="#cdd5dc" cast={false}/>
  {b.kind!=='inpatient' && units.map(([x,z,s],i)=><Box key={i} p={[x,top+0.38,z]} s={[s,0.36,s*0.8]} color="#cfd6dc"/>)}
  {b.kind==='inpatient' && <group position={[b.width/4,top+0.22,0]}>
   <mesh rotation-x={-Math.PI/2}><circleGeometry args={[1.5,32]}/><meshStandardMaterial color="#4c5761"/></mesh>
   <mesh rotation-x={-Math.PI/2} position={[0,0.01,0]}><ringGeometry args={[1.2,1.32,40]}/><meshStandardMaterial color="#f5c542"/></mesh>
   <Box p={[-0.3,0.02,0]} s={[0.12,0.02,0.9]} color="#fff" cast={false}/><Box p={[0.3,0.02,0]} s={[0.12,0.02,0.9]} color="#fff" cast={false}/><Box p={[0,0.02,0]} s={[0.6,0.02,0.12]} color="#fff" cast={false}/>
  </group>}
  {b.kind==='support' && Array.from({length:8},(_,i)=><mesh key={i} position={[-b.width/2+1.2+(i%4)*1.5,top+0.4,(i<4?-1:0.6)]} rotation-x={-0.5} castShadow><boxGeometry args={[1.3,0.05,1.1]}/><meshStandardMaterial color="#26467a" metalness={0.5} roughness={0.3}/></mesh>)}
  {b.kind==='er' && <group position={[0,top+0.9,b.depth/2-0.6]}>
   <Box p={[0,0,0]} s={[1.3,1.3,0.2]} color="#e5383b"/>
   <Box p={[0,0,0.11]} s={[0.85,0.24,0.02]} color="#fff" cast={false}/><Box p={[0,0,0.11]} s={[0.24,0.85,0.02]} color="#fff" cast={false}/>
  </group>}
 </group>;
}

function ErExtras({b}:{b:BuildingSpec}) {
 const front = b.depth/2;
 return <group>
  {/* ER sign band and ambulance bay canopy facing the lane. */}
  <Box p={[-b.width/4,floorH*1.5,front+0.08]} s={[1.6,0.42,0.12]} color="#e5383b"/>
  <Box p={[-b.width/4,floorH*1.5,front+0.15]} s={[1.1,0.16,0.02]} color="#fff" cast={false}/>
  <Box p={[b.width/5,0.95,front+1]} s={[3.2,0.12,2]} color="#f4f6f8"/>
  {[[-1.4,0.2],[1.4,0.2],[-1.4,1.8],[1.4,1.8]].map(([x,z],i)=><Box key={i} p={[b.width/5+x,0.45,front+z]} s={[0.1,0.9,0.1]} color="#c3ccd3"/>)}
  <group position={[b.width/5,0,front+1.1]}>
   <Box p={[0,0.38,0]} s={[1.3,0.6,0.62]} color="#ffffff"/>
   <Box p={[0,0.42,0.32]} s={[1.3,0.1,0.02]} color="#e5383b" cast={false}/>
   <Box p={[0.5,0.72,0]} s={[0.12,0.06,0.3]} color="#2f8cff" emissive="#2f8cff" emissiveIntensity={1}/>
  </group>
 </group>;
}

type Zone = {x0:number;x1:number;z0:number;z1:number;dept:Department};
type Sign = {text:string;pos:V3;kind:SignKind;roomId?:string};
// Placed = a position plus the yaw it faces (0 = +z, toward the default camera).
type Placed = {p:V3;rot:number};
type Plan = {level:number;rooms:{id:string;x0:number;x1:number;z0:number;z1:number}[];walls:{p:V3;s:V3}[];chairs:V3[];beds:V3[];desks:V3[];counters:V3[];machines:V3[];plants:V3[];people:Person[];zones:Zone[];signs:Sign[];corridor:[number,number];y:number;
 monitors:Placed[];poles:V3[];bags:V3[];vitals:Placed[];screens:Placed[];wheelchairs:Placed[]};
// Back-wall room k of n, in building-local coordinates (rooms take the back 42% of the depth).
const roomRect = (b:BuildingSpec,k:number,n:number) => { const w = b.width/n, x0 = -b.width/2+k*w; return {x0,x1:x0+w,z0:-b.depth/2,z1:-b.depth/2+b.depth*0.42}; };
const counterName:Record<BuildingKind,string> = {opd:'จุดซักประวัติ',er:'จุดคัดแยก',diagnostics:'จุดรับบริการ',inpatient:'เคาน์เตอร์พยาบาล',support:'ธุรการ'};
// Procedural floor plan in building-local coordinates: rooms along the back wall, a corridor,
// then one open zone per department at the front. Furniture depends on the building type.
function planLayout(b:BuildingSpec,level:number):Plan {
 const depts = floorDepartments(b.id,level);
 const zoneDepts:Department[] = depts.length ? depts : [{name:'',queue:0,status:'normal',color:'#94a3b8'}];
 const count = peakFloorCount(b.id,level) || 20; // sized for the busiest hour; quieter hours hide some
 const r = seeded(level*97+Math.round(b.width*13+b.depth*7));
 const y = (level-1)*floorH+0.11, hw = b.width/2, hd = b.depth/2, wallH = 0.5, wy = y+wallH/2;
 const p:Plan = {level,rooms:[],walls:[],chairs:[],beds:[],desks:[],counters:[],machines:[],plants:[],people:[],zones:[],signs:[],corridor:[0,0],y,monitors:[],poles:[],bags:[],vitals:[],screens:[],wheelchairs:[]};
 const iv = (x:number,z:number) => { p.poles.push([x,y,z]); p.bags.push([x,y,z]); }; // drip stand with a saline bag
 const person = (x:number,z:number,mix:Mix=floorMix[b.kind]) => { p.people.push(makePerson(r,x,y,z,pickType(r,mix))); };
 const staffAt = (x:number,z:number,type:PersonType,dutyRoom?:string) => { p.people.push({...makePerson(r,x,y,z,type),presence:0,dutyRoom}); }; // on duty all day
 p.walls.push({p:[0,wy,-hd],s:[b.width,wallH,0.12]},{p:[0,y+0.15,hd],s:[b.width,0.3,0.12]},{p:[-hw,wy,0],s:[0.12,wallH,b.depth]},{p:[hw,wy,0],s:[0.12,wallH,b.depth]});
 const roomFront = -hd+b.depth*0.42, front0 = roomFront+1.2;
 p.corridor = [roomFront,front0];
 const rooms = floorRooms(b.id,level), n = rooms.length, roomW = b.width/n;
 for (let k=0; k<n; k++) {
  const x0 = -hw+k*roomW, cx = x0+roomW/2;
  if (k>0) p.walls.push({p:[x0,wy,(roomFront-hd)/2],s:[0.08,wallH,roomFront+hd]});
  p.walls.push({p:[x0+0.8+(roomW-0.8)/2,wy,roomFront],s:[roomW-0.8,wallH,0.08]});
  if (b.kind==='inpatient' || b.kind==='er') {
   if (b.kind==='er') p.beds.push([x0+roomW*0.3,y+0.11,-hd+0.9],[x0+roomW*0.72,y+0.11,-hd+0.9]); // ward beds come from wardBeds() below
   iv(x0+roomW*0.51,-hd+0.6);
   if (b.kind==='er') { staffAt(cx,roomFront-0.5,k%2?'doctor':'staff',k%2?rooms[k].id:undefined); p.poles.push([x0+roomW*0.72+0.4,y,-hd+0.6]); p.vitals.push({p:[x0+roomW*0.72+0.4,y,-hd+0.6],rot:0}); }
  }
  else if (rooms[k].kind==='scan') { p.machines.push([cx,y+0.42,-hd+0.8]); p.beds.push([cx,y+0.11,-hd+1.3]); staffAt(x0+0.35,roomFront-0.45,'staff'); }
  else if (rooms[k].kind==='office') { p.desks.push([x0+roomW*0.3,y+0.15,-hd+1],[x0+roomW*0.7,y+0.15,-hd+1]); p.chairs.push([x0+roomW*0.3,y+0.07,-hd+1.45],[x0+roomW*0.7,y+0.07,-hd+1.45]); p.monitors.push({p:[x0+roomW*0.3,y+0.3,-hd+0.92],rot:0},{p:[x0+roomW*0.7,y+0.3,-hd+0.92],rot:0}); }
  else {
   p.beds.push([x0+roomW*0.68,y+0.11,-hd+1]); p.desks.push([x0+roomW*0.3,y+0.15,roomFront-0.6]); p.chairs.push([x0+roomW*0.3,y+0.07,roomFront-1.05]); staffAt(x0+roomW*0.3,roomFront-1.05,'doctor',rooms[k].id);
   p.monitors.push({p:[x0+roomW*0.3+0.15,y+0.3,roomFront-0.62],rot:Math.PI}); iv(x0+roomW*0.68+0.42,-hd+0.6);
  }
  p.signs.push({text:rooms[k].name,pos:[cx,y+0.62,(roomFront-hd)/2],kind:'room',roomId:rooms[k].id});
  p.rooms.push({id:rooms[k].id,...roomRect(b,k,n)});
  if (r()<0.75) person(x0+0.4+r()*(roomW-0.8),-hd+0.6+r()*(roomFront+hd-1),b.kind==='support'||rooms[k].kind==='scan'||rooms[k].kind==='office'?floorMix.support:{...floorMix[b.kind],staff:1,doctor:0}); // no relatives in imaging / lab rooms
 }
 const bandW = b.width/zoneDepts.length, bandIds = floorBands(b.id,level);
 zoneDepts.forEach((dept,i)=>{
  // What the facility puts in this band: booths (blood draw) or beds out in the open (resuscitation bays).
  const booths = bandIds[i] ? bandBooths(b.id,level,bandIds[i].deptId) : [], openBeds = bandIds[i] ? bandBeds(b.id,level,bandIds[i].deptId) : [];
  const bx0 = -hw+i*bandW, bx1 = bx0+bandW;
  p.zones.push({x0:bx0,x1:bx1,z0:-hd,z1:hd,dept});
  if (i>0) p.walls.push({p:[bx0,wy,(front0+0.9+hd)/2],s:[0.08,wallH,hd-front0-0.9]});
  if (b.kind==='inpatient') {
   p.counters.push([(bx0+bx1)/2,y+0.16,front0+0.45]);
   p.monitors.push({p:[(bx0+bx1)/2-0.4,y+0.36,front0+0.42],rot:Math.PI});
   p.signs.push({text:counterName[b.kind],pos:[(bx0+bx1)/2,y+0.5,front0+0.45],kind:'counter'},{text:'เตียงรวม',pos:[bx0+bandW*0.78,y+0.45,hd-0.8],kind:'area'});
  } else if (b.kind==='support') {
   for (let x=bx0+0.7; x<bx1-0.5; x+=1.1) for (let z=front0+0.6; z<hd-0.4; z+=1) { p.desks.push([x,y+0.15,z]); p.chairs.push([x,y+0.07,z+0.42]); p.monitors.push({p:[x,y+0.3,z-0.08],rot:0}); }
   p.signs.push({text:'พื้นที่ทำงาน',pos:[(bx0+bx1)/2,y+0.5,(front0+hd)/2],kind:'area'});
  } else if (booths.length) {
   // Booths (blood draw): a desk, a chair and a computer per booth; waiting chairs behind.
   booths.forEach(st=>{ const x = st.spot.x-b.x, z = st.spot.z-b.z;
    p.desks.push([x,y+0.15,z-0.45]); p.chairs.push([x,y+0.07,z]); p.monitors.push({p:[x+0.22,y+0.3,z-0.5],rot:0}); staffAt(x,z-0.85,'staff');
    p.signs.push({text:st.name,pos:[x,y+0.62,z-0.45],kind:'counter'}); });
   for (let z=front0+2; z<hd-0.3; z+=0.68) for (let x=bx0+0.45; x<bx1-0.3; x+=0.46) p.chairs.push([x,y+0.07,z]);
  } else {
   p.counters.push([bx0+0.95,y+0.16,front0+0.45]);
   p.monitors.push({p:[bx0+0.6,y+0.36,front0+0.42],rot:Math.PI});
   p.poles.push([bx1-0.35,y,front0+0.75]); p.screens.push({p:[bx1-0.35,y,front0+0.75],rot:0});
   // Beds out in the band (the ER's resuscitation bays) instead of waiting chairs.
   const resus = openBeds.length>0;
   if (resus) openBeds.forEach(r=>{ p.beds.push([r.spot.x-b.x,y+0.11,r.spot.z-b.z]); p.vitals.push({p:[r.spot.x-b.x+0.42,y,r.spot.z-b.z-0.35],rot:0}); p.poles.push([r.spot.x-b.x+0.42,y,r.spot.z-b.z-0.35]); });
   else for (let z=front0+1.2; z<hd-0.3; z+=0.68) for (let x=bx0+0.45; x<bx1-0.3; x+=0.46) p.chairs.push([x,y+0.07,z]);
   p.signs.push({text:counterName[b.kind],pos:[bx0+0.95,y+0.5,front0+0.45],kind:'counter'},{text:resus?openBeds[0].name:'พื้นที่รอ',pos:[(bx0+bx1)/2+0.4,y+0.45,(front0+1.2+hd)/2],kind:'area'});
  }
 });
 const crowd = Math.min(30,Math.max(4,Math.round(count/14))); // relatives and staff only; patients are tracked
 for (let i=0; i<crowd; i++) {
  if (r()<0.25) person(-hw+0.4+r()*(b.width-0.8),roomFront+0.2+r()*0.8);
  else person(-hw+0.4+r()*(b.width-0.8),front0+0.3+r()*(hd-front0-0.6));
 }
 p.plants.push([-hw+0.35,y+0.24,hd-0.35],[hw-0.35,y+0.24,front0+0.3]);
 // Ward beds sit exactly where the bed board and the patients' positions put them.
 if (b.kind==='inpatient') wardBeds().filter(w=>w.level===level).forEach((w,i)=>{
  p.beds.push([w.spot.x-b.x,y+0.11,w.spot.z-b.z]);
  if (w.bed.includes('W') && i%2===0) iv(w.spot.x-b.x+0.42,w.spot.z-b.z-0.35);
 });
 if (b.kind!=='support') p.wheelchairs.push({p:[hw-0.45,y,(roomFront+front0)/2],rot:-Math.PI/2});
 return p;
}

// Offset (dx,dy,dz) in an item's own frame, rotated by its yaw.
const loc = (p:V3,rot:number,dx:number,dy:number,dz:number):V3 => [p[0]+dx*Math.cos(rot)+dz*Math.sin(rot),p[1]+dy,p[2]-dx*Math.sin(rot)+dz*Math.cos(rot)];
function PartSet({items,at,turn=0,children}:{items:Placed[];at:V3;turn?:number;children:ReactNode}) {
 if (!items.length) return null;
 return <Instances key={items.length} limit={items.length}>{children}{items.map((it,i)=><Instance key={i} position={loc(it.p,it.rot,...at)} rotation={[0,it.rot+turn,0]}/>)}</Instances>;
}
const still = (ps:V3[]):Placed[] => ps.map(p=>({p,rot:0}));
// Hospital equipment, kept sparse: computers, drip stands, vital-sign monitors, queue displays, wheelchairs.
function Equipment({L}:{L:Plan}) {
 const poles = still(L.poles), bags = still(L.bags);
 const screenFace = <meshStandardMaterial color="#9fd8ff" emissive="#5ab8ff" emissiveIntensity={0.9}/>;
 return <group>
  {/* Computer: foot, stand, screen, glowing face, keyboard toward the user. */}
  <PartSet items={L.monitors} at={[0,0.006,0]}><boxGeometry args={[0.14,0.012,0.09]}/><meshStandardMaterial color="#374151"/></PartSet>
  <PartSet items={L.monitors} at={[0,0.06,0]}><boxGeometry args={[0.04,0.1,0.04]}/><meshStandardMaterial color="#374151"/></PartSet>
  <PartSet items={L.monitors} at={[0,0.2,0]}><boxGeometry args={[0.34,0.21,0.03]}/><meshStandardMaterial color="#1f2937"/></PartSet>
  <PartSet items={L.monitors} at={[0,0.2,0.017]}><boxGeometry args={[0.31,0.18,0.006]}/>{screenFace}</PartSet>
  <PartSet items={L.monitors} at={[0,0.006,0.14]}><boxGeometry args={[0.26,0.012,0.08]}/><meshStandardMaterial color="#d1d5db"/></PartSet>
  {/* Drip / monitor stands, saline bags. */}
  <PartSet items={poles} at={[0,0.01,0]}><cylinderGeometry args={[0.09,0.09,0.02,12]}/><meshStandardMaterial color="#9ca3af" metalness={0.4}/></PartSet>
  <PartSet items={poles} at={[0,0.435,0]}><cylinderGeometry args={[0.01,0.01,0.85,6]}/><meshStandardMaterial color="#cbd5e1" metalness={0.5}/></PartSet>
  <PartSet items={bags} at={[0,0.85,0]}><boxGeometry args={[0.14,0.01,0.01]}/><meshStandardMaterial color="#cbd5e1"/></PartSet>
  <PartSet items={bags} at={[0.055,0.76,0]}><boxGeometry args={[0.07,0.12,0.025]}/><meshStandardMaterial color="#dbeeff" transparent opacity={0.85}/></PartSet>
  {/* Vital-signs monitor on its stand. */}
  <PartSet items={L.vitals} at={[0,0.64,0]}><boxGeometry args={[0.22,0.16,0.05]}/><meshStandardMaterial color="#1f2937"/></PartSet>
  <PartSet items={L.vitals} at={[0,0.64,0.027]}><boxGeometry args={[0.19,0.13,0.006]}/><meshStandardMaterial color="#6ee7b7" emissive="#10b981" emissiveIntensity={0.9}/></PartSet>
  {/* Queue display facing the waiting chairs. */}
  <PartSet items={L.screens} at={[0,0.8,0]}><boxGeometry args={[0.52,0.3,0.03]}/><meshStandardMaterial color="#111827"/></PartSet>
  <PartSet items={L.screens} at={[0,0.8,0.017]}><boxGeometry args={[0.48,0.26,0.006]}/>{screenFace}</PartSet>
  {/* Wheelchair: seat, back, two wheels. */}
  <PartSet items={L.wheelchairs} at={[0,0.17,0]}><boxGeometry args={[0.22,0.03,0.2]}/><meshStandardMaterial color="#2563eb"/></PartSet>
  <PartSet items={L.wheelchairs} at={[0,0.28,-0.1]}><boxGeometry args={[0.22,0.2,0.025]}/><meshStandardMaterial color="#2563eb"/></PartSet>
  <PartSet items={L.wheelchairs} at={[-0.13,0.11,0]} turn={Math.PI/2}><torusGeometry args={[0.1,0.014,6,18]}/><meshStandardMaterial color="#4b5563"/></PartSet>
  <PartSet items={L.wheelchairs} at={[0.13,0.11,0]} turn={Math.PI/2}><torusGeometry args={[0.1,0.014,6,18]}/><meshStandardMaterial color="#4b5563"/></PartSet>
 </group>;
}

function BoxSet({items,size,color,offset=[0,0,0],cast=true}:{items:V3[];size:V3;color:string;offset?:V3;cast?:boolean}) {
 if (!items.length) return null;
 return <Instances key={items.length} limit={items.length} castShadow={cast} receiveShadow><boxGeometry args={size}/><meshStandardMaterial color={color}/>
  {items.map((p,i)=><Instance key={i} position={[p[0]+offset[0],p[1]+offset[1],p[2]+offset[2]]}/>)}
 </Instances>;
}

// People are assembled from instanced parts (legs, torso, arms, head, hair, …). Every figure owns a fixed
// slot in each part mesh; parts it doesn't have (skirt, cane, cap…) get a zero-scale matrix.
// Uniforms: nurses (staff) get a white cap with a coloured band plus a waist band; doctors a scrub cap.
const nurseAccent = personTypes.find(t=>t.id==='staff')!.accent;
const doctorCap = '#226b46';
type Part = 'leg'|'torso'|'arm'|'head'|'hair'|'hairBack'|'dress'|'cane'|'cap'|'band'|'belt';
const partGeo:Record<Part,THREE.BufferGeometry> = {
 leg:new THREE.CapsuleGeometry(0.03,0.12,3,8),
 torso:new THREE.CapsuleGeometry(0.062,0.1,4,10),
 arm:new THREE.CapsuleGeometry(0.022,0.12,3,6),
 head:new THREE.SphereGeometry(0.056,12,10),
 hair:new THREE.SphereGeometry(0.061,12,8,0,Math.PI*2,0,Math.PI/2),
 hairBack:new THREE.CapsuleGeometry(0.045,0.07,3,8),
 dress:new THREE.CylinderGeometry(0.058,0.095,0.17,12),
 cane:new THREE.CylinderGeometry(0.008,0.008,0.26,6),
 cap:new THREE.CylinderGeometry(0.06,0.068,0.05,12),
 band:new THREE.CylinderGeometry(0.07,0.07,0.016,12),
 belt:new THREE.CylinderGeometry(0.068,0.068,0.03,12),
};
const PARTS = Object.keys(partGeo) as Part[];
const perFigure = (part:Part) => part==='leg'||part==='arm' ? 2 : 1;
const HIP = 0.19, SHOULDER = 0.35;
type PartMeshes = Partial<Record<Part,THREE.InstancedMesh|null>>;
const ZERO = new THREE.Matrix4().makeScale(0,0,0), UP = new THREE.Vector3(0,1,0);
const _base = new THREE.Matrix4(), _upper = new THREE.Matrix4(), _head = new THREE.Matrix4(), _m = new THREE.Matrix4();
const _t = new THREE.Matrix4(), _rx = new THREE.Matrix4(), _rz = new THREE.Matrix4(), _sc = new THREE.Matrix4();
const _qx = new THREE.Quaternion(), X_AXIS = new THREE.Vector3(1,0,0);
const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
const tr = (x:number,y:number,z:number) => _t.makeTranslation(x,y,z);
const rx = (a:number) => _rx.makeRotationX(a), rz = (a:number) => _rz.makeRotationZ(a);

function setPart(mesh:PartMeshes,part:Part,i:number,slot:number,m:THREE.Matrix4|null) { mesh[part]?.setMatrixAt(i*perFigure(part)+slot,m??ZERO); }
function hideFigure(mesh:PartMeshes,i:number) { PARTS.forEach(part=>{ for (let k=0;k<perFigure(part);k++) setPart(mesh,part,i,k,null); }); }
function colorFigure(mesh:PartMeshes,i:number,f:Person) {
 const col = (part:Part,hex:string) => { for (let k=0;k<perFigure(part);k++) mesh[part]?.setColorAt(i*perFigure(part)+k,_c.set(hex)); };
 const shirt = personColor[f.type];
 col('leg',f.dress?(f.type==='staff'?'#ffffff':f.skin):f.pants); col('torso',shirt); col('arm',shirt); col('dress',shirt);
 col('head',f.skin); col('hair',f.hair); col('hairBack',f.hair); col('cane','#6b4f3a');
 col('cap',f.type==='doctor'?doctorCap:'#ffffff'); col('band',nurseAccent); col('belt',nurseAccent);
}
// swing: leg/arm swing angle for walking (0 when standing).
function writeFigure(mesh:PartMeshes,i:number,f:Person,x:number,y:number,z:number,yaw:number,swing:number) {
 const scale = f.age==='child'?0.62:f.age==='elderly'?0.94:f.female?0.95:1;
 // Lying (in bed): feet toward the foot end, head on the pillow (+z), body resting on the mattress.
 if (f.lying) _base.compose(_p.set(x,y+0.29,z-0.3),_q.setFromAxisAngle(UP,yaw).multiply(_qx.setFromAxisAngle(X_AXIS,Math.PI/2)),_s.setScalar(scale));
 else _base.compose(_p.set(x,y,z),_q.setFromAxisAngle(UP,yaw),_s.setScalar(scale));
 // Elderly bend forward from the hips (not while lying down).
 _upper.copy(_base).multiply(tr(0,HIP,0)).multiply(rx(f.age==='elderly'&&!f.lying?0.38:0)).multiply(tr(0,-HIP,0));
 [-1,1].forEach((side,k)=>{
  setPart(mesh,'leg',i,k,_m.copy(_base).multiply(tr(side*0.032,HIP,0)).multiply(rx(swing*side)).multiply(tr(0,0.1-HIP,0)));
  setPart(mesh,'arm',i,k,_m.copy(_upper).multiply(tr(side*0.083,SHOULDER,0)).multiply(rx(-swing*side*0.8)).multiply(rz(side*0.12)).multiply(tr(0,-0.075,0)));
 });
 _m.copy(_upper).multiply(tr(0,0.29,0));
 if (f.female) _m.multiply(_sc.makeScale(0.9,1,0.9));
 setPart(mesh,'torso',i,0,_m);
 _head.copy(_upper).multiply(tr(0,0.455,0));
 if (f.age==='child') _head.multiply(_sc.makeScale(1.25,1.25,1.25)); // children's heads are large for their size
 setPart(mesh,'head',i,0,_head);
 setPart(mesh,'hair',i,0,_m.copy(_head).multiply(tr(0,0.004,0)));
 setPart(mesh,'hairBack',i,0,f.longHair?_m.copy(_head).multiply(tr(0,-0.045,-0.034)):null);
 setPart(mesh,'dress',i,0,f.dress?_m.copy(_base).multiply(tr(0,0.14,0)):null);
 setPart(mesh,'cane',i,0,f.cane&&!f.lying?_m.copy(_base).multiply(tr(0.1,0.13,0.08)).multiply(rx(0.15)):null);
 const uniformed = f.type==='staff' || f.type==='doctor';
 setPart(mesh,'cap',i,0,uniformed?_m.copy(_head).multiply(tr(0,f.type==='staff'?0.042:0.036,0)):null);
 setPart(mesh,'band',i,0,f.type==='staff'?_m.copy(_head).multiply(tr(0,0.024,0)):null);
 setPart(mesh,'belt',i,0,f.type==='staff'?_m.copy(_upper).multiply(tr(0,0.225,0)):null);
}

export type PickedPerson = {type:PersonType;dutyRoom?:string};
type Walk = {curve:THREE.Curve<THREE.Vector3>;offset:number;side:number;flowId:string};
// walks[i] set → person i walks that route (animated); otherwise it stands still at its x/y/z.
// fraction: per person (or one value for all) — a person shows only while presence < fraction.
// onPick: makes figures clickable, reporting the person's index.
function Figures({people,hidden,walks,highlight=null,fraction=1,onDuty,onPick}:{people:Person[];hidden:PersonType[];walks?:(Walk|null)[];highlight?:string|null;fraction?:number|number[];onDuty?:Set<string>;onPick?:(i:number)=>void}) {
 // Live data mode: no simulated crowd — only staff on duty stay (real patients are drawn as patients).
 const shown = (f:Person,i:number) => !hidden.includes(f.type) && (isRealMode() ? f.type==='staff' && !!f.dutyRoom && !!onDuty?.has(f.dutyRoom)
  : f.presence<(typeof fraction==='number'?fraction:fraction[i]??1) && (!f.dutyRoom || !!onDuty?.has(f.dutyRoom)));
 const mesh = useRef<PartMeshes>({});
 const tangent = useMemo(()=>new THREE.Vector3(),[]);
 // three.js caches an InstancedMesh's bounding sphere on its first raycast and rejects clicks outside it,
 // so clickable figures recompute it whenever they move.
 const flush = (colors:boolean) => PARTS.forEach(part=>{
  const m = mesh.current[part]; if (!m) return;
  m.instanceMatrix.needsUpdate = true;
  if (colors && m.instanceColor) m.instanceColor.needsUpdate = true;
  if (onPick) m.computeBoundingSphere();
 });
 useLayoutEffect(()=>{
  people.forEach((f,i)=>{
   colorFigure(mesh.current,i,f);
   if (walks?.[i]) return;
   if (!shown(f,i)) hideFigure(mesh.current,i); else writeFigure(mesh.current,i,f,f.x,f.y,f.z,f.yaw,0);
  });
  flush(true);
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[people,hidden,walks,fraction,onDuty]);
 useFrame(({clock})=>{
  if (!walks) return;
  const t = clock.getElapsedTime();
  walks.forEach((w,i)=>{
   if (!w) return;
   const f = people[i];
   // Walkers on faded routes or of a hidden type disappear.
   if (!shown(f,i) || !flowOn(w.flowId,highlight)) { hideFigure(mesh.current,i); return; }
   const old = f.age==='elderly', speed = old?0.5:f.age==='child'?1:0.8, len = w.curve.getLength();
   const u = (w.offset+t*speed/len)%1, p = w.curve.getPointAt(u);
   w.curve.getTangentAt(u,tangent);
   writeFigure(mesh.current,i,f,p.x-tangent.z*w.side,0,p.z+tangent.x*w.side,Math.atan2(tangent.x,tangent.z),Math.sin(t*(old?5:9)+i)*(old?0.25:0.45));
  });
  flush(false);
 });
 if (!people.length) return null;
 return <group>{PARTS.map(part=><instancedMesh key={part} ref={el=>{mesh.current[part]=el;}} args={[partGeo[part],undefined,people.length*perFigure(part)]} castShadow frustumCulled={false}
  onClick={onPick ? (e:ThreeEvent<MouseEvent>)=>{ if (e.instanceId===undefined) return; e.stopPropagation(); onPick(Math.floor(e.instanceId/perFigure(part))); } : undefined}>
  {/* A faint white emissive lifts the shaded side so small figures stay bright and readable. */}
  <meshStandardMaterial roughness={0.75} emissive="#ffffff" emissiveIntensity={0.1}/>
 </instancedMesh>)}</group>;
}

// One storey shown as a roofless cut-away; `tint` colours each zone by department or by density.
type ZoneTint = 'none'|'dept'|'density';
function FloorPlan({b,level,tint,hidden,hour,selectedRoom,selectedDept,onPickPerson}:{b:BuildingSpec;level:number;tint:ZoneTint;hidden:PersonType[];hour:number;selectedRoom?:string|null;selectedDept?:string|null;onPickPerson?:(p:PickedPerson)=>void}) {
 const rev = layoutRevision(), L = useMemo(()=>planLayout(b,level),[b,level,rev]);
 const depts = floorDepartments(b.id,level,hour);
 const dutyKey = floorDutyAt(b.id,level,hour).filter(d=>d.status==='active').map(d=>d.room.id).join(',');
 const onDuty = useMemo(()=>new Set(dutyKey.split(',')),[dutyKey]);
 const y = L.y, [c0,c1] = L.corridor;
 return <group>
  <Box p={[0,y-0.06,0]} s={[b.width,0.1,b.depth]} color="#dde3e8"/>
  <Box p={[0,y-0.005,0]} s={[b.width-0.2,0.01,b.depth-0.2]} color="#f2eee6" cast={false}/>
  <Box p={[0,y,(c0+c1)/2]} s={[b.width-0.3,0.01,c1-c0]} color="#d9e6f2" cast={false}/>
  {tint!=='none' && L.zones.map((z,i)=><mesh key={i} rotation-x={-Math.PI/2} position={[(z.x0+z.x1)/2,y+0.012,(z.z0+z.z1)/2]}>
   <planeGeometry args={[z.x1-z.x0-0.16,z.z1-z.z0-0.16]}/><meshBasicMaterial color={tint==='density'?densityColor(depts[i]?.queue??0):z.dept.color} transparent opacity={tint==='density'?0.45:0.32} depthWrite={false}/>
  </mesh>)}
  <Instances limit={L.walls.length} castShadow receiveShadow><boxGeometry/><meshStandardMaterial color="#f8f9fa"/>
   {L.walls.map((w,i)=><Instance key={i} position={w.p} scale={w.s}/>)}
  </Instances>
  <BoxSet items={L.chairs} size={[0.34,0.14,0.32]} color="#2c7be0"/>
  <BoxSet items={L.chairs} size={[0.34,0.24,0.06]} color="#1f63c0" offset={[0,0.15,0.14]} cast={false}/>
  <BoxSet items={L.beds} size={[0.6,0.22,1.1]} color="#ffffff"/>
  <BoxSet items={L.beds} size={[0.5,0.04,0.55]} color="#8fc3ee" offset={[0,0.13,0.2]} cast={false}/>
  <BoxSet items={L.desks} size={[0.8,0.3,0.42]} color="#d3b48a"/>
  <BoxSet items={L.counters} size={[1.5,0.32,0.4]} color="#ffffff"/>
  <BoxSet items={L.counters} size={[1.52,0.04,0.42]} color="#2f8cff" offset={[0,0.18,0]} cast={false}/>
  {L.machines.length>0 && <Instances limit={L.machines.length} castShadow><torusGeometry args={[0.34,0.12,10,20]}/><meshStandardMaterial color="#eef2f6"/>
   {L.machines.map((m,i)=><Instance key={i} position={m}/>)}
  </Instances>}
  <Instances limit={L.plants.length} castShadow><icosahedronGeometry args={[0.22,1]}/><meshStandardMaterial color="#3f9a4f" flatShading/>
   {L.plants.map((m,i)=><Instance key={i} position={m}/>)}
  </Instances>
  <ClosedAreas L={L} rev={rev}/>
  <RoomHighlight rect={L.rooms.find(r=>r.id===selectedRoom)} y={L.y}/>
  {/* Department found from the search: its whole band (rooms at the back and its waiting area). */}
  {!selectedRoom && <RoomHighlight rect={(()=>{ const z = L.zones.find(x=>x.dept.name && x.dept.name===selectedDept); return z && {x0:z.x0,x1:z.x1,z0:z.z0,z1:z.z1}; })()} y={L.y}/>}
  <Equipment L={L}/>
  <Figures people={L.people} hidden={hidden} fraction={floorPresence(b.id,level,hour)} onDuty={onDuty} onPick={onPickPerson?i=>onPickPerson({type:L.people[i].type,dutyRoom:L.people[i].dutyRoom}):undefined}/>
 </group>;
}

function DensityBand({w,d,color}:{w:number;d:number;color:string}) {
 const gap = 0.35, band = 0.32, ow = w/2+gap+band/2, od = d/2+gap+band/2;
 const strips:[V3,[number,number]][] = [[[0,0,od],[w+2*(gap+band),band]],[[0,0,-od],[w+2*(gap+band),band]],[[ow,0,0],[band,d+2*gap]],[[-ow,0,0],[band,d+2*gap]]];
 return <group position={[0,0.04,0]}>{strips.map(([p,[sx,sz]],i)=><mesh key={i} position={p} rotation-x={-Math.PI/2}>
  <planeGeometry args={[sx,sz]}/><meshBasicMaterial color={color} transparent opacity={0.9} depthWrite={false}/>
 </mesh>)}</group>;
}

// Departments, exam rooms switched off in Settings: a grey floor, so the plan shows what is not in use today.
function ClosedAreas({L,rev}:{L:Plan;rev:number}) {
 const rects = useMemo(()=>[...L.zones.filter(z=>z.dept.name && isOff(`dept:${z.dept.name}`)).map(z=>({x0:z.x0,x1:z.x1,z0:L.corridor[1],z1:z.z1})),
  ...L.rooms.filter(r=>isOff(`room:${r.id}`) || isOff(`dept:${findRoom(r.id)?.dept}`))],[L,rev]); // eslint-disable-line react-hooks/exhaustive-deps
 return <>{rects.map((r,i)=><mesh key={i} rotation-x={-Math.PI/2} position={[(r.x0+r.x1)/2,L.y+0.016,(r.z0+r.z1)/2]}>
  <planeGeometry args={[r.x1-r.x0-0.14,r.z1-r.z0-0.14]}/><meshBasicMaterial color="#64748b" transparent opacity={0.38} depthWrite={false}/></mesh>)}</>;
}
// Selected room: a tinted floor and a raised blue outline.
function RoomHighlight({rect,y}:{rect?:{x0:number;x1:number;z0:number;z1:number};y:number}) {
 if (!rect) return null;
 const {x0,x1,z0,z1} = rect, cx = (x0+x1)/2, cz = (z0+z1)/2, w = x1-x0, d = z1-z0, t = 0.06, h = 0.62;
 return <group>
  <mesh rotation-x={-Math.PI/2} position={[cx,y+0.014,cz]}><planeGeometry args={[w-0.1,d-0.1]}/><meshBasicMaterial color="#1677ff" transparent opacity={0.22} depthWrite={false}/></mesh>
  {([[cx,z0,w,t],[cx,z1,w,t],[x0,cz,t,d],[x1,cz,t,d]] as [number,number,number,number][]).map(([x,z,sx,sz],i)=><mesh key={i} position={[x,y+h,z]}><boxGeometry args={[sx,0.05,sz]}/><meshBasicMaterial color="#1677ff"/></mesh>)}
 </group>;
}

// campus: normal look (OPD shows its top floor cut away); heat: floors tinted by occupancy;
// floor/department: storeys above `level` removed; ghost: translucent context block.
type BuildingMode = 'campus'|'heat'|'floor'|'department'|'ghost';
function Building({b,mode,level,active,onSelect,hidden,showDensity,hour,selectedRoom,selectedDept,onPickPerson}:{b:BuildingSpec;mode:BuildingMode;level:number;active:boolean;onSelect:(id:string)=>void;hidden:PersonType[];showDensity:boolean;hour:number;selectedRoom?:string|null;selectedDept?:string|null;onPickPerson?:(p:PickedPerson)=>void}) {
 const h = b.floors*floorH;
 const edges = useMemo(()=>new THREE.EdgesGeometry(new THREE.BoxGeometry(b.width,h,b.depth)),[b,h]);
 const handlers = {
  onClick:(e:ThreeEvent<MouseEvent>)=>{e.stopPropagation();onSelect(b.id);},
  onPointerOver:(e:ThreeEvent<PointerEvent>)=>{e.stopPropagation();document.body.style.cursor='pointer';},
  onPointerOut:()=>{document.body.style.cursor='';},
 };
 if (mode==='ghost') return <group position={[b.x,0,b.z]} {...handlers}>
  <mesh position={[0,h/2,0]}><boxGeometry args={[b.width,h,b.depth]}/><meshStandardMaterial color="#e3e9ee" transparent opacity={0.42} depthWrite={false}/></mesh>
  <lineSegments geometry={edges} position={[0,h/2,0]}><lineBasicMaterial color="#8fa2b3"/></lineSegments>
 </group>;
 const stats = buildingStats[b.id];
 const cutLevel = mode==='campus' ? (b.kind==='opd'?b.floors:0) : mode==='heat' ? 0 : level;
 const campusDensity = mode==='campus' && showDensity ? densityColor(buildingDensityAt(b.id,hour)) : undefined;
 const tints = mode==='heat' ? Array.from({length:b.floors},(_,i)=>densityColor(floorCountAt(b.id,i+1,hour))) : undefined;
 return <group position={[b.x,0,b.z]} {...handlers}>
  {/* Campus density (average people per floor): a slim band around the base plus the roof rim. */}
  {campusDensity && <DensityBand w={b.width} d={b.depth} color={campusDensity}/>}
  {/* Kept below the ground-floor slab (top at 0.1) so a level-1 cut-away isn't covered by it. */}
  <Box p={[0,0.04,0]} s={[b.width+0.5,0.08,b.depth+0.5]} color={active?'#1677ff':'#c9d1d8'}/>
  <ClosedFloors b={b} from={0} to={cutLevel?cutLevel-1:b.floors} tints={tints}/>
  {cutLevel ? <FloorPlan key={cutLevel} b={b} level={cutLevel} tint={showDensity?'density':mode==='department'?'dept':'none'} hidden={hidden} hour={hour} selectedRoom={selectedRoom} selectedDept={selectedDept} onPickPerson={onPickPerson}/> : <Roof b={b} active={active} tint={campusDensity}/>}
  {b.kind==='er' && !cutLevel && <ErExtras b={b}/>}
 </group>;
}

function Entrance() {
 const entrance = entranceSpot();
 return <group position={[entrance.x,0,entrance.z]}>
  <Box p={[0,1.15,0]} s={[5,0.14,2.4]} color="#f5f7f9"/>
  <Box p={[0,1.24,0]} s={[5,0.05,0.3]} color="#2f8cff" cast={false}/>
  {[[-2.3,-1],[2.3,-1],[-2.3,1],[2.3,1]].map(([x,z],i)=><Box key={i} p={[x,0.57,z]} s={[0.12,1.14,0.12]} color="#c4cdd4"/>)}
  {/* Blue shade tent on the drop-off plaza. */}
  <group position={[-1.2,0,5.6]}>
   <mesh position={[0,1.05,0]} castShadow><coneGeometry args={[1.6,0.7,8]}/><meshStandardMaterial color="#2f7fd8"/></mesh>
   <Box p={[0,0.35,0]} s={[0.1,0.7,0.1]} color="#c4cdd4"/>
  </group>
 </group>;
}

type FlowCurve = {id:string;color:string;curve:THREE.CurvePath<THREE.Vector3>};
// Polyline with each corner replaced by a quadratic curve, so routes bend smoothly like the design.
function roundedPath(points:readonly (readonly [number,number])[],radius=1.6) {
 const v = points.map(([x,z])=>new THREE.Vector3(x,0,z)), path = new THREE.CurvePath<THREE.Vector3>();
 let start = v[0];
 for (let i=1; i<v.length-1; i++) {
  const r = Math.min(radius,v[i].distanceTo(v[i-1])/2,v[i].distanceTo(v[i+1])/2);
  const a = v[i].clone().add(v[i-1].clone().sub(v[i]).setLength(r)), b = v[i].clone().add(v[i+1].clone().sub(v[i]).setLength(r));
  path.add(new THREE.LineCurve3(start,a)); path.add(new THREE.QuadraticBezierCurve3(a,v[i],b));
  start = b;
 }
 path.add(new THREE.LineCurve3(start,v[v.length-1]));
 return path;
}
function ribbonGeometry(curve:THREE.Curve<THREE.Vector3>,width:number) {
 const pts = curve.getSpacedPoints(Math.ceil(curve.getLength()*4)), pos:number[] = [], idx:number[] = [];
 pts.forEach((p,i)=>{
  const a = pts[Math.max(0,i-1)], b = pts[Math.min(pts.length-1,i+1)];
  const l = Math.hypot(b.x-a.x,b.z-a.z)||1, nx = -(b.z-a.z)/l*width/2, nz = (b.x-a.x)/l*width/2;
  pos.push(p.x+nx,0,p.z+nz,p.x-nx,0,p.z-nz);
  if (i>0) { const k = i*2; idx.push(k-2,k,k-1,k-1,k,k+1); }
 });
 const g = new THREE.BufferGeometry();
 g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3)); g.setIndex(idx); g.computeVertexNormals();
 return g;
}
function useFlowCurves():FlowCurve[] {
 return useMemo(()=>demoFlows.map(f=>({id:f.id,color:f.color,curve:roundedPath(f.points)})),[]);
}

// A highlighted route stays solid and lifts above the others; the rest fade out.
const flowOn = (id:string,highlight:string|null) => !highlight || highlight===id;
function FlowPaths({flows,highlight}:{flows:FlowCurve[];highlight:string|null}) {
 const geometries = useMemo(()=>flows.map(f=>ribbonGeometry(f.curve,0.4)),[flows]);
 return <group>
  {flows.map((f,fi)=>{const on = flowOn(f.id,highlight);return <mesh key={f.id} geometry={geometries[fi]} position={[0,(highlight===f.id?0.09:0.06)+fi*0.004,0]}>
   <meshStandardMaterial color={f.color} emissive={f.color} emissiveIntensity={on?0.3:0} transparent opacity={on?1:0.2} depthWrite={on} side={THREE.DoubleSide}/>
  </mesh>;})}
  <FlowPulses flows={flows} highlight={highlight}/>
 </group>;
}

function FlowPulses({flows,highlight}:{flows:FlowCurve[];highlight:string|null}) {
 const refs = useRef<(THREE.Mesh|null)[]>([]);
 useFrame(({clock})=>flows.forEach((f,i)=>{
  const m = refs.current[i]; if (!m) return;
  m.visible = flowOn(f.id,highlight);
  const p = f.curve.getPointAt((clock.getElapsedTime()*4/f.curve.getLength()+i*0.3)%1);
  m.position.set(p.x,0.14,p.z);
 }));
 return <>{flows.map((f,i)=><mesh key={f.id} ref={el=>{refs.current[i]=el;}}><sphereGeometry args={[0.16,16,12]}/><meshStandardMaterial color={f.color} emissive={f.color} emissiveIntensity={1.6}/></mesh>)}</>;
}

function usePeople():Person[] {
 return useMemo(()=>{
  const r = seeded(3), out:Person[] = [];
  const scatter = (n:number,[x0,z0,x1,z1]:Rect,mix:Mix=outdoorMix) => { for (let i=0;i<Math.ceil(n/2);i++) out.push(makePerson(r,x0+r()*(x1-x0),0,z0+r()*(z1-z0),pickType(r,mix))); };
  const entrance = entranceSpot(), reg = buildings.find(b=>Math.abs(b.x-b.width/4-entrance.x)<0.01 && Math.abs(b.z+b.depth/2+0.9-entrance.z)<0.01), plaza = facility().site.plazas?.[0], lot = parkingLots[0];
  scatter(26,[entrance.x-4,entrance.z-0.9,entrance.x+3,entrance.z+1]);
  if (plaza) scatter(18,[plaza[0]+0.2,plaza[1]+0.2,plaza[2]-0.3,plaza[3]-0.2]);
  buildings.filter(b=>b!==reg).forEach(b=>scatter(8,[b.x-b.width/2-0.9,b.z+b.depth/2+0.2,b.x+b.width/2+0.9,b.z+b.depth/2+1],entranceMix[b.kind]));
  if (lot) scatter(14,[lot[0],lot[1]-1,lot[2],lot[1]-0.2]);
  if (reg) scatter(30,[reg.x-reg.width/2-1,reg.z+reg.depth/2+0.7,reg.x+reg.width/2+0.4,reg.z+reg.depth/2+1.3]);
  // People on the pavements beside the roads.
  roads.slice(0,4).forEach(([x0,z0,x1,z1])=>{ const alongX = x1-x0>z1-z0;
   scatter(10,alongX ? [Math.max(x0,-20),z1+0.3,Math.min(x1,20),z1+0.8] : [x1+0.3,Math.max(z0,-12),x1+0.8,Math.min(z1,12)]); });
  return out;
 },[]);
}

const walkersPerFlow = 14;
function People({flows,highlight,hidden,hour,onPickPerson}:{flows:FlowCurve[];highlight:string|null;hidden:PersonType[];hour:number;onPickPerson?:(p:PickedPerson)=>void}) {
 const standing = usePeople();
 // Standing people first, then the walkers; walks[] lines up with that combined list.
 const {people,walks} = useMemo(()=>{
  const r = seeded(5), walkers:Person[] = [], walkInfo:Walk[] = [];
  flows.forEach(f=>{ for (let i=0;i<walkersPerFlow;i++) {
   walkers.push(makePerson(r,0,0,0,pickType(r,flowMix[demoFlows.find(x=>x.id===f.id)?.kind ?? 'opd']??outdoorMix)));
   walkInfo.push({curve:f.curve,offset:i/walkersPerFlow+r()*0.05,side:(r()-0.5)*0.5,flowId:f.id});
  } });
  return {people:[...standing,...walkers],walks:[...standing.map(()=>null),...walkInfo]};
 },[flows,standing]);
 // Outdoor crowds follow the OPD rhythm; walkers follow their route's destination.
 const fraction = useMemo(()=>walks.map(w=>kindPresence(w?demoFlows.find(x=>x.id===w.flowId)?.kind ?? 'opd':'opd',hour)),[walks,hour]);
 return <Figures people={people} hidden={hidden} walks={walks} highlight={highlight} fraction={fraction} onPick={onPickPerson?i=>onPickPerson({type:people[i].type}):undefined}/>;
}

// Can a spot inside `buildingId` on `level` be seen in this view? Outdoor spots (no building) always can.
type Vis = {view:SceneView;focusId:string|null;level:number};
function spotVisible(v:Vis, buildingId?:string, level?:number) {
 if (!buildingId) return true;
 if (v.view==='campus') { const b = buildings.find(x=>x.id===buildingId); return b?.kind==='opd' && level===b.floors; } // only OPD's cut-away top floor
 if (v.view==='building') return false;
 return buildingId===v.focusId && level===v.level;
}

// The selected patient's route in order: steps done so far, where they are now, then the next step.
// Only points visible in the current view get drawn; the card keeps the full numbered list.
type RoutePoint = {p:V3;step:number;kind:StepKind;where:string;visible:boolean;state:'done'|'now'|'next'};
function routePoints(sel:PatientState, vis:Vis):RoutePoint[] {
 const at = (sp:{x:number;y:number;z:number}):V3 => [sp.x,sp.y+0.05,sp.z];
 const pts:RoutePoint[] = sel.p.steps.slice(0,sel.index).map((st,i)=>({p:at(st.place.serve),step:i,kind:st.kind,where:st.place.where,visible:spotVisible(vis,st.place.buildingId,st.place.level),state:'done'}));
 pts.push({p:at(sel.pos),step:sel.index,kind:sel.step.kind,where:sel.step.place.where,visible:spotVisible(vis,sel.area.buildingId,sel.area.level),state:'now'});
 const nx = sel.p.steps[sel.index+1];
 if (nx) pts.push({p:at(nx.place.serve),step:sel.index+1,kind:nx.kind,where:nx.place.where,visible:spotVisible(vis,nx.place.buildingId,nx.place.level),state:'next'});
 return pts;
}
// One numbered pin per visible place. Revisits share a pin ("4, 7"), except the current position, which
// always has its own. When the previous step happened out of view, the pin says where they came from.
// detail (journey replay): each pin also says when it happened and how long the wait was.
function routeLabels(pts:RoutePoint[], sel?:PatientState, detail=false, minute=0):LabelSpec[] {
 const groups:RoutePoint[][] = [];
 pts.forEach(pt=>{
  if (!pt.visible) return;
  const g = pt.state==='now' ? undefined : groups.find(x=>x[0].state!=='now' && x[0].p.every((v,k)=>Math.abs(v-pt.p[k])<0.15));
  if (g) g.push(pt); else groups.push([pt]);
 });
 return groups.map(g=>{
  const last = g[g.length-1], prev = pts[g[0].step-1];
  return {id:`route-${last.step}`,pos:[last.p[0],last.p[1]+0.75,last.p[2]],variant:'route',routeState:last.state,
   num:g.map(x=>x.step+1).join(', '),text:`${last.state==='next'?'ถัดไป · ':last.state==='now'?'ตอนนี้ · ':''}${stepText[last.kind].serve}`,
   sub:detail && sel ? stepDetail(sel,last,minute) : prev && !prev.visible ? `มาจาก ${prev.step+1} ${stepText[prev.kind].serve} · ${prev.where.split(' · ').pop()}` : undefined};
 });
}
function stepDetail(sel:PatientState, pt:RoutePoint, minute:number) {
 const st = sel.p.steps[pt.step]; if (!st) return undefined;
 const wait = Math.round(st.called-st.start), serve = Math.round(st.end-st.called), place = st.place.where.split(' · ')[0];
 if (st.kind==='kiosk') return `${fmtMin(st.start)} · มาถึง รับบัตรคิว`;
 if (st.kind==='leave') return pt.state==='next' ? 'กลับบ้าน' : `${fmtMin(st.start)} · ออกจากโรงพยาบาล`;
 if (pt.state==='next') return place;
 if (pt.state==='now') return minute<st.called ? `${place} · รอมาแล้ว ${Math.round(minute-st.start)} น.` : `${place} · เริ่ม ${fmtMin(st.called)}`;
 return `${fmtMin(st.called)} · ${place}${wait>0?` · รอ ${wait} น.`:''}${serve>0?` · ${serve} น.`:''}`;
}
const _up = new THREE.Vector3(0,1,0), _dir = new THREE.Vector3();
// Each leg: a dashed line whose dashes flow in the walking direction plus an arrowhead at its middle.
function Route({pts}:{pts:RoutePoint[]}) {
 const lines = useRef<({material:{dashOffset:number}}|null)[]>([]);
 useFrame((_,dt)=>lines.current.forEach(l=>{ if (l) l.material.dashOffset -= dt*0.8; }));
 // Only legs with both ends in view; a leg out to another floor would cut through the building.
 const legs = pts.slice(1).map((b,i)=>({a:pts[i],b})).filter(({a,b})=>a.visible && b.visible && Math.hypot(b.p[0]-a.p[0],b.p[1]-a.p[1],b.p[2]-a.p[2])>0.05);
 return <group>{legs.map(({a,b},i)=>{
  const next = b.state==='next', color = next ? '#94a3b8' : '#1677ff', opacity = 1;
  _dir.set(b.p[0]-a.p[0],b.p[1]-a.p[1],b.p[2]-a.p[2]).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(_up,_dir);
  return <group key={i}>
   <Line ref={el=>{ lines.current[i] = el as unknown as {material:{dashOffset:number}}|null; }} points={[a.p,b.p]} color={color} lineWidth={next?2:3} dashed dashSize={0.22} gapSize={0.14} transparent opacity={opacity}/>
   <mesh position={[(a.p[0]+b.p[0])/2,(a.p[1]+b.p[1])/2+0.02,(a.p[2]+b.p[2])/2]} quaternion={q}><coneGeometry args={[0.09,0.24,12]}/><meshBasicMaterial color={color} transparent opacity={opacity}/></mesh>
  </group>;
 })}</group>;
}

// Individually tracked (simulated) patients: figures placed at their current journey step, with a status
// marker above the head. Clicking either selects the patient; the selection shows a ring and the route so far.
const badgeGeo = new THREE.OctahedronGeometry(0.11,0); // big enough to spot and click
const _bm = new THREE.Matrix4(), _bc = new THREE.Color();
// solo: only this patient is drawn (journey replay).
function TrackedPatients({patients,minute,vis,hidden,selected,onPick,showRoute=true,solo=null}:{patients:Patient[];minute:number;vis:Vis;hidden:PersonType[];selected:string|null;onPick:(id:string)=>void;showRoute?:boolean;solo?:string|null}) {
 const base = useMemo(()=>patients.map(p=>{
  const r = seeded(p.seed), f = makePerson(r,0,0,0,p.flow==='er'?'emergency':'patient');
  return {...f,age:p.age,female:p.female,hair:pick(r,hairByAge[p.age]),cane:p.age==='elderly'&&r()<0.5,longHair:p.female&&p.age!=='elderly'&&f.longHair,dress:p.female&&p.age!=='child'&&f.dress};
 }),[patients]);
 const m = Math.floor(minute);
 const states = useMemo(()=>patients.map(p=>patientAt(p,m)),[patients,m]);
 const people = useMemo(()=>base.map((f,i)=>{
  const st = states[i], show = !!st && spotVisible(vis,st.area.buildingId,st.area.level) && (!solo || patients[i].id===solo);
  // In a ward bed (inpatients, and admitted ER patients once their bed is ready) they lie down.
  // In bed: ward patients, admitted patients (in the ward, or still in their ER bed), and ER patients being treated.
  const lying = !!st && (st.step.kind==='ward' || st.step.kind==='admit' || (st.step.kind==='treatment' && m>=st.step.called));
  return {...f,x:st?.pos.x??0,y:st?.pos.y??0,z:st?.pos.z??0,type:st?.step.kind==='admit'?'inpatient' as PersonType:f.type,presence:show?0:2,lying,yaw:lying?0:f.yaw};
 }),[base,states,vis.view,vis.focusId,vis.level,solo]); // eslint-disable-line react-hooks/exhaustive-deps
 const badges = useRef<THREE.InstancedMesh>(null);
 useLayoutEffect(()=>{
  const mesh = badges.current; if (!mesh) return;
  people.forEach((f,i)=>{
   const st = states[i], show = f.presence<1 && !hidden.includes(f.type);
   mesh.setMatrixAt(i,show?_bm.makeTranslation(f.x,f.y+(f.age==='child'?0.46:0.68),f.z):ZERO);
   mesh.setColorAt(i,_bc.set(st?patientColor[st.status]:'#999999'));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere(); // keep click hit-testing in sync with the moved badges
 },[people,states,hidden]);
 const si = patients.findIndex(p=>p.id===selected), sel = si>=0 ? states[si] : null, selShown = !!sel && people[si].presence<1;
 const pickBadge = (e:ThreeEvent<MouseEvent>) => { if (e.instanceId===undefined) return; e.stopPropagation(); onPick(patients[e.instanceId].id); };
 return <group>
  <Figures people={people} hidden={hidden} onPick={i=>onPick(patients[i].id)}/>
  <instancedMesh ref={badges} args={[badgeGeo,undefined,patients.length]} frustumCulled={false} onClick={pickBadge}
   onPointerOver={(e:ThreeEvent<PointerEvent>)=>{ e.stopPropagation(); document.body.style.cursor='pointer'; }} onPointerOut={()=>{ document.body.style.cursor=''; }}>
   <meshStandardMaterial roughness={0.4} emissive="#ffffff" emissiveIntensity={0.25}/>
  </instancedMesh>
  {selShown && <mesh rotation-x={-Math.PI/2} position={[sel.pos.x,sel.pos.y+0.02,sel.pos.z]}><ringGeometry args={[0.17,0.26,32]}/><meshBasicMaterial color="#1677ff"/></mesh>}
  {sel && showRoute && <Route pts={routePoints(sel,vis)}/>}
 </group>;
}

// Queue-ticket kiosks: body, tilted touch screen, ticket slot and a status light.
const kioskLight:Record<KioskStatus,string> = {online:'#22c58b','paper-low':'#f5a524',offline:'#ef4444'};
function Kiosks({vis,selected,onPick}:{vis:Vis;selected:string|null;onPick:(id:string)=>void}) {
 return <group>{kiosks.filter(k=>spotVisible(vis,k.buildingId,k.level)).map(k=><group key={k.id} position={[k.x,kioskY(k),k.z]}
   onClick={(e:ThreeEvent<MouseEvent>)=>{ e.stopPropagation(); onPick(k.id); }}
   onPointerOver={(e:ThreeEvent<PointerEvent>)=>{ e.stopPropagation(); document.body.style.cursor='pointer'; }} onPointerOut={()=>{ document.body.style.cursor=''; }}>
  <Box p={[0,0.42,0]} s={[0.34,0.84,0.24]} color="#f4f7fb"/>
  <Box p={[0,0.43,-0.125]} s={[0.36,0.86,0.02]} color="#1677ff" cast={false}/>
  <mesh position={[0,0.86,0.06]} rotation-x={-0.5}><boxGeometry args={[0.3,0.04,0.24]}/><meshStandardMaterial color="#1f2937"/></mesh>
  <mesh position={[0,0.884,0.07]} rotation-x={-0.5}><boxGeometry args={[0.26,0.006,0.2]}/><meshStandardMaterial color="#9fd8ff" emissive="#5ab8ff" emissiveIntensity={0.9}/></mesh>
  <Box p={[0,0.55,0.122]} s={[0.16,0.03,0.01]} color="#111827" cast={false}/>
  <mesh position={[0.13,0.98,-0.09]}><sphereGeometry args={[0.035,10,8]}/><meshStandardMaterial color={kioskLight[k.status]} emissive={kioskLight[k.status]} emissiveIntensity={1.2}/></mesh>
  {selected===k.id && <mesh rotation-x={-Math.PI/2} position={[0,0.02,0]}><ringGeometry args={[0.32,0.42,32]}/><meshBasicMaterial color="#1677ff"/></mesh>}
 </group>)}</group>;
}
const kioskLabels = (v:Vis):LabelSpec[] => kiosks.filter(k=>spotVisible(v,k.buildingId,k.level)).map(k=>({id:`kiosk-${k.id}`,pos:[k.x,kioskY(k)+1.2,k.z],text:'Kiosk',variant:'tag',kiosk:k.id,Icon:Ticket,iconColor:'#1677ff',dot:kioskLight[k.status]}));

// Exam / treatment room signs also name the doctor on duty at `hour` and take the duty status colour.
const signLabels = (b:BuildingSpec,plan:Plan,minZoom:number,hour:number) => {
 const duty = new Map(floorDutyAt(b.id,plan.level,hour).map(d=>[d.room.id,d]));
 return plan.signs.map<LabelSpec>((sg,i)=>{
  const d = sg.roomId ? duty.get(sg.roomId) : undefined;
  const who = d ? (d.current && d.status!=='vacant' ? doctorName(d.current.doctor) : 'ไม่มีแพทย์') : '';
  return {id:`sign-${b.id}-${i}`,pos:[b.x+sg.pos[0],sg.pos[1],b.z+sg.pos[2]],text:d?`${sg.text} · ${who}`:sg.text,variant:sg.kind,minZoom,room:d?sg.roomId:undefined,tone:d?.status};
 });
};
// Department signs hang above the corridor, like overhead hospital signage.
// dot: density colour when density is on, status colour in the department view, otherwise the zone colour.
const deptLabels = (b:BuildingSpec,plan:Plan,view:SceneView,density:boolean,hour:number,minZoom?:number) => { const now = floorDepartments(b.id,plan.level,hour); return plan.zones.filter(z=>z.dept.name).map<LabelSpec>((z,i)=>({
 id:`zone-${b.id}-${i}`,pos:[b.x+(z.x0+z.x1)/2,plan.y+1.05,b.z+(plan.corridor[0]+plan.corridor[1])/2],
 text:isOff(`dept:${z.dept.name}`)?`${z.dept.name} · งดให้บริการ`:density||view==='department'?`${z.dept.name} · ${now[i]?.queue??0} คน`:z.dept.name,variant:'zone',minZoom,
 dot:density?densityColor(now[i]?.queue??0):view==='department'?statusColor(now[i]?.status??'normal'):z.dept.color,
})); };
function viewLabels(view:SceneView,focus:BuildingSpec|null,level:number,density:boolean,hour:number):LabelSpec[] {
 return [...placeLabels(view,focus,level,density,hour),...kioskLabels({view,focusId:focus?.id??null,level})];
}
function placeLabels(view:SceneView,focus:BuildingSpec|null,level:number,density:boolean,hour:number):LabelSpec[] {
 if (!focus || view==='campus') {
  // The OPD's cut-away top floor gets its signs too, revealed when zooming in.
  const opd = buildings.find(b=>b.kind==='opd') ?? buildings[0], plan = planLayout(opd,opd.floors);
  const tags = density ? campusLabels().map(l=>{
   if (!l.building) return l;
   const avg = buildingDensityAt(l.building,hour);
   return {...l,text:`${l.text} · ${avg} คน/ชั้น`,dot:densityColor(avg)};
  }) : campusLabels();
  return [...tags,...deptLabels(opd,plan,view,density,hour,1.6),...signLabels(opd,plan,1.6,hour)];
 }
 const others = campusLabels().filter(l=>l.building && l.building!==focus.id);
 if (view==='building') return [...others,buildingTag(focus,focus.floors*floorH+0.9),
  ...(buildingStats[focus.id]?.floors??[]).map<LabelSpec>(f=>({id:`floor-${f.level}`,pos:[focus.x+focus.width/2+0.15,(f.level-0.5)*floorH,focus.z-focus.depth/2],text:`ชั้น ${f.level} · ${floorCountAt(focus.id,f.level,hour)} คน`,variant:'floor',floor:f.level,dot:densityColor(floorCountAt(focus.id,f.level,hour))}))];
 const plan = planLayout(focus,level);
 // Title sits on the back wall so it doesn't cover the plan.
 return [...others,{...buildingTag(focus,level*floorH+0.9),pos:[focus.x,level*floorH+0.6,focus.z-focus.depth/2]},
  ...deptLabels(focus,plan,view,density,hour),...signLabels(focus,plan,1.4,hour)];
}

// Labels are plain DOM over the canvas, positioned each frame. drei <Html> was dropped because it
// creates a ReactDOM root per label and unmounts it synchronously, which React 19 warns about.
type LabelRefs = RefObject<Record<string,HTMLDivElement|null>>;
function LabelTracker({labels,labelRefs}:{labels:LabelSpec[];labelRefs:LabelRefs}) {
 const v = useMemo(()=>new THREE.Vector3(),[]);
 useFrame(({camera,size})=>{
  const base = baseZoomFor(size.width,size.height);
  for (const l of labels) {
   const el = labelRefs.current?.[l.id]; if (!el) continue;
   v.set(...l.pos).project(camera);
   el.style.display = v.z>1 || (l.minZoom!==undefined && camera.zoom<base*l.minZoom) ? 'none' : '';
   el.style.zIndex = String(Math.round((1-v.z)*1000)+(l.variant==='route'||l.id==='patient-pin'?2000:0)); // route pins and the selected patient stay on top
   el.style.transform = `translate(${(v.x+1)/2*size.width}px,${(1-v.y)/2*size.height}px) ${l.variant==='floor'?'translate(6px,-50%)':'translate(-50%,-100%)'}`;
  }
 });
 return null;
}

const baseZoomFor = (w:number,h:number) => Math.max(8,Math.min(w/54,h/31));
const HOME = new THREE.Vector3(2.5,0,-2);
const DIR_3D = new THREE.Vector3(1,1.25,1).normalize();
const DIR_2D = new THREE.Vector3(0,1,0.0001).normalize();
const CAMERA_DISTANCE = 90;
type OrbitLike = { target:THREE.Vector3; update:()=>void; addEventListener:(t:'start',f:()=>void)=>void; removeEventListener:(t:'start',f:()=>void)=>void };
type Focus = {x:number;y:number;z:number;zoom:number}|null;
// Photographs the campus and each building from the map's own angle, once, for the building drawer.
// Renders straight into the visible canvas and copies it out in the same task (no preserveDrawingBuffer
// needed, colours match the map), then re-renders the normal view so nothing flickers.
const THUMB_W = 320, THUMB_H = 200;
function ThumbnailCapture({active,onDone}:{active:boolean;onDone?:(shots:Record<string,string>)=>void}) {
 const gl = useThree(s=>s.gl), scene = useThree(s=>s.scene), mainCamera = useThree(s=>s.camera);
 const done = useRef(false);
 useEffect(()=>{
  if (!active || !onDone || done.current) return;
  const timer = setTimeout(()=>{ // let instanced crowds and shadows settle first
   done.current = true;
   const el = gl.domElement, out = document.createElement('canvas'), ctx = out.getContext('2d');
   if (!ctx) return;
   out.width = THUMB_W; out.height = THUMB_H;
   const aspect = el.width/el.height, cw = Math.min(el.width,el.height*THUMB_W/THUMB_H), ch = cw*THUMB_H/THUMB_W;
   const shoot = (center:THREE.Vector3, halfH:number) => {
    const cam = new THREE.OrthographicCamera(-halfH*aspect,halfH*aspect,halfH,-halfH,1,400);
    cam.position.copy(center).addScaledVector(DIR_3D,CAMERA_DISTANCE); cam.lookAt(center); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    gl.render(scene,cam);
    ctx.drawImage(el,(el.width-cw)/2,(el.height-ch)/2,cw,ch,0,0,THUMB_W,THUMB_H);
    return out.toDataURL('image/jpeg',0.85);
   };
   const shots:Record<string,string> = {campus:shoot(HOME,15)};
   buildings.forEach(b=>{ shots[b.id] = shoot(new THREE.Vector3(b.x,b.floors*floorH*0.45,b.z),(b.width+b.depth)*0.3+b.floors*0.2+0.6); });
   gl.render(scene,mainCamera);
   onDone(shots);
  },1500);
  return ()=>clearTimeout(timer);
 },[active,gl,scene,mainCamera,onDone]);
 return null;
}

// focusKey names what is being looked at (view / floor / room / patient). A new key re-frames the camera;
// the same key at a new position (a patient moving on) only pans along, keeping the user's zoom and angle.
function CameraRig({focus,focusKey,mode,apiRef}:{focus:Focus;focusKey:string;mode:SceneMode;apiRef?:RefObject<SceneApi|null>}) {
 const camera = useThree(s=>s.camera);
 const size = useThree(s=>s.size);
 const controls = useThree(s=>s.controls) as unknown as OrbitLike|null;
 const baseZoom = baseZoomFor(size.width,size.height);
 const goal = useRef<{target:THREE.Vector3;pos:THREE.Vector3;zoom:number}|null>(null);
 const aim = (target:THREE.Vector3,zoom:number) => { goal.current = {target:target.clone(),pos:target.clone().addScaledVector(mode==='2d'?DIR_2D:DIR_3D,CAMERA_DISTANCE),zoom}; };
 const framed = useRef<string|null>(null);
 useEffect(()=>{
  if (focusKey==='hold') return;
  const target = focus ? new THREE.Vector3(focus.x,focus.y,focus.z) : HOME, key = `${focusKey}|${mode}`;
  if (framed.current===key) {
   if (controls) goal.current = {target,pos:target.clone().add(camera.position.clone().sub(controls.target)),zoom:camera.zoom};
   return;
  }
  framed.current = key;
  aim(target,baseZoom*(focus?.zoom??1));
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[focusKey,mode,focus?.x,focus?.y,focus?.z]);
 // Any user zoom / pan / rotate takes over immediately instead of fighting an animation in progress.
 useEffect(()=>{
  if (!controls) return;
  const stop = () => { goal.current = null; };
  controls.addEventListener('start',stop);
  return ()=>controls.removeEventListener('start',stop);
 },[controls]);
 useEffect(()=>{
  if (!apiRef) return;
  apiRef.current = {
   zoomBy:f=>{ goal.current = {target:(controls?.target??HOME).clone(),pos:camera.position.clone(),zoom:THREE.MathUtils.clamp(camera.zoom*f,baseZoom*0.5,baseZoom*6)}; },
   reset:()=>aim(HOME,baseZoom),
  };
 });
 useFrame((_,dt)=>{
  const g = goal.current; if (!g || !controls) return;
  const k = 1-Math.exp(-dt*7);
  controls.target.lerp(g.target,k);
  camera.position.lerp(g.pos,k);
  camera.zoom = THREE.MathUtils.lerp(camera.zoom,g.zoom,k);
  camera.updateProjectionMatrix();
  controls.update();
  if (camera.position.distanceTo(g.pos)<0.01 && Math.abs(camera.zoom-g.zoom)<0.005) goal.current = null;
 });
 // Map-style controls: left-drag pans across the ground, right-drag rotates (3D), the wheel zooms toward
 // the cursor. Touch: one finger pans, two fingers zoom/rotate.
 return <OrbitControls makeDefault enableDamping zoomToCursor screenSpacePanning={false} enableRotate={mode==='3d'} minPolarAngle={0} maxPolarAngle={mode==='3d'?1.2:0}
  minZoom={baseZoom*0.5} maxZoom={baseZoom*6}
  mouseButtons={{LEFT:THREE.MOUSE.PAN,MIDDLE:THREE.MOUSE.DOLLY,RIGHT:mode==='3d'?THREE.MOUSE.ROTATE:THREE.MOUSE.PAN}}
  touches={{ONE:THREE.TOUCH.PAN,TWO:mode==='3d'?THREE.TOUCH.DOLLY_ROTATE:THREE.TOUCH.DOLLY_PAN}}/>;
}

function Campus({solo=null,view,focusId,level,selected,onSelect,highlightFlow,hiddenTypes,showDensity,showFlows=true,hour,selectedRoom,selectedDept,patients,minute,selectedPatient,onSelectPatient,selectedKiosk,onSelectKiosk,onPickPerson}:{view:SceneView;focusId:string|null;level:number;selected:string|null;onSelect:(id:string)=>void;highlightFlow:string|null;hiddenTypes:PersonType[];showDensity:boolean;showFlows?:boolean;hour:number;selectedRoom:string|null;selectedDept:string|null;
 patients:Patient[];minute:number;selectedPatient:string|null;onSelectPatient:(id:string)=>void;selectedKiosk:string|null;onSelectKiosk:(id:string)=>void;onPickPerson:(p:PickedPerson)=>void;solo?:string|null}) {
 const vis:Vis = {view,focusId,level};
 // Solo (journey replay): the simulated crowd of patients and visitors goes too — staff and doctors stay.
 const tracked = hiddenTypes; if (solo) hiddenTypes = [...new Set<PersonType>([...hiddenTypes,'patient','emergency','inpatient','visitor'])];
 const modeFor = (b:BuildingSpec):BuildingMode => view==='campus' ? 'campus' : b.id!==focusId ? 'ghost' : view==='building' ? 'heat' : view;
 const flows = useFlowCurves();
 return <group>
  <Ground/>
  <Trees/>
  <Cars/>
  {view==='campus' && <Entrance/>}
  {showFlows && <FlowPaths flows={flows} highlight={highlightFlow}/>}
  <People flows={flows} highlight={highlightFlow} hidden={hiddenTypes} hour={hour} onPickPerson={onPickPerson}/>
  {buildings.map(b=><Building key={b.id} b={b} mode={modeFor(b)} level={level} active={selected===b.id} onSelect={onSelect} hidden={hiddenTypes} showDensity={showDensity} hour={hour} selectedRoom={selectedRoom} selectedDept={b.id===selected?selectedDept:null} onPickPerson={onPickPerson}/>)}
  {fillerBuildings.map(b=><group key={b.id} position={[b.x,0,b.z]}><ClosedFloors b={b} from={0} to={b.floors}/><Roof b={b} active={false}/></group>)}
  <Kiosks vis={vis} selected={selectedKiosk} onPick={onSelectKiosk}/>
  {(()=>{ const opd = buildings.find(b=>b.kind==='opd'); if (!opd) return null; const m = modeFor(opd), cut = m==='campus' ? opd.floors : m==='floor' || m==='department' ? level : 0;
   return cut>0 && <QueueScreens b={opd} level={cut} patients={patients} minute={minute}/>; })()}
  <TrackedPatients patients={patients} minute={minute} vis={vis} hidden={tracked} selected={selectedPatient} onPick={onSelectPatient} solo={solo}/>
 </group>;
}

// ---- Capacity board: one floor of any building on its own canvas ---------------------------------------
// Each unit (bed, exam room, station) gets a coloured mat for its state; clicking a mat, label or patient selects it.
// lift: moves the label toward the back wall (alternate neighbours, so side-by-side bed labels don't collide in 2D or 3D).
export type FloorUnit = {id:string; label:string; state:string; at:{x:number;y:number;z:number}; mat:{x:number;z:number;w:number;d:number}; patientId?:string; dim?:boolean; lift?:number};
export const unitColor:Record<string,string> = {busy:'#6d9eea',leaving:'#f5a524',boarding:'#e0368c',cleaning:'#9aa8b6',free:'#22c58b',break:'#f5a524',closed:'#c3ccd5'};
function FitFloor({w,d,mode}:{w:number;d:number;mode:SceneMode}) {
 const camera = useThree(s=>s.camera), size = useThree(s=>s.size);
 useEffect(()=>{
  camera.zoom = mode==='2d' ? Math.min(size.width/(w*1.12),size.height/(d*1.3)) : Math.min(size.width/((w+d)*0.78),size.height/((w+d)*0.5));
  camera.updateProjectionMatrix();
 },[camera,size.width,size.height,w,d,mode]);
 return null;
}
// focus: frame one part of the floor (a department's rooms and waiting area) instead of the whole building.
// arrows: proposed queue moves, drawn from one station to another.
// A raised arc with an arrow head: "move these patients from here to there".
function MoveArrow({a,y}:{a:FloorArrow;y:number}) {
 const pts = useMemo(()=>{ const out:V3[] = []; for (let i=0;i<=20;i++) { const t = i/20; out.push([a.from.x+(a.to.x-a.from.x)*t,y+0.25+Math.sin(Math.PI*t)*0.9,a.from.z+(a.to.z-a.from.z)*t]); } return out; },[a,y]);
 const end = pts[pts.length-1], prev = pts[pts.length-3];
 const dir = new THREE.Vector3(end[0]-prev[0],end[1]-prev[1],end[2]-prev[2]).normalize();
 const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),dir);
 return <group>
  <Line points={pts} color="#7c3aed" lineWidth={3} dashed dashSize={0.25} gapSize={0.12}/>
  <mesh position={end} quaternion={q}><coneGeometry args={[0.16,0.36,12]}/><meshBasicMaterial color="#7c3aed"/></mesh>
  <mesh position={[a.from.x,y+0.02,a.from.z]} rotation-x={-Math.PI/2}><ringGeometry args={[0.18,0.26,24]}/><meshBasicMaterial color="#7c3aed"/></mesh>
 </group>;
}
export type FloorArrow = {from:{x:number;z:number}; to:{x:number;z:number}};
// follow: changes whenever the caller wants the camera brought to the selected patient (e.g. a table row was clicked).
// Labels the selected patient's pin overlaps fade back (checked each frame after LabelTracker has placed them),
// so the pin stays readable; hovering a faded label brings it back.
function PinDeclutter({labelRefs}:{labelRefs:LabelRefs}) {
 useFrame(()=>{
  const all = labelRefs.current, pinEl = all['patient-pin']; if (!pinEl) return;
  const p = pinEl.getBoundingClientRect(), pad = 4;
  for (const [id,el] of Object.entries(all)) { if (!el || id==='patient-pin') continue;
   const r = el.getBoundingClientRect(), hit = r.left<p.right+pad && r.right>p.left-pad && r.top<p.bottom+pad && r.bottom>p.top-pad;
   el.classList.toggle('underPin',hit); }
 });
 useEffect(()=>()=>{ Object.values(labelRefs.current).forEach(el=>el?.classList.remove('underPin')); },[labelRefs]);
 return null;
}
// Glide the view so the patient sits in the middle of the frame (zoom and angle unchanged). Runs once per `follow`
// value, a few frames after mount so the fitted zoom is in place; the user can pan away freely afterwards.
function FollowPatient({follow,patient,minute,buildingId,level}:{follow:string;patient?:Patient;minute:number;buildingId:string;level:number}) {
 const {camera,controls} = useThree() as unknown as {camera:THREE.Camera;controls:{target:THREE.Vector3;update:()=>void}|null};
 const done = useRef<string|null>(null), wait = useRef(0);
 const anim = useRef<{from:THREE.Vector3;to:THREE.Vector3;t:number}|null>(null);
 useFrame((_,dt)=>{
  if (!controls) return;
  if (done.current!==follow) {
   if (++wait.current<3) return;
   const st = patient ? patientAt(patient,Math.floor(minute)) : null;
   done.current = follow; wait.current = 0;
   if (!st || st.area.buildingId!==buildingId || st.area.level!==level) return;
   anim.current = {from:controls.target.clone(),to:new THREE.Vector3(st.pos.x,controls.target.y,st.pos.z),t:0};
  }
  const a = anim.current; if (!a) return;
  a.t = Math.min(1,a.t+dt/0.5); const k = 1-Math.pow(1-a.t,3);
  const next = a.from.clone().lerp(a.to,k), delta = next.sub(controls.target);
  controls.target.add(delta); camera.position.add(delta); controls.update();
  if (a.t>=1) anim.current = null;
 });
 return null;
}
export function FloorScene({buildingId,level,minute,patients,units,selected,onSelect,mode,selectedPatient,onPickPatient,focus,arrows=[],follow}:{buildingId:string;level:number;minute:number;patients:Patient[];units:FloorUnit[];selected:string|null;onSelect:(id:string)=>void;mode:SceneMode;selectedPatient?:string|null;onPickPatient?:(id:string)=>void;focus?:{x:number;z:number;w:number;d:number};arrows?:FloorArrow[];follow?:string|null}) {
 const b = buildings.find(x=>x.id===buildingId)!;
 const target = useMemo(()=>new THREE.Vector3(focus?.x ?? b.x,(level-1)*floorH,focus?.z ?? b.z),[b,level,focus?.x,focus?.z]);
 const cam = target.clone().addScaledVector(mode==='2d'?DIR_2D:DIR_3D,CAMERA_DISTANCE);
 const labelRefs = useRef<Record<string,HTMLDivElement|null>>({});
 // The selected patient gets a queue-number pin over their head, so they are easy to spot at any zoom.
 const pinned = selectedPatient ? patients.find(x=>x.id===selectedPatient) : undefined, pinState = pinned ? patientAt(pinned,Math.floor(minute)) : null;
 const pin:LabelSpec|null = pinState && pinState.area.buildingId===buildingId && pinState.area.level===level ? {id:'patient-pin',pos:[pinState.pos.x,pinState.pos.y+0.95,pinState.pos.z],text:pinned!.queue,variant:'pin'} : null;
 const labels:LabelSpec[] = [...units.map<LabelSpec>(u=>({id:`unit-${u.id}`,pos:[u.at.x,u.at.y+0.62,u.at.z-(u.lift??0)],text:u.label,variant:'bed',bedState:u.state,bedId:u.id})),...(pin ? [pin] : [])];
 const sel = units.find(u=>u.id===selected), y = (level-1)*floorH+0.11;
 return <div style={{position:'absolute',inset:0}}>
  <Canvas key={`${mode}-${buildingId}-${level}-${focus?`${focus.x},${focus.z}`:''}`} orthographic flat dpr={[1,2]} camera={{position:[cam.x,cam.y,cam.z],zoom:30,near:1,far:400}} onPointerMissed={()=>onSelect('')}>
   <color attach="background" args={['#e3eaf0']}/>
   <hemisphereLight args={['#ffffff','#9fb0bf',1.35]}/><directionalLight position={[b.x+20,40,b.z+14]} intensity={1.4}/>
   <FitFloor w={focus?.w ?? b.width} d={focus?.d ?? b.depth} mode={mode}/>
   <OrbitControls makeDefault target={target} enableDamping zoomToCursor screenSpacePanning={false} enableRotate={mode==='3d'} maxPolarAngle={mode==='3d'?1.2:0}
    mouseButtons={{LEFT:THREE.MOUSE.PAN,MIDDLE:THREE.MOUSE.DOLLY,RIGHT:mode==='3d'?THREE.MOUSE.ROTATE:THREE.MOUSE.PAN}} touches={{ONE:THREE.TOUCH.PAN,TWO:THREE.TOUCH.DOLLY_ROTATE}}/>
   <group position={[b.x,0,b.z]}>
    <ClosedFloors b={b} from={0} to={level-1}/>
    <FloorPlan b={b} level={level} tint="none" hidden={[]} hour={minute/60}/>
   </group>
   {units.map(u=><mesh key={u.id} rotation-x={-Math.PI/2} position={[u.mat.x,y+0.006,u.mat.z]} onClick={(e:ThreeEvent<MouseEvent>)=>{ e.stopPropagation(); onSelect(u.id); }}>
    <planeGeometry args={[u.mat.w,u.mat.d]}/><meshBasicMaterial color={unitColor[u.state] ?? '#c3ccd5'} transparent opacity={u.dim?0.12:u.id===selected?0.95:0.6} depthWrite={false}/>
   </mesh>)}
   {sel && <group position={[sel.mat.x,y+0.01,sel.mat.z]}>{([[0,-sel.mat.d/2,sel.mat.w,0.06],[0,sel.mat.d/2,sel.mat.w,0.06],[-sel.mat.w/2,0,0.06,sel.mat.d],[sel.mat.w/2,0,0.06,sel.mat.d]] as const).map(([x,z,w,d],i)=>
    <mesh key={i} position={[x,0.02,z]}><boxGeometry args={[w,0.04,d]}/><meshBasicMaterial color="#1677ff"/></mesh>)}</group>}
   {arrows.map((a,i)=><MoveArrow key={i} a={a} y={y}/>)}
   {b.kind==='opd' && <QueueScreens b={b} level={level} patients={patients} minute={minute}/>}
   <TrackedPatients patients={patients} minute={minute} vis={{view:'floor',focusId:buildingId,level}} hidden={[]} selected={selectedPatient ?? sel?.patientId ?? null}
    showRoute={false} onPick={id=>{ if (onPickPatient) { onPickPatient(id); return; } const u = units.find(x=>x.patientId===id); if (u) onSelect(u.id); }}/>
   <LabelTracker labels={labels} labelRefs={labelRefs}/>
   {pin && <PinDeclutter labelRefs={labelRefs}/>}
   {follow && selectedPatient && <FollowPatient follow={follow} patient={patients.find(x=>x.id===selectedPatient)} minute={minute} buildingId={buildingId} level={level}/>}
  </Canvas>
  <div className="mapLabels">{labels.map(l=>{ if (l.variant==='pin') return <div key={l.id} ref={el=>{labelRefs.current[l.id]=el;}} className="mapLabel pin patientPin"><span className="labelText">{l.text}</span></div>;
   const u = units.find(x=>x.id===l.bedId);
   return <div key={l.id} ref={el=>{labelRefs.current[l.id]=el;}} className={`mapLabel bed ${l.bedState}${l.bedId===selected?' active':''}${u?.dim?' dim':''} clickable`} onClick={()=>onSelect(l.bedId!)}>
    <span className="labelText">{l.text}</span></div>; })}</div>
 </div>;
}

export default function HospitalScene({view='campus',selectedBuilding,onSelectBuilding,activeFloor=1,onSelectFloor,mode='3d',showLabels=true,highlightFlow=null,hiddenTypes=[],showDensity=false,hour:rawHour=REF_HOUR,liveKey='',selectedRoom=null,selectedDept=null,hiddenLabels=[],showFlows=true,routeDetail=false,soloPatient=null,onSelectRoom,patients=[],selectedPatient=null,onSelectPatient,selectedKiosk=null,onSelectKiosk,onPickPerson,onThumbnails,paused=false,apiRef}:{
 view?:SceneView;selectedBuilding:string|null;onSelectBuilding:(id:string)=>void;activeFloor?:number;onSelectFloor?:(level:number)=>void;
 mode?:SceneMode;showLabels?:boolean;highlightFlow?:string|null;hiddenTypes?:PersonType[];showDensity?:boolean;hour?:number;liveKey?:string;selectedRoom?:string|null;selectedDept?:string|null;hiddenLabels?:LabelKind[];showFlows?:boolean;routeDetail?:boolean;soloPatient?:string|null;onSelectRoom?:(id:string)=>void;
 patients?:Patient[];selectedPatient?:string|null;onSelectPatient?:(id:string)=>void;selectedKiosk?:string|null;onSelectKiosk?:(id:string)=>void;onPickPerson?:(p:PickedPerson)=>void;onThumbnails?:(shots:Record<string,string>)=>void;paused?:boolean;apiRef?:RefObject<SceneApi|null>;
}) {
 const labelRefs = useRef<Record<string,HTMLDivElement|null>>({});
 const start = HOME.clone().addScaledVector(DIR_3D,CAMERA_DISTANCE);
 const focusB = view==='campus' ? null : buildings.find(b=>b.id===selectedBuilding) ?? buildings[0];
 const level = focusB ? THREE.MathUtils.clamp(activeFloor,1,focusB.floors) : 1;
 const fit = focusB ? 12/Math.max(focusB.width,focusB.depth*1.3) : 1;
 const room = selectedRoom ? findRoom(selectedRoom) : undefined;
 const roomFocus = focusB && room && view!=='building' && room.buildingId===focusB.id && room.level===level ? roomRect(focusB,room.index,room.count) : null;
 // A selected room pulls the camera in close; otherwise frame the building or the floor.
 // A selected patient (when visible in this view) takes priority, then a selected room.
 const minute = rawHour*60, vis:Vis = {view,focusId:focusB?.id??null,level};
 const pState = selectedPatient ? (()=>{ const p = patients.find(x=>x.id===selectedPatient); return p ? patientAt(p,Math.floor(minute)) : null; })() : null;
 const patientFocus = pState && spotVisible(vis,pState.area.buildingId,pState.area.level) ? pState.pos : null;
 // 'hold': a patient is selected but out of view (other floor, or gone home) — the camera stays where
 // the user left it rather than re-framing on its own.
 const focusKey = patientFocus ? `patient:${selectedPatient}:${view}:${focusB?.id??''}:${level}` : selectedPatient ? 'hold' : roomFocus ? `room:${selectedRoom}` : focusB ? `${view}:${focusB.id}:${level}` : 'campus';
 const focus:Focus = patientFocus ? {x:patientFocus.x,y:patientFocus.y,z:patientFocus.z,zoom:view==='campus'?2.8:3.4*fit}
  : roomFocus && focusB ? {x:focusB.x+(roomFocus.x0+roomFocus.x1)/2,y:(level-1)*floorH,z:focusB.z+(roomFocus.z0+roomFocus.z1)/2,zoom:3.4*fit}
  : focusB ? {x:focusB.x,y:view==='building'?focusB.floors*floorH/2:(level-1)*floorH,z:focusB.z,zoom:(view==='building'?1.5:2.1)*fit} : null;
 // Demo data changes hourly, so the scene only re-renders when the hour itself changes.
 const hour = Math.floor(rawHour);
 // liveKey: a new realtime snapshot changes the current hour's counts shown in labels.
 const placeLabelList = useMemo(()=>viewLabels(view,focusB,level,showDensity,hour),[view,focusB,level,showDensity,hour,liveKey,layoutRevision()]); // eslint-disable-line react-hooks/exhaustive-deps
 const labels = (pState ? [...placeLabelList,...routeLabels(routePoints(pState,vis),pState,routeDetail,minute)] : placeLabelList).filter(l=>{ const k = labelKindOf(l); return !k || !hiddenLabels.includes(k); });
 return <div style={{position:'absolute',inset:0}}>
 {/* paused: another page covers the map, so stop rendering frames. */}
 <Canvas frameloop={paused?'never':'always'} orthographic shadows flat dpr={[1,2]} camera={{position:[start.x,start.y,start.z],zoom:18,near:1,far:400}} onPointerMissed={()=>{ if (view==='campus') onSelectBuilding(''); }}>
  <color attach="background" args={['#8fbc6c']}/>
  <hemisphereLight args={['#ffffff','#7fa36a',1.25]}/>
  <directionalLight position={[HOME.x+28,45,HOME.z+12]} intensity={1.7} castShadow shadow-mapSize={[4096,4096]} shadow-bias={-0.0004}
   shadow-camera-left={-48} shadow-camera-right={48} shadow-camera-top={48} shadow-camera-bottom={-48} shadow-camera-near={1} shadow-camera-far={140}/>
  <Campus key={layoutRevision()} solo={soloPatient} view={view} focusId={focusB?.id??null} level={level} selected={selectedBuilding} onSelect={onSelectBuilding} highlightFlow={highlightFlow} hiddenTypes={hiddenTypes} showDensity={showDensity} showFlows={showFlows} hour={hour} selectedRoom={selectedRoom} selectedDept={selectedDept}
   patients={patients} minute={minute} selectedPatient={selectedPatient} onSelectPatient={id=>onSelectPatient?.(id)} selectedKiosk={selectedKiosk} onSelectKiosk={id=>onSelectKiosk?.(id)} onPickPerson={p=>onPickPerson?.(p)}/>
  <CameraRig focus={focus} focusKey={focusKey} mode={mode} apiRef={apiRef}/>
  {/* Only from the campus view, so buildings aren't ghosted or cut away in the photos. */}
  <ThumbnailCapture active={view==='campus' && !selectedPatient && !selectedRoom} onDone={onThumbnails}/>
  <LabelTracker labels={labels} labelRefs={labelRefs}/>
 </Canvas>
 {/* zIndex:1 keeps per-label depth sorting below the dashboard overlays. */}
 <div className="mapLabels" style={{display:showLabels?undefined:'none'}}>
  {labels.map(l=>{
   const active = (l.building!==undefined && l.building===selectedBuilding) || (l.floor!==undefined && l.floor===level) || (l.room!==undefined && l.room===selectedRoom) || (l.kiosk!==undefined && l.kiosk===selectedKiosk);
   const onClick = l.kiosk && onSelectKiosk ? ()=>onSelectKiosk(l.kiosk!) : l.room && onSelectRoom ? ()=>onSelectRoom(l.room!) : l.building ? ()=>onSelectBuilding(l.building!) : l.floor!==undefined && onSelectFloor ? ()=>onSelectFloor(l.floor!) : undefined;
   // A patient is selected: their route is the subject. Past stops shrink to numbered dots (hover for details) and
   // every other label recedes (hover brings one back), so the route stays readable.
   const focus = !!pState, compact = focus && l.variant==='route' && l.routeState==='done', recede = focus && l.variant!=='route' && !active;
   return <div key={l.id} ref={el=>{labelRefs.current[l.id]=el;}} className={`mapLabel ${l.variant}${l.routeState?` ${l.routeState}`:''}${l.tone?` duty-${l.tone}`:''}${active?' active':''}${onClick?' clickable':''}${compact?' compact':''}${recede?' recede':''}`} onClick={onClick}>
    {l.Icon && <span className="labelIcon" style={{color:l.iconColor,background:l.iconBg}}><l.Icon size={17} strokeWidth={2.6}/></span>}
    <span className="labelText">{l.num && <b className="routeNum">{l.num}</b>}{l.dot && <i className="labelDot" style={{background:l.dot}}/>}{l.variant==='route' ? <span className="routeText">{l.text}</span> : l.text}{l.sub && <small className="routeSub">{l.sub}</small>}</span>
   </div>;
  })}
 </div>
 </div>;
}

// ---- Live queue screens: the display on its pole in each OPD waiting area shows that area's queue ----------------
// Data from lib/queue-screen (shared with the /tv pages). Clicking a screen opens the same screen full size.
function drawScreen(ctx:CanvasRenderingContext2D, d:ScreenData, blink:boolean) {
 const W = ctx.canvas.width, H = ctx.canvas.height;
 ctx.fillStyle = '#0b1d33'; ctx.fillRect(0,0,W,H);
 ctx.fillStyle = '#12355f'; ctx.fillRect(0,0,W,64);
 ctx.textBaseline = 'middle'; ctx.font = '700 34px Sarabun, Tahoma, sans-serif';
 let x = 18;
 if (d.letter) { ctx.fillStyle = '#1677ff'; ctx.fillRect(14,10,44,44); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(d.letter,36,33); x = 70; }
 ctx.textAlign = 'left'; ctx.fillStyle = '#fff'; ctx.fillText(d.title,x,33,W-x-14);
 if (d.closed) { ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center'; ctx.font = '700 46px Sarabun, Tahoma, sans-serif'; ctx.fillText('งดให้บริการวันนี้',W/2,H/2+20); return; }
 // Someone is being called: the whole screen becomes the call — the number and where to go, flashing.
 const calls = d.rows.filter(r=>r.calling).slice(0,2);
 if (calls.length) {
  ctx.fillStyle = blink ? '#f59e0b' : '#7c2d12'; ctx.fillRect(0,64,W,H-64);
  const ink = blink ? '#1f1300' : '#fff7ed', sub = blink ? '#3b2300' : '#fdba74';
  ctx.textAlign = 'center';
  if (calls.length===1) {
   ctx.fillStyle = sub; ctx.font = '700 30px Sarabun, Tahoma, sans-serif'; ctx.fillText('เชิญหมายเลข',W/2,100);
   ctx.fillStyle = ink; ctx.font = '900 120px Sarabun, Tahoma, sans-serif'; ctx.fillText(calls[0].queue,W/2,190,W-40);
   ctx.font = '800 44px Sarabun, Tahoma, sans-serif'; ctx.fillText(`→ ${calls[0].label}`,W/2,288,W-40);
  } else calls.forEach((r,i)=>{ const cx = W*(i?0.75:0.25);
   ctx.fillStyle = sub; ctx.font = '700 26px Sarabun, Tahoma, sans-serif'; ctx.fillText('เชิญ',cx,104);
   ctx.fillStyle = ink; ctx.font = '900 88px Sarabun, Tahoma, sans-serif'; ctx.fillText(r.queue,cx,185,W/2-30);
   ctx.font = '800 34px Sarabun, Tahoma, sans-serif'; ctx.fillText(r.label,cx,270,W/2-30); });
  if (calls.length===2) { ctx.fillStyle = sub; ctx.fillRect(W/2-1,90,2,H-120); }
  return;
 }
 const rowH = 62, top = 74;
 if (!d.rows.length) { ctx.fillStyle = '#7f93a8'; ctx.textAlign = 'center'; ctx.font = '600 34px Sarabun, Tahoma, sans-serif'; ctx.fillText('ยังไม่มีการเรียกคิว',W/2,top+rowH); }
 d.rows.forEach((r,i)=>{ const y = top+i*rowH;
  const hot = r.calling;
  ctx.fillStyle = hot ? (blink ? '#f59e0b' : '#b45309') : '#132b4a'; ctx.fillRect(10,y+4,W-20,rowH-8);
  ctx.font = '800 44px Sarabun, Tahoma, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = hot ? '#1f1300' : '#ffffff'; ctx.fillText(r.queue,26,y+rowH/2+2);
  ctx.font = '700 32px Sarabun, Tahoma, sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = hot ? '#1f1300' : '#9fc3ff'; ctx.fillText(`${hot?'เชิญ → ':''}${r.label}`,W-26,y+rowH/2+2,W*0.62);
 });
 const fy = H-44; ctx.fillStyle = '#0f2a48'; ctx.fillRect(0,fy-8,W,52);
 ctx.font = '600 26px Sarabun, Tahoma, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#7f93a8'; ctx.fillText('ถัดไป',18,fy+18);
 ctx.fillStyle = '#e6eef7'; ctx.font = '700 28px Sarabun, Tahoma, sans-serif'; ctx.fillText(d.next.length ? d.next.join('  ') : '—',96,fy+18,W-110);
}
function QueueScreens({b,level,patients,minute}:{b:BuildingSpec;level:number;patients:Patient[];minute:number}) {
 const L = useMemo(()=>planLayout(b,level),[b,level,layoutRevision()]); // eslint-disable-line react-hooks/exhaustive-deps
 const m = Math.floor(minute);
 // Everyone's state once per minute, shared by all the screens on the floor.
 const zones = useMemo(()=>{ const now = patients.map(p=>patientAt(p,m)).filter((x):x is PatientState=>!!x);
  return L.zones.map((z,i)=>({i,x:b.x+z.x1-0.35,z:b.z+L.corridor[1]+0.75,data:screenData(level,i,now,m,b.id)})).filter(z=>z.data); },[L,b,level,patients,m]);
 return <>{zones.map(z=><QueueScreen key={`${level}-${z.i}`} pos={[z.x,L.y+0.8,z.z+0.0205]} data={z.data!}/>)}</>;
}
function QueueScreen({pos,data}:{pos:V3;data:ScreenData}) {
 const {canvas,tex} = useMemo(()=>{ const c = document.createElement('canvas'); c.width = 640; c.height = 346; const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return {canvas:c,tex:t}; },[]);
 const key = JSON.stringify(data), hot = data.rows.some(r=>r.calling), blink = useRef(false), last = useRef('');
 useFrame(({clock})=>{ const on = hot && Math.floor(clock.elapsedTime*1.6)%2===0, k = key+(on?'1':'0');
  if (k===last.current) return; last.current = k; blink.current = on;
  const ctx = canvas.getContext('2d'); if (!ctx) return; drawScreen(ctx,data,on); tex.needsUpdate = true; });
 useEffect(()=>()=>tex.dispose(),[tex]);
 return <mesh position={pos} onClick={(e:ThreeEvent<MouseEvent>)=>{ e.stopPropagation(); window.open(data.link,'_blank','noopener'); }}
  onPointerOver={()=>{ document.body.style.cursor = 'pointer'; }} onPointerOut={()=>{ document.body.style.cursor = ''; }}>
  <planeGeometry args={[0.48,0.26]}/><meshBasicMaterial map={tex} toneMapped={false}/></mesh>;
}
