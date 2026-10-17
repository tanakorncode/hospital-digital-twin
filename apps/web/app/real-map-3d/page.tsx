'use client';
// Prototype: Maha Sarakham Hospital as Google Photorealistic 3D Tiles (the model Google Earth shows), with our own
// layer on top (estimated campus outline, building names typed on /real-map). Needs a Google Maps Platform key with
// the Map Tiles API enabled — from NEXT_PUBLIC_GOOGLE_MAPS_API_KEY or pasted on the page (kept in this browser).
// Google's terms: keep their logo / attributions on screen and don't extract data (heights, outlines) from the tiles.
import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import Link from 'next/link';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { TilesPlugin, TilesRenderer, TilesAttributionOverlay } from '3d-tiles-renderer/r3f';
import { GLTFExtensionsPlugin, GoogleCloudAuthPlugin, ReorientationPlugin, TileCompressionPlugin, TilesFadePlugin, UpdateOnChangePlugin } from '3d-tiles-renderer/plugins';
import raw from '../real-map/mahasarakham.json';
import s from './real-map-3d.module.css';

type Pt = [number, number];
const data = raw as unknown as {center:[number,number]; campus:Pt[]; buildings:{id:number; c:Pt; main?:boolean}[]; known?:Record<string,{name:string}>};
const [LAT, LON] = data.center;
const KEY_STORE = 'hdt.googleTilesKey';
const ENV_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
const draco = typeof window!=='undefined' ? new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/') : null;
const loadNames = ():Record<string,{name?:string}> => { try { return JSON.parse(localStorage.getItem('hdt.realmap.notes') ?? '{}'); } catch { return {}; } };

export default function RealMap3dPage() {
 const [key,setKey] = useState('');
 const [draft,setDraft] = useState('');
 const [error,setError] = useState('');
 const [overlay,setOverlay] = useState(true);
 const [names,setNames] = useState<Record<string,{name?:string}>>({});
 const [ground,setGround] = useState<number|null>(null);
 const labelEls = useRef<Record<number,HTMLDivElement|null>>({});
 const labels = useMemo<Label[]>(()=>ground===null ? [] : data.buildings.filter(b=>b.main || names[b.id]?.name || data.known?.[b.id])
  .map(b=>({id:b.id,text:names[b.id]?.name || data.known?.[b.id]?.name || 'โรงพยาบาลมหาสารคาม',main:!!b.main,pos:new THREE.Vector3(b.c[0],ground+45,b.c[1])})),[names,ground]);
 useEffect(()=>{ let k = ENV_KEY; try { k = ENV_KEY || localStorage.getItem(KEY_STORE) || ''; } catch { /* private mode */ } setKey(k); setNames(loadNames()); },[]);
 const useKey = () => { const k = draft.trim(); if (!k) return; try { localStorage.setItem(KEY_STORE,k); } catch { /* ignore */ } setError(''); setKey(k); setDraft(''); };
 const forget = () => { try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ } setKey(ENV_KEY); setError(''); };
 return <main className={s.page}>
  <header className={s.head}>
   <div><h1>โรงพยาบาลมหาสารคาม · ภาพ 3D จริง <em>ต้นแบบ</em></h1><p>โมเดล 3D จาก Google (ชุดเดียวกับ Google Earth) · ซ้อนข้อมูลของเรา: ขอบเขต รพ. และชื่ออาคาร</p></div>
   <div className={s.tools}>
    {key && <button className={overlay?s.on:''} onClick={()=>setOverlay(v=>!v)}>ข้อมูลของเรา</button>}
    {key && !ENV_KEY && <button onClick={forget}>เปลี่ยนคีย์</button>}
    <Link href="/real-map" className={s.link}>แผนที่ OSM</Link>
   </div>
  </header>
  {!key ? <section className={s.setup}>
   <div className={s.card}>
    <h2>ใส่ Google Maps API key เพื่อดูภาพ 3D</h2>
    <ol>
     <li>เข้า <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud Console</a> สร้างโปรเจกต์ และผูกบัญชีเรียกเก็บเงิน (มีโควตาใช้ฟรีรายเดือน)</li>
     <li>ไปที่ APIs &amp; Services → Library เปิดใช้ <b>Map Tiles API</b></li>
     <li>Credentials → Create credentials → <b>API key</b></li>
     <li>จำกัดคีย์: API restrictions = Map Tiles API · Website restrictions = <code>http://localhost:3000/*</code> (และโดเมนที่จะแชร์)</li>
     <li>วางคีย์ด้านล่าง (เก็บในเบราว์เซอร์นี้) หรือใส่ในไฟล์ <code>apps/web/.env.local</code> เป็น <code>NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=…</code> แล้วรีสตาร์ต dev server</li>
    </ol>
    <div className={s.keyRow}><input type="password" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{ if (e.key==='Enter') useKey(); }} placeholder="AIza…" aria-label="Google Maps API key" autoComplete="off"/>
     <button className={s.primary} disabled={!draft.trim()} onClick={useKey}>ดูภาพ 3D</button></div>
    <p className={s.small}>คีย์ที่ใช้ในหน้าเว็บจะมองเห็นได้จากเบราว์เซอร์เสมอ จึงต้องจำกัดโดเมนตามข้อ 4 · เงื่อนไขของ Google: ต้องแสดงโลโก้/เครดิตของ Google และห้ามดึงข้อมูลออกจากโมเดล</p>
   </div>
  </section> : <div className={s.canvas}>
   <Canvas camera={{position:[180,220,300],fov:45,near:1,far:60000}} dpr={[1,2]} gl={{logarithmicDepthBuffer:true}}>
    <color attach="background" args={['#cfe1f2']}/>
    <ambientLight intensity={1}/>
    <TilesRenderer key={key} onLoadError={(e:{error:Error;url:string|URL})=>setError(e.error?.message || 'โหลดไม่สำเร็จ')}>
     <TilesPlugin plugin={GoogleCloudAuthPlugin} args={[{apiToken:key,autoRefreshToken:true}]}/>
     <TilesPlugin plugin={GLTFExtensionsPlugin} args={[{dracoLoader:draco}]}/>
     <TilesPlugin plugin={TileCompressionPlugin}/>
     <TilesPlugin plugin={UpdateOnChangePlugin}/>
     <TilesPlugin plugin={TilesFadePlugin}/>
     {/* The hospital pin becomes the origin: x east, y up, −z north — the same frame as our OSM data. */}
     <TilesPlugin plugin={ReorientationPlugin} args={[{lat:LAT*THREE.MathUtils.DEG2RAD,lon:LON*THREE.MathUtils.DEG2RAD,height:0,recenter:true}]}/>
     <TilesAttributionOverlay className={s.attr}/>
    </TilesRenderer>
    <Ground y={ground} setY={setGround}/>
    {overlay && ground!==null && <Overlay ground={ground} labels={labels} els={labelEls}/>}
   </Canvas>
   {overlay && ground!==null && <div className={s.labels}>{labels.map(l=><div key={l.id} ref={el=>{ labelEls.current[l.id] = el; }} className={s.tag+(l.main?' '+s.tagMain:'')}>{l.text}</div>)}</div>}
   <div className={s.hint}>ลากเพื่อเลื่อน · คลิกขวาลากเพื่อหมุน · ล้อเมาส์ซูม</div>
   {error && <div className={s.error}><b>โหลดภาพ 3D ไม่สำเร็จ</b><span>{error}</span><small>ตรวจว่าเปิด Map Tiles API แล้ว ผูกบัญชีเรียกเก็บเงินแล้ว และคีย์อนุญาตโดเมนนี้</small>{!ENV_KEY && <button onClick={forget}>ใส่คีย์ใหม่</button>}</div>}
  </div>}
 </main>;
}

