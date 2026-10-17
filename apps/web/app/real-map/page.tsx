'use client';
// Prototype: the real Maha Sarakham Hospital site, built from OpenStreetMap building footprints (ODbL) on satellite
// imagery. Kept apart from the demo campus until the layout is confirmed. OSM has outlines only — no building names,
// floors or campus boundary — so the boundary is estimated from the imagery, heights are guesses, and names can be
// filled in here (saved in this browser only) to prepare the mapping to OPD / ER / wards.
import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import Link from 'next/link';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import raw from './mahasarakham.json';
import s from './real-map.module.css';

type Pt = [number, number];
type Bld = {id:number; pts:Pt[]; area:number; c:Pt; campus:boolean; main?:boolean};
type Note = {name?:string; floors?:number};
type Road = {kind:string; name?:string; pts:Pt[]};
type Portico = {depth:number; height:number; length:number; bays:number; color:string};
type Look = {wall:string; roof:string; trim:string; style:'opd'|'tower'|'screen'|'plain'; setback?:number; portico?:Portico}; // setback: top floor set in by this many metres
type Known = {name:string; floors:number; source:string; note:string; sure:'high'|'medium'; look?:Look};
// extras: structures seen on site but missing from OSM (e.g. the ambulance bay).
type Extra = {id:string; name:string; kind:'canopy'; pts:Pt[]; height:number; color:string; vehicles?:number; note:string; source:string};
type MapData = {extras?:Extra[]; known?:Record<string,Known>; roadName?:string; water?:{kind:string;pts:Pt[]}[]; campus:Pt[]; pin:Pt; tiles:{z:number;x0:number;y0:number;nx:number;ny:number;origin:Pt;size:number}; buildings:Bld[]; roads:Road[]};
const data = raw as unknown as MapData;
const buildings = data.buildings;
// Identified from Street View / satellite (in the data file, for everyone); a name or floors typed here wins.
const known = data.known ?? {};
const extras = data.extras ?? [];
// Extras are selected with negative ids (-1 = first extra), buildings with their OSM way id.
const extraOf = (id:number|null) => id!==null && id<0 ? extras[-id-1] : undefined;
const nameOf = (b:Bld, notes:Record<string,Note>) => notes[b.id]?.name || known[b.id]?.name || '';
const floorsOf = (b:Bld, notes:Record<string,Note>) => notes[b.id]?.floors ?? known[b.id]?.floors ?? guessFloors(b);
const FLOOR_M = 3.6;
// Label the main road at the point of its named section nearest the main building.
// Street View shows "ถ.แจ้งสนิท" painted on the road in front of the hospital (OSM names the primary road ผดุงวิถี).
const ROAD_NAME = data.roadName ?? 'ถนนผดุงวิถี';
const roadLabel = (()=>{ const pts = data.roads.filter(r=>r.kind==='primary').flatMap(r=>r.pts);
 const p = pts.sort((a,b)=>Math.hypot(a[0]-40,a[1]-60)-Math.hypot(b[0]-40,b[1]-60))[0]; return p ? [p[0],2,p[1]] as [number,number,number] : null; })();
// No storey counts in OSM: a guess from the footprint, shown as such and changeable per building.
const guessFloors = (b:Bld) => b.main ? 6 : b.area<120 ? 1 : b.area<400 ? 2 : b.area<1200 ? 3 : b.area<2500 ? 4 : 5;
const NOTES_KEY = 'hdt.realmap.notes';
const loadNotes = ():Record<string,Note> => { try { return JSON.parse(localStorage.getItem(NOTES_KEY) ?? '{}'); } catch { return {}; } };
const fmt = (n:number) => n.toLocaleString('th-TH');

