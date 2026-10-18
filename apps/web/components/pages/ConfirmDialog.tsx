'use client';
import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { ModalPortal } from '../ModalPortal';

// Confirm an action that takes effect at once (revoke a kiosk, new kiosk code, retire an answer …): what it does, then
// "ยกเลิก" or the action. Esc or a click outside cancels. Same look as the retire-a-place dialog (QR นำทาง).
// alt: a second way to do it (e.g. "เลิกใช้" as the action, "ลบออกจากผัง" as the alternative).
export type Confirm = {title:string; detail?:string; facts:ReactNode[]; action:string; danger?:boolean; run:()=>void|Promise<void>; alt?:{label:string; run:()=>void|Promise<void>}};

export function ConfirmDialog({confirm,onClose}:{confirm:Confirm; onClose:()=>void}) {
 useEffect(()=>{ const f = (e:KeyboardEvent)=>{ if (e.key==='Escape') onClose(); }; window.addEventListener('keydown',f); return ()=>window.removeEventListener('keydown',f); },[onClose]);
 return <ModalPortal><div className="modalBack" onClick={onClose}>
  <div className="moveDialog retireDialog" role="dialog" aria-modal="true" aria-labelledby="confirmTitle" onClick={e=>e.stopPropagation()}>
   <header><div><b id="confirmTitle">{confirm.title}</b>{confirm.detail && <small className="muted">{confirm.detail}</small>}</div>
    <button className="iconBtn" aria-label="ปิด" onClick={onClose}><X size={18}/></button></header>
   <ul className="retireFacts">{confirm.facts.map((f,i)=><li key={i}>{f}</li>)}</ul>
   <footer><button className="btn ghost" onClick={onClose}>ยกเลิก</button>
    {confirm.alt && <button className="btn ghost warnBtn" onClick={()=>{ onClose(); void confirm.alt!.run(); }}>{confirm.alt.label}</button>}
    <button className={confirm.danger ? 'btn danger' : 'btn'} autoFocus onClick={()=>{ onClose(); void confirm.run(); }}>{confirm.action}</button></footer>
  </div>
 </div></ModalPortal>;
}
