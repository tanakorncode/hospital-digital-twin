'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Box, Check, Loader2, Trash2, Upload } from 'lucide-react';
import type { QueueSync } from '../../lib/queue';
import { Avatar, type AvatarState } from '../reception/Avatar';
import { DEFAULT_AVATAR_CLIPS, DEFAULT_AVATAR_URL, avatarUrl } from '../reception/KioskAvatar';
import { STATE_TEXT, clipFor } from '../reception/avatarClips';

// Settings → ตู้ต้อนรับ → ตัวละคร: the 3D model or the 2D drawing; which model (the default, or one uploaded — e.g. the
// same character with other gestures, from Meshy / Tripo / Mixamo); what an uploaded model holds and which kiosk states it has a gesture
// for (the rest move by code); and a preview of every state before the kiosks get it.
type Api = QueueSync['api'];
type Settings = {mode:'2d'|'3d'; id:string|null};
type Model = {id:string; name:string; size:number; triangles:number; textures:number; rigged:boolean; animations:string[]; uploadedAt:string};
const Avatar3D = dynamic(()=>import('../reception/Avatar3D'),{ssr:false,loading:()=><div className="avPreviewWait"><Loader2 className="spin" size={22}/></div>});
const STATES = Object.keys(STATE_TEXT) as AvatarState[];
const PIECE = 1_900_000;
const mb = (n:number) => `${(n/1e6).toFixed(1)} MB`;