export default function RealMapPage() {
 const [view,setView] = useState<'model'|'sat'>('model'), sat = view==='sat';
 const [outside,setOutside] = useState(true);
 const [top,setTop] = useState(false);
 const [sel,setSel] = useState<number|null>(null);
 const [notes,setNotes] = useState<Record<string,Note>>({});
 useEffect(()=>{ setNotes(loadNotes()); },[]);
 const saveNote = (id:number, n:Note) => setNotes(prev=>{ const next:Record<string,Note> = {...prev,[id]:{...prev[id],...n}}; if (!next[id].name && next[id].floors===undefined) delete next[id];
  try { localStorage.setItem(NOTES_KEY,JSON.stringify(next)); } catch { /* private mode */ } return next; });
 const labels = useMemo(()=>labelsFor(notes),[notes]), labelEls = useRef<Record<string,HTMLDivElement|null>>({});
 const b = sel!==null ? buildings.find(x=>x.id===sel) : undefined, ex = extraOf(sel);
 const campus = buildings.filter(x=>x.campus), campusArea = campus.reduce((a,x)=>a+x.area,0);
 const named = buildings.filter(x=>nameOf(x,notes)).map(x=>[String(x.id),{name:nameOf(x,notes)}] as [string,Note]);
 return <main className={s.page}>
  <header className={s.head}>
   <div><h1>โรงพยาบาลมหาสารคาม · แผนที่จริง <em>ต้นแบบ</em></h1>
    <p>รูปร่างอาคารจริงจาก OpenStreetMap บนภาพถ่ายดาวเทียม · หน้าแยก ยังไม่ผูกกับระบบคิว</p></div>
   <div className={s.tools}>
    <span className={s.seg}><button className={!sat?s.on:''} onClick={()=>setView('model')}>แบบจำลอง</button><button className={sat?s.on:''} onClick={()=>setView('sat')}>ภาพดาวเทียม</button></span>
    <button className={outside?s.on:''} onClick={()=>setOutside(v=>!v)}>อาคารรอบนอก</button>
    <button className={top?s.on:''} onClick={()=>setTop(v=>!v)}>{top?'มุมมอง 3D':'มุมบน'}</button>
    <Link href="/real-map-3d" className={s.link}>ภาพ 3D จาก Google</Link>
   </div>
  </header>
  <div className={s.body}>
   <div className={s.canvas}>
    <Canvas shadows camera={{position:[150,170,230],fov:40,near:1,far:5000}} dpr={[1,2]} onPointerMissed={()=>setSel(null)}>
     <Scene sat={sat} outside={outside} top={top} sel={sel} onSel={setSel} notes={notes} labels={labels} labelEls={labelEls}/>
    </Canvas>
    <div className={s.labels}>{labels.map(l=><div key={l.key} ref={el=>{ labelEls.current[l.key] = el; }} className={l.kind==='road'?s.road:s.tag+(l.kind==='main'?' '+s.tagMain:'')}
     onClick={l.id!==undefined ? ()=>setSel(l.id!) : undefined}>{l.text}</div>)}</div>
    <div className={s.hint}>ลากเพื่อเลื่อน · คลิกขวาลากเพื่อหมุน · ล้อเมาส์ซูม · คลิกอาคารเพื่อดูข้อมูล</div>
   </div>
   <aside className={s.side}>
    {ex ? <section className={s.card}>
     <div className={s.cardHead}><b>{ex.name}</b><button aria-label="ปิด" onClick={()=>setSel(null)}>×</button></div>
     <div className={s.known}><b>ระบุจากภาพจริง</b><span>{ex.note}</span><small>ที่มา: {ex.source}</small></div>
     <p className={s.small}>ไม่มีใน OpenStreetMap · วาดเพิ่มจากตำแหน่งบนภาพดาวเทียม</p>
    </section> : b ? <section className={s.card}>
     <div className={s.cardHead}><b>{nameOf(b,notes) || (b.main ? 'อาคารตรงหมุดโรงพยาบาล' : 'อาคารไม่มีชื่อ')}</b><button aria-label="ปิด" onClick={()=>setSel(null)}>×</button></div>
     <dl className={s.facts}>
      <div><dt>พื้นที่หลังคา</dt><dd>~{fmt(b.area)} ตร.ม.</dd></div>
      <div><dt>ขนาดโดยประมาณ</dt><dd>{dims(b.pts)}</dd></div>
      <div><dt>อยู่ในเขต รพ.</dt><dd>{b.campus ? 'ใช่ (ประมาณจากภาพ)' : 'ไม่ใช่ / ไม่แน่ใจ'}</dd></div>
      <div><dt>รหัส OSM</dt><dd><a href={`https://www.openstreetmap.org/way/${b.id}`} target="_blank" rel="noreferrer">way/{b.id}</a></dd></div>
     </dl>
     {known[b.id] && <div className={s.known+(known[b.id].sure==='high'?'':' '+s.knownMid)}><b>{known[b.id].sure==='high'?'ระบุจากภาพจริง':'ระบุจากภาพจริง · ยังไม่ยืนยัน'}</b><span>{known[b.id].note}</span><small>ที่มา: {known[b.id].source}</small></div>}
     <label className={s.field}><span>ชื่ออาคาร / ใช้ทำอะไร</span>
      <input value={notes[b.id]?.name ?? known[b.id]?.name ?? ''} maxLength={40} placeholder="เช่น ตึกผู้ป่วยนอก, อุบัติเหตุ-ฉุกเฉิน" onChange={e=>saveNote(b.id,{name:e.target.value})}/></label>
     <div className={s.field}><span>จำนวนชั้น {notes[b.id]?.floors===undefined && <small>{known[b.id] ? '(จากภาพจริง)' : `(เดา ${guessFloors(b)} ชั้น)`}</small>}</span>
      <div className={s.stepper}><button onClick={()=>saveNote(b.id,{floors:Math.max(1,floorsOf(b,notes)-1)})}>−</button>
       <b>{floorsOf(b,notes)} ชั้น</b><button onClick={()=>saveNote(b.id,{floors:Math.min(20,floorsOf(b,notes)+1)})}>+</button></div></div>
     <p className={s.small}>ชื่อและจำนวนชั้นบันทึกเฉพาะในเบราว์เซอร์นี้ ใช้เตรียมข้อมูลก่อนผูกกับระบบจริง</p>
    </section> : <section className={s.card}>
     <b className={s.cardTitle}>ข้อมูลที่มี</b>
     <div className={s.stats}>
      <div><b>{campus.length}</b><span>อาคารในเขต รพ.</span></div>
      <div><b>{fmt(Math.round(campusArea/100)*100)}</b><span>ตร.ม. พื้นที่หลังคา</span></div>
      <div><b>{named.length}</b><span>อาคารที่มีชื่อแล้ว</span></div>
     </div>
     {!sat ? <ul className={s.legend}>
      <li><i className={s.lKnown}/>{Object.keys(known).length} อาคารที่มีป้ายชื่อ: ชื่อ ความสูง และสีตามภาพจริง</li>
      <li><i className={s.lCampus}/>อาคารอื่นในเขต รพ.: รูปร่างจริง ความสูงประมาณ</li>
      <li><i className={s.lOut}/>อาคารรอบนอก (จาง)</li>
      <li><i className={s.lLine}/>ขอบเขต รพ. โดยประมาณ</li>
     </ul> : <ul className={s.legend}>
      <li><i className={s.lMain}/>อาคารตรงหมุด รพ. (Google / OSM)</li>
      <li><i className={s.lKnown}/>ระบุชื่อแล้วจากภาพจริง</li>
      <li><i className={s.lCampus}/>อาคารในเขต รพ. (ประมาณ)</li>
      <li><i className={s.lOut}/>อาคารรอบนอก</li>
      <li><i className={s.lLine}/>ขอบเขต รพ. โดยประมาณ</li>
     </ul>}
     {named.length>0 && <><b className={s.cardTitle}>ตั้งชื่อแล้ว</b><ul className={s.named}>{named.map(([id,n])=><li key={id}><button onClick={()=>setSel(Number(id))}>{n.name}</button></li>)}</ul></>}
    </section>}
    <section className={s.card}>
     <b className={s.cardTitle}>ข้อจำกัดของข้อมูล</b>
     <ul className={s.notes}>
      <li><b>รูปร่างและตำแหน่งอาคาร</b> ตรงกับภาพดาวเทียม (OpenStreetMap)</li>
      <li><b>ชื่ออาคาร</b> ไม่มีใน OSM · ระบุได้ {Object.keys(known).length} หลังจาก Street View ที่เหลือต้องให้ทางโรงพยาบาลระบุ</li>
      <li><b>จำนวนชั้น</b> นับจาก Street View {Object.keys(known).length} หลัง ที่เหลือเดาจากขนาดอาคาร</li>
      <li><b>ขอบเขตโรงพยาบาล</b> ประมาณจากภาพ: ใต้คลอง ตะวันตกของ {ROAD_NAME}</li>
      <li><b>ภายในอาคาร</b> (ห้อง/แผนก) ต้องใช้แบบแปลนจากโรงพยาบาล</li>
     </ul>
     <p className={s.attr}>ข้อมูลอาคารและถนน © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">ผู้ร่วมพัฒนา OpenStreetMap</a> (ODbL) · ภาพดาวเทียม © Esri, Maxar, Earthstar Geographics</p>
    </section>
   </aside>
  </div>
 </main>;
}

