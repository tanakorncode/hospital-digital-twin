'use client';
import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { AvatarState } from './Avatar';
import { CLIP_NAMES } from './avatarClips';

// "น้องใจดี" in 3D (a GLB). Two ways she moves, by the kiosk's state:
//  · the model's own animations, when it has a skeleton and clips named like the states (Idle, Wave, Talk, Point,
//    Think, Bow, Sad…): played and blended; the one-offs (a wave, pointing, a bow) go back to idle when they end;
//  · for a state without a clip (or a model straight from a generator, with none), the whole figure moves: breathing,
//    a gentle sway, a hop when someone starts, a nod while she speaks, turning towards the panel she points at, a tilt
//    while thinking, a small bow, and now and then a glance aside so she never looks frozen.
// The figure is scaled to one unit tall, feet on the ground, facing the viewer (glTF's +Z). `onReady` once drawn;
// `onSlow` if this machine cannot keep up (the kiosk then shows the 2D drawing instead).
type Clips = Partial<Record<AvatarState, THREE.AnimationAction>>;
const ONCE:AvatarState[] = ['greeting','pointing','thanks'];

function Figure({url,state,onReady}:{url:string; state:AvatarState; onReady?:()=>void}) {
 const gltf = useGLTF(url,false,true);
 const root = useRef<THREE.Group>(null), body = useRef<THREE.Group>(null);
 // a copy per figure (bound to its own skeleton, so the clips move what is drawn), normalised: one unit tall,
 // centred, feet at 0
 const {scene,scale,offset} = useMemo(()=>{
  const s = cloneSkinned(gltf.scene); s.updateMatrixWorld(true);
  // a skinned mesh's box comes from its posed bones: pose them first
  s.traverse(o=>{ const m = o as THREE.SkinnedMesh; if (m.isSkinnedMesh) { m.skeleton.update(); m.computeBoundingBox(); } });
  const box = new THREE.Box3().setFromObject(s), size = box.getSize(new THREE.Vector3()), k = 1/Math.max(1e-6,size.y);
  s.traverse(o=>{ if ((o as THREE.Mesh).isMesh) { const m = o as THREE.Mesh; m.frustumCulled = false; } });
  return {scene:s,scale:k,offset:new THREE.Vector3(-(box.min.x+box.max.x)/2,-box.min.y,-(box.min.z+box.max.z)/2)};
 },[gltf.scene]);
 const mixer = useMemo(()=>new THREE.AnimationMixer(scene),[scene]);
 const clips = useMemo<Clips>(()=>{ const out:Clips = {};
  (Object.keys(CLIP_NAMES) as AvatarState[]).forEach(st=>{ const c = gltf.animations.find(a=>CLIP_NAMES[st].test(a.name)); if (c) { const act = mixer.clipAction(c);
   if (ONCE.includes(st)) { act.setLoop(THREE.LoopOnce,1); act.clampWhenFinished = true; } out[st] = act; } });
  return out; },[gltf.animations,mixer]);
 const animated = Object.keys(clips).length>0;
 const current = useRef<THREE.AnimationAction|null>(null);
 useEffect(()=>{ onReady?.(); },[onReady]);
 // the state's clip (or idle), cross-faded; a one-off goes back to idle when it ends
 useEffect(()=>{ if (!animated) return;
  const next = clips[state] ?? clips.idle; if (!next || next===current.current) return;
  next.reset().setEffectiveWeight(1).fadeIn(0.35).play(); current.current?.fadeOut(0.35); current.current = next;
  const done = (e:{action:THREE.AnimationAction}) => { if (e.action===next && clips.idle && next!==clips.idle) { clips.idle.reset().fadeIn(0.35).play(); next.fadeOut(0.35); current.current = clips.idle; } };
  mixer.addEventListener('finished',done); return ()=>mixer.removeEventListener('finished',done); },[state,animated,clips,mixer]);
 // procedural motion, eased towards each state's pose
 const since = useRef(0), glance = useRef({wait:6+Math.random()*8, left:0, yaw:0}), pose = useRef({yaw:0,tilt:0,lean:0,y:0});
 useEffect(()=>{ since.current = 0; },[state]);
 useFrame((_,dt)=>{
  const d = Math.min(dt,0.1); mixer.update(d); since.current += d; const t = performance.now()/1000, b = body.current, r = root.current; if (!b || !r) return;
  // a glance aside every 8–16 s while waiting
  const g = glance.current; if (g.left>0) g.left -= d; else if ((g.wait -= d)<0) { g.left = 1.6; g.wait = 8+Math.random()*8; g.yaw = (Math.random()<0.5?-1:1)*(0.18+Math.random()*0.12); }
  const glancing = state==='idle' && g.left>0;
  // the code's own gesture only for a state the model has no clip for
  const target = {yaw:0,tilt:0,lean:0,y:0}, own = !clips[state], at = since.current;
  if (state==='pointing' && own) { target.yaw = 0.45; target.lean = 0.03; }
  else if (state==='thinking' && own) { target.yaw = -0.14; target.tilt = 0.07; }
  else if (state==='unsure' && own) { target.tilt = -0.06; target.lean = 0.05; }
  else if (state==='greeting' && own) { const k = Math.max(0,1-at/1.4); target.y = 0.05*Math.abs(Math.sin(at*7))*k; target.yaw = 0.12*Math.sin(at*5)*k; }
  else if (state==='thanks' && own) target.lean = at>0.2 && at<1.6 ? 0.12 : 0;
  else if (glancing) target.yaw = g.yaw;
  const p = pose.current, ease = (a:number,b2:number,l=6) => THREE.MathUtils.damp(a,b2,l,d);
  p.yaw = ease(p.yaw,target.yaw,4); p.tilt = ease(p.tilt,target.tilt); p.lean = ease(p.lean,target.lean); p.y = ease(p.y,target.y,18);
  // with its own animations the model breathes and gestures itself: only turn it; without, the whole figure moves
  const breathe = animated ? 0 : Math.sin(t*2.1)*0.007, sway = animated ? 0 : Math.sin(t*0.8)*0.018;
  const talk = state==='speaking' && !clips.speaking ? Math.abs(Math.sin(t*8.5))*0.008 : 0, nod = state==='speaking' && !clips.speaking ? Math.sin(t*4.2)*0.025 : 0;
  r.rotation.y = p.yaw; r.position.y = p.y+talk;
  b.rotation.set(p.lean+nod,0,p.tilt+sway); b.scale.set(1-breathe*0.5,1+breathe,1-breathe*0.5);
 });
 return <group ref={root}><group ref={body}><group scale={scale}><primitive object={scene} position={offset}/></group></group></group>;
}

