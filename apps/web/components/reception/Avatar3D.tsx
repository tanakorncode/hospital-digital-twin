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
// Generated "idle" and "talk" clips often barely move (Meshy's: under 2°). Over a clip that quiet, a Mixamo-style
// skeleton gets a layer of its own: breathing, looking around, and while she speaks nodding and moving her hands.
// On the welcome screen she keeps inviting people: a wave, then a bow (a wai), every few seconds.
// The figure is scaled to one unit tall, feet on the ground, facing the viewer (glTF's +Z). `onReady` once drawn;
// `onSlow` if this machine cannot keep up (the kiosk then shows the 2D drawing instead).
type Clips = Partial<Record<AvatarState, THREE.AnimationAction>>;
const ONCE:AvatarState[] = ['greeting','pointing','thanks'];
const QUIET = 6*Math.PI/180; // a clip whose bones turn less than this is "quiet"
const INVITE_EVERY = 6;      // s between gestures while the welcome screen waits
type Bones = Partial<Record<'spine'|'spine2'|'neck'|'head'|'armL'|'armR',THREE.Bone>>;
const BONE_NAMES:Record<keyof Bones,string> = {spine:'Spine',spine2:'Spine2',neck:'Neck',head:'Head',armL:'LeftForeArm',armR:'RightForeArm'};
// the most any bone turns in a clip
function reach(clip:THREE.AnimationClip) { let most = 0; const q0 = new THREE.Quaternion(), q = new THREE.Quaternion();
 for (const tr of clip.tracks) { if (!tr.name.endsWith('.quaternion')) continue; const v = tr.values; q0.fromArray(v,0);
  for (let i=4; i<v.length; i+=4) most = Math.max(most,q0.angleTo(q.fromArray(v,i))); }
 return most; }
const _q = new THREE.Quaternion(), _e = new THREE.Euler();
// turn a bone a little in its own frame, on top of what the clip set this frame
const nudge = (b:THREE.Bone|undefined, x:number, y:number, z:number) => { if (b) b.quaternion.multiply(_q.setFromEuler(_e.set(x,y,z))); };

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
 const quiet = useMemo(()=>new Set(Object.values(clips).filter(a=>reach(a.getClip())<QUIET)),[clips]);
 const bones = useMemo<Bones>(()=>{ const out:Bones = {}; scene.traverse(o=>{ if (!(o as THREE.Bone).isBone) return;
  const n = o.name.replace(/^mixamorig[:_]?/i,''); (Object.keys(BONE_NAMES) as (keyof Bones)[]).forEach(k=>{ if (n===BONE_NAMES[k] && !out[k]) out[k] = o as THREE.Bone; }); });
  return out; },[scene]);
 const current = useRef<THREE.AnimationAction|null>(null);
 useEffect(()=>{ onReady?.(); },[onReady]);
 // the state's clip (or idle), cross-faded; a one-off goes back to idle when it ends
 useEffect(()=>{ if (!animated) return;
  const next = clips[state] ?? clips.idle; if (!next || next===current.current) return;
  next.reset().setEffectiveWeight(1).fadeIn(0.35).play(); current.current?.fadeOut(0.35); current.current = next; },[state,animated,clips]);
 useEffect(()=>{ const done = (e:{action:THREE.AnimationAction}) => { const idle = clips.idle;
   if (idle && e.action===current.current && e.action!==idle) { idle.reset().fadeIn(0.35).play(); e.action.fadeOut(0.35); current.current = idle; } };
  mixer.addEventListener('finished',done); return ()=>mixer.removeEventListener('finished',done); },[clips,mixer]);
 // waiting on the welcome screen: a wave, a bow, a wave… while nobody has started
 useEffect(()=>{ const moves = [clips.thanks,clips.greeting].filter((a):a is THREE.AnimationAction=>!!a); if (state!=='greeting' || !moves.length) return;
  let i = 0; const t = setInterval(()=>{ const a = moves[i++ % moves.length]; if (current.current===a) return;
   a.reset().setEffectiveWeight(1).fadeIn(0.35).play(); current.current?.fadeOut(0.35); current.current = a; },INVITE_EVERY*1000);
  return ()=>clearInterval(t); },[state,clips]);
 // procedural motion, eased towards each state's pose
 const since = useRef(0), glance = useRef({wait:6+Math.random()*8, left:0, yaw:0}), pose = useRef({yaw:0,tilt:0,lean:0,y:0}), life = useRef({idle:0,talk:0});
 useEffect(()=>{ since.current = 0; },[state]);
 useFrame((_,dt)=>{
  const d = Math.min(dt,0.1); mixer.update(d); since.current += d; const t = performance.now()/1000, b = body.current, r = root.current; if (!b || !r) return;
  // the layer over a quiet clip (eased in and out so it never jumps)
  const cur = current.current, still = !!cur && quiet.has(cur), L = life.current;
  L.talk = THREE.MathUtils.damp(L.talk,still && state==='speaking' ? 1 : 0,3,d); L.idle = THREE.MathUtils.damp(L.idle,still ? 1 : 0,3,d);
  if (L.idle>0.001) { const k = L.idle, deg = Math.PI/180;
   // breathing, a weight shift from side to side, looking around, a tilt of the head, hands never quite still
   nudge(bones.spine,0,0,Math.sin(t*0.9)*3*deg*k);
   nudge(bones.spine2,(Math.sin(t*1.7)*2.5)*deg*k,0,-Math.sin(t*0.9)*2*deg*k);
   nudge(bones.neck,0,(Math.sin(t*0.8)*12+Math.sin(t*0.31+1)*6)*deg*k*(1-L.talk*0.5),0);
   nudge(bones.head,(Math.sin(t*1.1)*3+L.talk*(3+Math.sin(t*4.2)*5))*deg*k,0,(Math.sin(t*0.6)*6+L.talk*Math.sin(t*1.3)*4)*deg*k);
   nudge(bones.armR,(6+Math.sin(t*1.2)*6)*deg*k*(1-L.talk),0,0); nudge(bones.armL,(6+Math.sin(t*1.2+2)*6)*deg*k*(1-L.talk),0,0);
   if (L.talk>0.001) { const q = L.talk;
    nudge(bones.spine,0,Math.sin(t*1.3)*5*deg*q,0);
    nudge(bones.armR,(30+28*Math.sin(t*2.3))*deg*q,0,0);
    nudge(bones.armL,(20+22*Math.sin(t*1.9+1.2))*deg*q,0,0); } }
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
  // with its own animations the model breathes and gestures itself: only a slight sway; without, the whole figure moves
  const breathe = animated ? 0 : Math.sin(t*2.1)*0.007, sway = Math.sin(t*0.8)*(animated ? 0.012 : 0.018);
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