const dims = (pts:Pt[]) => { // longest edge × the extent across it
 let best = 0, ang = 0; pts.forEach((p,i)=>{ const q = pts[(i+1)%pts.length], l = Math.hypot(q[0]-p[0],q[1]-p[1]); if (l>best) { best = l; ang = Math.atan2(q[1]-p[1],q[0]-p[0]); } });
 const u = pts.map(p=>p[0]*Math.cos(ang)+p[1]*Math.sin(ang)), v = pts.map(p=>-p[0]*Math.sin(ang)+p[1]*Math.cos(ang));
 return `${Math.round(Math.max(...u)-Math.min(...u))} × ${Math.round(Math.max(...v)-Math.min(...v))} ม.`;
};

type Label = {key:string; text:string; pos:[number,number,number]; kind:'main'|'named'|'road'; id?:number};
const labelsFor = (notes:Record<string,Note>):Label[] => [
 ...buildings.filter(b=>b.main || nameOf(b,notes)).map(b=>({key:String(b.id),id:b.id,text:nameOf(b,notes) || 'โรงพยาบาลมหาสารคาม',kind:(b.main?'main':'named') as Label['kind'],
  pos:[b.c[0],floorsOf(b,notes)*FLOOR_M+4,b.c[1]] as [number,number,number]})),
 ...extras.map((e,i)=>({key:e.id,id:-i-1,text:e.name,kind:'named' as const,pos:[e.pts.reduce((a,p)=>a+p[0],0)/e.pts.length,e.height+3,e.pts.reduce((a,p)=>a+p[1],0)/e.pts.length] as [number,number,number]})),
 ...(roadLabel ? [{key:'road',text:ROAD_NAME,kind:'road' as const,pos:roadLabel}] : [])];
