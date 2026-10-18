'use client';
import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { facilityImageUrl } from '../lib/api-url';

// A floor's floor-plan picture (Settings → a floor → ภาพผังพื้นหลัง) lying on the floor in 3D, under the rooms.
// Loaded without suspending the scene; nothing is drawn until it arrives (or if it cannot be loaded).
export function FloorPicture({bg,y}:{bg:{imageId:string; x0:number; z0:number; x1:number; z1:number; opacity:number}; y:number}) {
  const [tex,setTex] = useState<THREE.Texture|null>(null);
  useEffect(()=>{
    let gone = false, t:THREE.Texture|null = null;
    const loader = new THREE.TextureLoader(); loader.setCrossOrigin('anonymous');
    loader.load(facilityImageUrl(bg.imageId),x=>{ if (gone) { x.dispose(); return; } x.colorSpace = THREE.SRGBColorSpace; x.anisotropy = 4; t = x; setTex(x); },undefined,()=>{});
    return ()=>{ gone = true; t?.dispose(); setTex(null); };
  },[bg.imageId]);
  if (!tex) return null;
  return <mesh rotation-x={-Math.PI/2} position={[(bg.x0+bg.x1)/2,y,(bg.z0+bg.z1)/2]} renderOrder={1}>
    <planeGeometry args={[bg.x1-bg.x0,bg.z1-bg.z0]}/><meshBasicMaterial map={tex} transparent opacity={bg.opacity} depthWrite={false}/>
  </mesh>;
}