// Frame rate check: after a short warm-up, an average under ~22 frames a second for 4 s = too slow for this machine.
function Watchdog({onSlow}:{onSlow?:()=>void}) {
 const acc = useRef({t:0,n:0,warm:3,told:false});
 useFrame((_,dt)=>{ const a = acc.current; if (a.told || !onSlow) return; if (a.warm>0) { a.warm -= dt; return; }
  a.t += dt; a.n++; if (a.t>=4) { if (a.n/a.t<22) { a.told = true; onSlow(); } a.t = 0; a.n = 0; } });
 return null;
}

export default function Avatar3D({url,state,onReady,onSlow,className}:{url:string; state:AvatarState; onReady?:()=>void; onSlow?:()=>void; className?:string}) {
 return <div className={'av3d'+(className ? ' '+className : '')}>
  <Canvas dpr={[1,1.5]} gl={{antialias:true,alpha:true,powerPreference:'high-performance'}} camera={{fov:20,position:[0,0.56,3.6],near:0.1,far:20}}
   onCreated={({camera})=>camera.lookAt(0,0.5,0)}>
   <hemisphereLight args={['#ffffff','#b9c4d6',1.5]}/>
   <directionalLight position={[1.6,2.6,3]} intensity={1.7}/>
   <directionalLight position={[-2,1.5,-2.5]} intensity={0.7} color="#cfe0ff"/>
   <Suspense fallback={null}><Figure url={url} state={state} onReady={onReady}/></Suspense>
   <ContactShadows position={[0,0.001,0]} opacity={0.32} scale={1.4} blur={2.4} far={1} frames={1}/>
   <Watchdog onSlow={onSlow}/>
  </Canvas>
 </div>;
}
