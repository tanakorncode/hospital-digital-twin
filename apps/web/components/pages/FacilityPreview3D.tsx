'use client';
import { useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import type { FloorLayout } from './FacilityHelp';

// The draft floor in 3D (Settings → ผังโรงพยาบาล): the same layout as the 2D preview, built like the main map's floor —
// low walls around the rooms at the back, a waiting band per department at the front, counters, booths and beds.
// The group being edited is blue and called out; what is switched off is grey. Drag to turn, scroll to zoom.
const WALL = 0.5, T = 0.08;
const col = (on:boolean, hi:boolean, base:string) => !on ? '#cbd5e1' : hi ? '#60a5fa' : base;

export default function FacilityPreview3D({L}:{L:FloorLayout}) {
  const {W,D,roomFront,front0} = L, hw = W/2, hd = D/2, size = Math.max(W,D);
  // Labels live in our own layer over the canvas (not next to it), so they go away cleanly with this component.
  const labels = useRef<HTMLDivElement>(null!);
  return <div className="facPreview3d"><div className="fac3dLabels" ref={labels}/>
    <Canvas orthographic dpr={[1,2]} camera={{position:[size*0.9,size*1.1,size*1.25],zoom:520/(size*1.2),near:0.1,far:200}}>
      <color attach="background" args={['#f4f7fb']}/>
      <hemisphereLight args={['#ffffff','#b6c3d1',1.3]}/>
      <directionalLight position={[8,14,6]} intensity={1.2}/>
      {/* Floor slab, corridor and the waiting bands */}
      <mesh position={[0,-0.05,0]}><boxGeometry args={[W,0.1,D]}/><meshStandardMaterial color="#e9eef4"/></mesh>
      <mesh position={[0,0.002,(roomFront+front0)/2]} rotation-x={-Math.PI/2}><planeGeometry args={[W,front0-roomFront]}/><meshStandardMaterial color="#f8fafc"/></mesh>
      {L.bands.map(b=><group key={b.id}>
        <mesh position={[b.x0+b.w/2,0.004,(front0+hd)/2]} rotation-x={-Math.PI/2}><planeGeometry args={[b.w-0.06,hd-front0-0.06]}/><meshStandardMaterial color={b.focus?'#dbeafe':b.on?'#f1f5f9':'#e2e8f0'}/></mesh>
        <Html position={[b.x0+b.w/2,0.05,hd-0.35]} center className="fac3dLabel band" zIndexRange={[5,0]} portal={labels}>{b.name}{b.on?'':' (ปิด)'}</Html>
      </group>)}
      {/* Outer walls (the front one low, so the floor can be seen) */}
      <mesh position={[0,WALL/2,-hd]}><boxGeometry args={[W,WALL,T]}/><meshStandardMaterial color="#cfd8e3"/></mesh>
      <mesh position={[-hw,WALL/2,0]}><boxGeometry args={[T,WALL,D]}/><meshStandardMaterial color="#cfd8e3"/></mesh>
      <mesh position={[hw,WALL/2,0]}><boxGeometry args={[T,WALL,D]}/><meshStandardMaterial color="#cfd8e3"/></mesh>
      <mesh position={[0,0.1,hd]}><boxGeometry args={[W,0.2,T]}/><meshStandardMaterial color="#cfd8e3"/></mesh>
      {/* Rooms along the back wall: a tinted floor, side walls and a front wall with a door gap */}
      {L.rooms.map((r,k)=>{ const cx = r.x0+r.w/2, depth = roomFront+hd, color = col(r.on,r.hi,'#e2e8f0');
        return <group key={r.id}>
          <mesh position={[cx,0.006,-hd+depth/2]} rotation-x={-Math.PI/2}><planeGeometry args={[r.w-0.06,depth-0.06]}/><meshStandardMaterial color={r.hi?'#bfdbfe':r.on?'#eef2f7':'#e2e8f0'}/></mesh>
          {k>0 && <mesh position={[r.x0,WALL/2,-hd+depth/2]}><boxGeometry args={[T,WALL,depth]}/><meshStandardMaterial color={color}/></mesh>}
          <mesh position={[r.x0+0.3+(r.w-0.3)/2+0.15,WALL/2,roomFront]}><boxGeometry args={[Math.max(0.1,r.w-0.6),WALL,T]}/><meshStandardMaterial color={color}/></mesh>
          <Html position={[cx,WALL+0.15,-hd+depth/2]} center className={'fac3dLabel'+(r.hi?' hi':'')+(r.on?'':' off')} zIndexRange={[5,0]} portal={labels}>{r.w>1.6 ? r.name : r.short}</Html>
        </group>; })}
      {/* Counters / booths: a desk and the member of staff behind it */}
      {L.counters.map(c=><group key={c.id} position={[c.x,0,c.z]}>
        <mesh position={[0,0.16,-0.3]}><boxGeometry args={[c.booth?0.42:0.26,0.32,0.22]}/><meshStandardMaterial color={col(c.on,c.hi,'#64748b')}/></mesh>
        <mesh position={[0,0.22,-0.6]}><sphereGeometry args={[0.09,12,10]}/><meshStandardMaterial color={col(c.on,c.hi,'#94a3b8')}/></mesh>
      </group>)}
      {/* Waiting chairs facing the counters */}
      {L.seats.map((c,i)=><mesh key={i} position={[c.x,0.08,c.z]}><boxGeometry args={[0.3,0.16,0.3]}/><meshStandardMaterial color={c.focus?'#93c5fd':'#c3ccd7'}/></mesh>)}
      {/* Beds */}
      {L.beds.map(b=><mesh key={b.id} position={[b.x,0.1,b.z]}><boxGeometry args={[0.36,0.18,0.72]}/><meshStandardMaterial color={col(b.on,b.hi,'#ffffff')}/></mesh>)}
      {L.tag && L.tagAt && <Html position={L.focusKind==='room' ? [L.tagAt.x,0.15,L.tagAt.z+0.75] : [L.tagAt.x,0.9,L.tagAt.z]} className="fac3dTag" zIndexRange={[6,0]} portal={labels}>{L.tag}</Html>}
      <OrbitControls enablePan={false} minZoom={10} maxZoom={200} maxPolarAngle={Math.PI/2.15} target={[0,0,0]}/>
    </Canvas>
  </div>;
}