// Labels are plain DOM over the canvas, moved every frame to the projected point (hidden when behind the camera).
function LabelTracker({labels,els}:{labels:Label[];els:React.RefObject<Record<string,HTMLDivElement|null>>}) {
 const v = useMemo(()=>new THREE.Vector3(),[]);
 useFrame(({camera,size})=>{ labels.forEach(l=>{ const el = els.current[l.key]; if (!el) return;
  v.set(...l.pos).project(camera); const vis = v.z<1;
  el.style.transform = `translate(-50%,-100%) translate(${(v.x+1)/2*size.width}px,${(1-v.y)/2*size.height}px)`; el.style.visibility = vis ? 'visible' : 'hidden'; }); });
 return null;
}

function Scene({sat,outside,top,sel,onSel,notes,labels,labelEls}:{sat:boolean;outside:boolean;top:boolean;sel:number|null;onSel:(id:number)=>void;notes:Record<string,Note>;labels:Label[];labelEls:React.RefObject<Record<string,HTMLDivElement|null>>}) {
 const [hover,setHover] = useState<number|null>(null);
 const controls = useRef<ComponentRef<typeof OrbitControls>|null>(null);
 const {camera} = useThree();
 useEffect(()=>{ // top view ↔ oblique view, keeping the point being looked at
  const t = controls.current?.target ?? new THREE.Vector3();
  camera.position.set(t.x+(top?0:160),top?520:170,t.z+(top?0.01:230)); camera.lookAt(t); controls.current?.update();
 },[top,camera]);
 const shown = buildings.filter(b=>b.campus || outside);
 return <>
  <color attach="background" args={['#dfe7ee']}/>
  <hemisphereLight args={['#ffffff','#9aa7b4',0.9]}/>
  <directionalLight position={[-180,320,140]} intensity={1.6} castShadow shadow-mapSize={[2048,2048]}
   shadow-camera-left={-400} shadow-camera-right={400} shadow-camera-top={400} shadow-camera-bottom={-400} shadow-camera-far={1200}/>
  <OrbitControls ref={controls} makeDefault enableDamping screenSpacePanning={false} maxPolarAngle={top?0:1.25} minDistance={60} maxDistance={1400}
   mouseButtons={{LEFT:THREE.MOUSE.PAN,MIDDLE:THREE.MOUSE.DOLLY,RIGHT:THREE.MOUSE.ROTATE}} touches={{ONE:THREE.TOUCH.PAN,TWO:THREE.TOUCH.DOLLY_ROTATE}}/>
  {sat ? <Ground sat/> : <ModelGround/>}
  {!sat && <Roads/>}
  {!sat && <Water/>}
  <CampusLine model={!sat}/>
  {shown.map(b=><Building key={b.id} model={!sat} b={b} floors={b.campus || known[b.id] || notes[b.id]?.floors!==undefined ? floorsOf(b,notes) : Math.min(2,guessFloors(b))} known={!!known[b.id]} sel={sel===b.id} hover={hover===b.id}
   onClick={e=>{ e.stopPropagation(); onSel(b.id); }} onOver={e=>{ e.stopPropagation(); setHover(b.id); document.body.style.cursor = 'pointer'; }}
   onOut={()=>{ setHover(h=>h===b.id?null:h); document.body.style.cursor = ''; }}/>)}
  {extras.map((e,i)=><Canopy key={e.id} e={e} sel={sel===-i-1} onClick={ev=>{ ev.stopPropagation(); onSel(-i-1); }}/>)}
  <LabelTracker labels={labels} els={labelEls}/>
 </>;
}