// Find the ground under the hospital once tiles arrive (ray straight down), then aim the camera at it.
function Ground({y,setY}:{y:number|null;setY:(y:number)=>void}) {
 const controls = useRef<ComponentRef<typeof OrbitControls>|null>(null);
 const {scene,camera} = useThree();
 const ray = useMemo(()=>new THREE.Raycaster(new THREE.Vector3(0,3000,0),new THREE.Vector3(0,-1,0)),[]);
 const tries = useRef(0);
 useFrame(()=>{
  if (y!==null || ++tries.current%15) return;
  const hit = ray.intersectObjects(scene.children,true).find(h=>h.object.type==='Mesh' && !h.object.userData.ours);
  if (!hit) return;
  const g = hit.point.y; setY(g);
  controls.current?.target.set(0,g,0); camera.position.set(180,g+220,300); controls.current?.update();
 });
 return <>
  <OrbitControls ref={controls} makeDefault enableDamping screenSpacePanning={false} maxPolarAngle={1.35} minDistance={25} maxDistance={2500}
   mouseButtons={{LEFT:THREE.MOUSE.PAN,MIDDLE:THREE.MOUSE.DOLLY,RIGHT:THREE.MOUSE.ROTATE}} touches={{ONE:THREE.TOUCH.PAN,TWO:THREE.TOUCH.DOLLY_ROTATE}}/>

 </>;
}

// Our layer: the estimated campus outline, and labels (DOM over the canvas) moved to their projected points each frame.
type Label = {id:number; text:string; main:boolean; pos:THREE.Vector3};
function Overlay({ground,labels,els}:{ground:number;labels:Label[];els:React.RefObject<Record<number,HTMLDivElement|null>>}) {
 const pts = data.campus.map(([x,z])=>[x,ground+1.5,z] as [number,number,number]);
 const v = useMemo(()=>new THREE.Vector3(),[]);
 useFrame(({camera,size})=>{ labels.forEach(l=>{ const el = els.current[l.id]; if (!el) return; v.copy(l.pos).project(camera);
  el.style.transform = `translate(-50%,-100%) translate(${(v.x+1)/2*size.width}px,${(1-v.y)/2*size.height}px)`; el.style.visibility = v.z<1 ? 'visible' : 'hidden'; }); });
 return <Line points={[...pts,pts[0]]} color="#ef4444" lineWidth={3} dashed dashSize={6} gapSize={4} userData={{ours:true}}/>;
}