export function ReceptionAvatarAdmin({api}:{api:Api}) {
 const [s,setS] = useState<Settings|null>(null), [models,setModels] = useState<Model[]>([]);
 const [preview,setPreview] = useState<AvatarState>('idle'), [msg,setMsg] = useState<{text:string; bad?:boolean}|null>(null);
 const [progress,setProgress] = useState<number|null>(null);
 const file = useRef<HTMLInputElement>(null);
 const load = useCallback(async ()=>{ const r = await api<{ok:boolean; settings?:Settings; avatars?:Model[]}>('reception:avatar',{}); if (r.ok) { setS(r.settings!); setModels(r.avatars ?? []); } },[api]);
 useEffect(()=>{ void load(); },[load]);
 useEffect(()=>{ if (!msg) return; const t = setTimeout(()=>setMsg(null),8000); return ()=>clearTimeout(t); },[msg]);
 const set = async (patch:Partial<Settings>, text:string) => { const r = await api<{ok:boolean; reason?:string; settings?:Settings}>('reception:avatar:set',patch);
  if (r.ok) { setS(r.settings!); setMsg({text}); } else setMsg({text:r.reason ?? 'บันทึกไม่สำเร็จ',bad:true}); };
 // pieces of ≤ 1.9 MB (a socket message carries at most ~3 MB)
 const upload = async (f:File) => {
  if (!/\.glb$/i.test(f.name)) { setMsg({text:'เลือกไฟล์ .glb (glTF แบบไฟล์เดียว)',bad:true}); return; }
  const buf = await f.arrayBuffer(), total = Math.max(1,Math.ceil(buf.byteLength/PIECE));
  let uploadId:string|undefined; setProgress(0);
  for (let i=0; i<total; i++) {
   const r = await api<{ok:boolean; reason?:string; uploadId?:string; done?:boolean; avatar?:Model}>('reception:avatar:upload',{uploadId,name:f.name,index:i,total,bytes:buf.slice(i*PIECE,(i+1)*PIECE)});
   if (!r.ok) { setProgress(null); setMsg({text:r.reason ?? 'อัปโหลดไม่สำเร็จ',bad:true}); return; }
   uploadId = r.uploadId ?? uploadId; setProgress((i+1)/total);
   if (r.done && r.avatar) { setProgress(null); await load(); setMsg({text:`อัปโหลด ${r.avatar.name} แล้ว · กด "ใช้ตัวนี้" เพื่อให้ตู้ใช้`}); }
  }
 };
 const remove = async (m:Model) => { if (!window.confirm(`ลบ ${m.name}?`)) return; const r = await api<{ok:boolean; reason?:string; avatars?:Model[]}>('reception:avatar:delete',{id:m.id});
  if (r.ok) { setModels(r.avatars ?? []); setMsg({text:`ลบ ${m.name} แล้ว`}); } else setMsg({text:r.reason ?? 'ลบไม่สำเร็จ',bad:true}); };
 if (!s) return null;
 const chosen = models.find(m=>m.id===s.id), names = s.id===null ? DEFAULT_AVATAR_CLIPS : chosen?.animations ?? [];
 return <>
  <h4 className="setSub">ตัวละคร "น้องใจดี" <small>3D: โมเดลที่ขยับตามสถานะของตู้ · 2D: ภาพวาดในตู้ (เบาที่สุด) · ตู้ที่เครื่องไม่รองรับหรือช้า จะใช้ 2D ให้เอง</small></h4>
  {msg && <p className={'setToast'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}
  <div className="avAdmin">
   <div className="avSide">
    <span className="facViews" role="radiogroup" aria-label="รูปแบบตัวละคร">{([['3d','3D'],['2d','2D (ภาพวาด)']] as const).map(([v,t])=>
     <button key={v} type="button" role="radio" aria-checked={s.mode===v} className={s.mode===v?'on':''} onClick={()=>void set({mode:v},v==='3d'?'ตู้ใช้ตัวละคร 3D แล้ว':'ตู้ใช้ภาพวาด 2D แล้ว')}>{t}</button>)}</span>
    {s.mode==='3d' && <>
     <div className="avModels">
      <label className={'avModel'+(s.id===null?' on':'')}><input type="radio" name="avModel" checked={s.id===null} onChange={()=>void set({id:null},'ใช้น้องใจดี 3D ตั้งต้นแล้ว')}/>
       <span><b>น้องใจดี 3D (ตั้งต้น)</b><small>มากับระบบ · 4.8 MB · มีโครงกระดูก · {DEFAULT_AVATAR_CLIPS.length} ท่า (โบกมือ พูด ชี้ทาง คิด ไหว้ขอบคุณ ยืนรอ)</small></span></label>
      {models.map(m=><label key={m.id} className={'avModel'+(s.id===m.id?' on':'')}><input type="radio" name="avModel" checked={s.id===m.id} onChange={()=>void set({id:m.id},`ใช้ ${m.name} แล้ว`)}/>
       <span><b>{m.name}</b><small>{mb(m.size)} · {m.triangles.toLocaleString()} สามเหลี่ยม · {m.rigged ? `มีโครงกระดูก · ${m.animations.length} ท่า` : 'ไม่มีโครงกระดูก — ขยับด้วยโค้ด'}</small></span>
       {s.id!==m.id && <button type="button" className="iconBtn" aria-label={`ลบ ${m.name}`} onClick={e=>{ e.preventDefault(); void remove(m); }}><Trash2 size={14}/></button>}</label>)}
     </div>
     <input ref={file} type="file" accept=".glb,model/gltf-binary" hidden onChange={e=>{ const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }}/>
     <button type="button" className="btn ghost" disabled={progress!==null} onClick={()=>file.current?.click()}>
      {progress!==null ? <><Loader2 size={15} className="spin"/> กำลังอัปโหลด {Math.round(progress*100)}%</> : <><Upload size={15}/> อัปโหลดโมเดล (.glb)</>}</button>
     <p className="avNote">ไฟล์ .glb ไม่เกิน 12 MB และ 400,000 สามเหลี่ยม · ไม่ใช้การบีบอัดแบบ Draco (ใช้ meshopt ได้) · ถ้ามีท่าทาง ตั้งชื่อท่าเป็น Idle, Wave, Talk, Point, Think, Bow, Sad
      ระบบจะเล่นท่าตามสถานะของตู้เอง (Meshy: Rig แล้วเพิ่มท่าใน Animate ส่งออกเป็น glb · All Added · Single file — ถ้าชื่อท่าเป็นรหัส ต้องเปลี่ยนชื่อก่อน)</p>
    </>}
   </div>
   <div className="avPreview">
    <div className="avStage">{s.mode==='3d' ? <Avatar3D key={s.id ?? 'default'} url={s.id ? avatarUrl(s.id) : DEFAULT_AVATAR_URL} state={preview}/> : <Avatar state={preview}/>}</div>
    <div className="segBtns avStates">{STATES.map(st=><button key={st} type="button" className={preview===st?'on':''} onClick={()=>setPreview(st)}>
     {STATE_TEXT[st]}{s.mode==='3d' && clipFor(st,names) && <Check size={12}/>}</button>)}</div>
    <small className="muted">{s.mode==='2d' ? 'ภาพวาด 2D ขยับปากและท่าทางตามสถานะ'
     : names.length ? `ท่าจากไฟล์ (มีเครื่องหมาย ✓): ${STATES.filter(st=>clipFor(st,names)).map(st=>`${STATE_TEXT[st]} = ${clipFor(st,names)}`).join(' · ')} · สถานะอื่นขยับด้วยโค้ด`
     : <><Box size={12}/> โมเดลนี้ไม่มีท่าทางในไฟล์ — หายใจ โยกตัว เด้งตอนทักทาย พยักหน้าตอนพูด หันไปทางแผนที่ เอียงตัวตอนคิด ด้วยโค้ด</>}</small>
   </div>
  </div>
 </>;
}