type BuildingProps = {b:Bld;floors:number;known:boolean;sel:boolean;hover:boolean;onClick:(e:ThreeEvent<MouseEvent>)=>void;onOver:(e:ThreeEvent<PointerEvent>)=>void;onOut:()=>void};
function Building(p:BuildingProps & {model:boolean}) { return p.model ? <ModelBuilding {...p}/> : <BoxBuilding {...p}/>; }
function BoxBuilding({b,floors,known:isKnown,sel,hover,onClick,onOver,onOut}:BuildingProps) {
 const geo = useMemo(()=>{
  // Shape in (x, −z), extruded upward after rotating −90° about x.
  const shape = new THREE.Shape(b.pts.map(([x,z])=>new THREE.Vector2(x,-z)));
  const g = new THREE.ExtrudeGeometry(shape,{depth:floors*FLOOR_M,bevelEnabled:false}); g.rotateX(-Math.PI/2); return g;
 },[b,floors]);
 const edges = useMemo(()=>new THREE.EdgesGeometry(geo,30),[geo]);
 const color = sel ? '#f59e0b' : hover ? '#93c5fd' : b.main ? '#2f7cf6' : isKnown ? '#5eead4' : b.campus ? '#f4f7fb' : '#c3ccd5';
 return <group>
  <mesh geometry={geo} castShadow receiveShadow onClick={onClick} onPointerOver={onOver} onPointerOut={onOut}>
   <meshStandardMaterial color={color} roughness={0.85} transparent={!b.campus && !sel} opacity={b.campus || sel ? 1 : 0.45} depthWrite={b.campus || sel}/>
  </mesh>
  <lineSegments geometry={edges}><lineBasicMaterial color={b.campus ? '#5b6b7c' : '#8a96a3'} transparent opacity={0.6}/></lineSegments>
 </group>;
}

// Satellite tiles (Esri World Imagery, zoom 18) laid at their exact place in the same local metres as the buildings.
function Ground({sat}:{sat:boolean}) {
 const t = data.tiles;
 const tex = useMemo(()=>{ if (!sat) return [];
  const loader = new THREE.TextureLoader(); loader.setCrossOrigin('anonymous');
  return Array.from({length:t.nx*t.ny},(_,k)=>{ const i = k%t.nx, j = Math.floor(k/t.nx);
   const tx = loader.load(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${t.z}/${t.y0+j}/${t.x0+i}`); tx.colorSpace = THREE.SRGBColorSpace; tx.anisotropy = 8;
   return {i,j,tx}; });
 },[sat,t]);
 const w = t.size*t.nx, h = t.size*t.ny;
 return <group>
  <mesh rotation-x={-Math.PI/2} position={[t.origin[0]+w/2,-0.2,t.origin[1]+h/2]} receiveShadow>
   <planeGeometry args={[w*3,h*3]}/><meshStandardMaterial color={sat ? '#7d8a6a' : '#eef1ea'}/></mesh>
  {tex.map(({i,j,tx})=><mesh key={i+'-'+j} rotation-x={-Math.PI/2} position={[t.origin[0]+(i+0.5)*t.size,0,t.origin[1]+(j+0.5)*t.size]} receiveShadow>
   <planeGeometry args={[t.size,t.size]}/><meshStandardMaterial map={tx} roughness={1}/></mesh>)}
 </group>;
}

// Road widths in metres (approximate carriageway widths for each OSM class).
const ROAD_W:Record<string,number> = {primary:15,primary_link:7,tertiary:9,tertiary_link:6,residential:6,service:4.5,unclassified:6,footway:2};
function Roads() {
 return <>{data.roads.map((r,i)=>{ const pts = r.pts.map(([x,z])=>[x,0.08+(r.kind==='primary'?0.04:0),z] as [number,number,number]), main = r.kind.startsWith('primary');
  return <group key={i}><Line points={pts} color={main ? '#6b7280' : r.kind==='service' ? '#c4ccd4' : '#9aa3ad'} lineWidth={ROAD_W[r.kind] ?? 4} worldUnits/>
   {main && <Line points={pts.map(([x,y,z])=>[x,y+0.03,z] as [number,number,number])} color="#facc15" lineWidth={0.35} worldUnits dashed dashSize={4} gapSize={4}/>}</group>; })}</>;
}
function Water() {
 return <>{(data.water ?? []).map((w,i)=><Line key={i} points={w.pts.map(([x,z])=>[x,0.06,z] as [number,number,number])} color="#5fa8d3" lineWidth={13} worldUnits/>)}</>;
}
// Model ground: soft grass around, the campus paved light grey.
function ModelGround() {
 const campus = useMemo(()=>{ const sh = new THREE.Shape(data.campus.map(([x,z])=>new THREE.Vector2(x,-z))); const g = new THREE.ShapeGeometry(sh); g.rotateX(-Math.PI/2); return g; },[]);
 return <group>
  <mesh rotation-x={-Math.PI/2} position={[0,-0.05,0]} receiveShadow><planeGeometry args={[2400,2400]}/><meshStandardMaterial color="#cfdcc4" roughness={1}/></mesh>
  <mesh geometry={campus} position={[0,0.02,0]} receiveShadow><meshStandardMaterial color="#e9ece8" roughness={1}/></mesh>
 </group>;
}

function CampusLine({model}:{model?:boolean}) {
 const pts = data.campus.map(([x,z])=>[x,0.6,z] as [number,number,number]);
 return <Line points={[...pts,pts[0]]} color={model ? '#f87171' : '#ef4444'} lineWidth={model ? 1.6 : 2.5} dashed dashSize={6} gapSize={4}/>;
}

// ---- Model building: real footprint, real (or estimated) storeys, a window band per floor and a look per style.
// Bands and slabs are the footprint scaled slightly out from its centre, extruded, then merged into one mesh each.
const ring = (b:Bld, out:number, y:number, h:number) => {
 const r = Math.sqrt(b.area/Math.PI) || 1, k = 1+out/r;
 const shape = new THREE.Shape(b.pts.map(([x,z])=>new THREE.Vector2(b.c[0]+(x-b.c[0])*k,-(b.c[1]+(z-b.c[1])*k))));
 const g = new THREE.ExtrudeGeometry(shape,{depth:h,bevelEnabled:false}); g.rotateX(-Math.PI/2); g.translate(0,y,0); return g;
};
const DEFAULT_LOOK:Look = {wall:'#f2f4f6',roof:'#cfd6dd',trim:'#5d7896',style:'plain'};
function ModelBuilding({b,floors,known:isKnown,sel,hover,onClick,onOver,onOut}:BuildingProps) {
 const look = known[b.id]?.look ?? DEFAULT_LOOK, small = floors<=1 && b.area<150, setback = floors>1 ? look.setback ?? 0 : 0;
 const H = (setback ? floors-1 : floors)*FLOOR_M; // body height; a set-back top floor sits on it
 const parts = useMemo(()=>{
  const body = new THREE.ExtrudeGeometry(new THREE.Shape(b.pts.map(([x,z])=>new THREE.Vector2(x,-z))),{depth:H,bevelEnabled:false}); body.rotateX(-Math.PI/2);
  const top = setback ? ring(b,-setback,H,FLOOR_M) : null;
  if (!b.campus && !isKnown) return {body,top};
  const win:THREE.BufferGeometry[] = [], slab:THREE.BufferGeometry[] = [], trim:THREE.BufferGeometry[] = [], lattice:THREE.BufferGeometry[] = [];
  for (let f=0; f<floors; f++) {
   const y = f*FLOOR_M;
   if (setback && f===floors-1) { win.push(ring(b,-setback+0.06,y+1.1,1.1)); continue; }
   if (look.style==='screen' && f>=1 && f<=2) { if (f===1) lattice.push(ring(b,0.12,y+0.2,FLOOR_M*2-0.4)); continue; }
   if (!small) win.push(ring(b,0.06,y+(f===0?1.2:1.1),f===0?1.4:1.1));
   if (look.style==='tower' && f>=1) slab.push(ring(b,0.9,y-0.12,0.28));
   if ((look.style==='opd' || look.style==='plain' && isKnown) && f>=1) trim.push(ring(b,0.18,y-0.1,0.3));
   if (look.style==='screen' && f>=3) slab.push(ring(b,0.5,y-0.1,0.25));
  }
  trim.push(ring(b,0.15,H-0.6,0.55)); // roof edge band, kept just below the roof so the roof colour shows
  if (setback) trim.push(ring(b,0.4,H-0.25,0.25)); // the lower roof's overhang
  const m = (list:THREE.BufferGeometry[]) => list.length ? mergeGeometries(list) : null;
  return {body,top,win:m(win),slab:m(slab),trim:m(trim),lattice:m(lattice)};
 },[b,floors,H,look.style,small,isKnown,setback]);
 const tint = sel ? '#fbbf24' : hover ? '#bfdbfe' : null;
 const out = !b.campus && !isKnown;
 return <group onClick={onClick} onPointerOver={onOver} onPointerOut={onOut}>
  <mesh geometry={parts.body} castShadow receiveShadow>
   {out ? <meshStandardMaterial color={tint ?? '#dfe4e9'} roughness={0.9} transparent opacity={0.55} depthWrite={false}/>
    : <><meshStandardMaterial attach="material-0" color={tint ?? (small ? '#d9b99b' : look.roof)} roughness={0.9}/><meshStandardMaterial attach="material-1" color={tint ?? look.wall} roughness={0.85}/></>}
  </mesh>
  {look.portico && <PorticoMesh b={b} p={look.portico}/>}
  {parts.top && <mesh geometry={parts.top} castShadow receiveShadow><meshStandardMaterial attach="material-0" color={tint ?? look.roof} roughness={0.9}/><meshStandardMaterial attach="material-1" color={tint ?? look.wall} roughness={0.85}/></mesh>}
  {parts.win && <mesh geometry={parts.win} castShadow={false}><meshStandardMaterial color="#7d98b5" roughness={0.3} metalness={0.15}/></mesh>}
  {parts.slab && <mesh geometry={parts.slab} castShadow receiveShadow><meshStandardMaterial color="#fbfbf9" roughness={0.8}/></mesh>}
  {parts.trim && <mesh geometry={parts.trim}><meshStandardMaterial color={look.style==='tower' ? '#f7f7f5' : look.trim} roughness={0.7}/></mesh>}
  {parts.lattice && <mesh geometry={parts.lattice} castShadow><meshStandardMaterial color="#e8ecee" roughness={0.95}/></mesh>}
  {look.style==='tower' && known[b.id] && <mesh position={[b.c[0],H+0.31,b.c[1]]} rotation-x={-Math.PI/2}><circleGeometry args={[Math.min(9,Math.sqrt(b.area)/4),32]}/><meshStandardMaterial color={look.roof} roughness={1}/></mesh>}
 </group>;
}

// Open-sided canopy: steel posts and a shallow arched roof along the long side, with the vehicles parked under it.
function Canopy({e,sel,onClick}:{e:Extra;sel:boolean;onClick:(ev:ThreeEvent<MouseEvent>)=>void}) {
 const g = useMemo(()=>{
  const [p0,p1,p2,p3] = e.pts, mid = (a:Pt,b:Pt):Pt => [(a[0]+b[0])/2,(a[1]+b[1])/2];
  const a = mid(p0,p1), z = mid(p2,p3), width = Math.hypot(p1[0]-p0[0],p1[1]-p0[1]), length = Math.hypot(z[0]-a[0],z[1]-a[1]);
  const c:Pt = mid(a,z), ang = Math.atan2(z[0]-a[0],z[1]-a[1]); // rotation about y: local +z runs along the length
  const n = Math.max(2,Math.round(length/5));
  return {c,ang,width,length,posts:Array.from({length:n+1},(_,i)=>-length/2+i*length/n)};
 },[e]);
 const cars = e.vehicles ?? 0;
 return <group position={[g.c[0],0,g.c[1]]} rotation-y={g.ang} onClick={onClick}>
  {g.posts.flatMap(z=>[-1,1].map(sd=><mesh key={z+'/'+sd} position={[sd*(g.width/2-0.3),e.height/2,z]} castShadow><boxGeometry args={[0.18,e.height,0.18]}/><meshStandardMaterial color="#cfd6dd"/></mesh>))}
  <mesh position={[0,e.height,0]} rotation-x={-Math.PI/2} scale={[1,1,0.35]} castShadow receiveShadow>
   <cylinderGeometry args={[g.width/2,g.width/2,g.length,24,1,true,-Math.PI/2,Math.PI]}/><meshStandardMaterial color={sel ? '#fbbf24' : e.color} side={THREE.DoubleSide} roughness={0.6} metalness={0.3}/></mesh>
  {Array.from({length:cars},(_,i)=><group key={i} position={[0,0,-g.length/2+(i+0.5)*g.length/cars]}>
   <mesh position={[0,1.05,0]} castShadow><boxGeometry args={[5.0,1.9,1.95]}/><meshStandardMaterial color="#f8fafc"/></mesh>
   <mesh position={[0,1.2,0]}><boxGeometry args={[5.02,0.18,1.97]}/><meshStandardMaterial color="#dc2626"/></mesh></group>)}
 </group>;
}

// Entrance portico on the face nearest the main road: tall pillars, a deep roof slab and louvres between the pillars.
const mainRoad = data.roads.filter(r=>r.kind==='primary').flatMap(r=>r.pts);
function PorticoMesh({b,p}:{b:Bld;p:Portico}) {
 const f = useMemo(()=>{
  const near = (q:Pt) => Math.min(...mainRoad.map(r=>Math.hypot(r[0]-q[0],r[1]-q[1])));
  let best = 0, bestD = Infinity;
  b.pts.forEach((q,i)=>{ const r = b.pts[(i+1)%b.pts.length], m:Pt = [(q[0]+r[0])/2,(q[1]+r[1])/2], d = near(m); if (d<bestD) { bestD = d; best = i; } });
  const a = b.pts[best], c = b.pts[(best+1)%b.pts.length], mid:Pt = [(a[0]+c[0])/2,(a[1]+c[1])/2];
  const len = Math.hypot(c[0]-a[0],c[1]-a[1]), t:Pt = [(c[0]-a[0])/len,(c[1]-a[1])/len];
  let n:Pt = [t[1],-t[0]]; if ((mid[0]-b.c[0])*n[0]+(mid[1]-b.c[1])*n[1]<0) n = [-n[0],-n[1]]; // outward
  return {mid,ang:Math.atan2(n[0],n[1]),span:Math.min(p.length,len*0.8)};
 },[b,p.length]);
 const cols = Array.from({length:p.bays+1},(_,i)=>-f.span/2+i*f.span/p.bays);
 // Local frame: +z points out of the building, x runs along the face.
 return <group position={[f.mid[0],0,f.mid[1]]} rotation-y={f.ang}>
  {cols.map(x=><mesh key={x} position={[x,p.height/2,p.depth-0.6]} castShadow><boxGeometry args={[1.1,p.height,1.1]}/><meshStandardMaterial color={p.color} roughness={0.8}/></mesh>)}
  <mesh position={[0,p.height+0.45,p.depth/2]} castShadow receiveShadow><boxGeometry args={[f.span+1.4,0.9,p.depth+0.4]}/><meshStandardMaterial color={p.color} roughness={0.8}/></mesh>
  {cols.slice(1).map((x,i)=>{ const cx = x-f.span/p.bays/2; return <group key={i}>{[0,1,2,3,4,5].map(k=><mesh key={k} position={[cx,p.height-0.5-k*0.32,p.depth-0.6]}><boxGeometry args={[f.span/p.bays-1.2,0.08,0.3]}/><meshStandardMaterial color="#b9a596"/></mesh>)}</group>; })}
  <mesh position={[0,0.03,p.depth/2]} receiveShadow rotation-x={-Math.PI/2}><planeGeometry args={[f.span+1.4,p.depth+0.4]}/><meshStandardMaterial color="#d6d0c8" roughness={1}/></mesh>
 </group>;
}
