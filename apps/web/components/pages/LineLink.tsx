'use client';
import { useState } from 'react';
import { Camera, CheckCircle2, Link2, Search, ShieldCheck } from 'lucide-react';
import type { QueueSync } from '../../lib/queue';

// Counter: link a patient's LINE account after checking their ID card (stage 2.5, staff-assisted).
// The patient opens "เชื่อมบัญชี" in LINE and shows a one-time QR (or reads out the short code); staff scan it, check the
// ID card as at registration, type the HN and confirm. Staff can also see whether a patient is linked and end a link.
type Api = QueueSync['api'];
const revokeReasons = ['ผู้ป่วยแจ้งโทรศัพท์หาย','เชื่อมผิดคน','ผู้ป่วยขอยกเลิก'];
export function LineLinkTab({api,features,Scanner}:{api:Api; features:QueueSync['features']; Scanner:(p:{onResult:(t:string)=>void; onClose:()=>void; title?:string})=>React.ReactNode}) {
 const [code,setCode] = useState('');
 const [hn,setHn] = useState('');
 const [idChecked,setIdChecked] = useState(false);
 const [scan,setScan] = useState(false);
 const [busy,setBusy] = useState(false);
 const [msg,setMsg] = useState<{text:string; bad?:boolean}|null>(null);
 const [lookHn,setLookHn] = useState('');
 const [status,setStatus] = useState<{hn:string; linked:boolean; since?:string}|null>(null);
 const [revoking,setRevoking] = useState(false);
 const on = !!features.phase2.accountLinking;
 const confirm = async () => {
  setBusy(true); setMsg(null);
  const r = await api<{ok:boolean; reason?:string; hn?:string; replaced?:boolean}>('link:confirm',{code:code.trim(),hn:hn.trim()});
  setBusy(false);
  if (r.ok) { setMsg({text:`เชื่อมบัญชี LINE กับ HN ${r.hn} แล้ว${r.replaced?' · บัญชี LINE เดิมของผู้ป่วยถูกยกเลิก (เปลี่ยนเครื่อง)':''} · หน้าจอในมือถือผู้ป่วยจะเปลี่ยนเอง`}); setCode(''); setHn(''); setIdChecked(false); }
  else setMsg({text:r.reason ?? 'เชื่อมบัญชีไม่สำเร็จ',bad:true});
 };
 const look = async () => {
  const r = await api<{ok:boolean; reason?:string; linked?:boolean; since?:string}>('link:status',{hn:lookHn.trim()});
  if (r.ok) setStatus({hn:lookHn.trim(),linked:!!r.linked,since:r.since}); else setMsg({text:r.reason ?? 'ตรวจสอบไม่สำเร็จ',bad:true});
 };
 const revoke = async (reason:string) => {
  setRevoking(false);
  const r = await api('link:revoke',{hn:status!.hn,reason});
  setMsg(r.ok ? {text:`ยกเลิกการเชื่อมบัญชี LINE ของ HN ••${status!.hn.slice(-4)} แล้ว`} : {text:r.reason ?? 'ยกเลิกไม่สำเร็จ',bad:true});
  if (r.ok) setStatus({...status!,linked:false,since:undefined});
 };
 return <div className="bookTab lineTab">
  {!on && <p className="serviceNote">การเชื่อมบัญชี LINE ยังปิดอยู่ · ผู้ดูแลระบบเปิดได้ที่ ตั้งค่า → ข้อมูลผู้ป่วย</p>}
  {msg && <p className={'consoleMsg'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}
  <section className="lineBox">
   <h3><Link2 size={18}/> เชื่อมบัญชี LINE ของผู้ป่วย</h3>
   <ol className="lineSteps"><li>ผู้ป่วยกด <b>เชื่อมบัญชี</b> ในเมนู LINE ของโรงพยาบาล แล้วแสดง QR</li><li>สแกน QR (หรือพิมพ์รหัส 8 ตัวบนหน้าจอผู้ป่วย)</li><li>ตรวจบัตรประชาชนตามขั้นตอนเดิม แล้วกรอก HN</li></ol>
   <div className="lineForm">
    <label>รหัสจากหน้าจอผู้ป่วย<span className="lineCode"><input value={code.startsWith('HDTLINK:') ? 'สแกน QR แล้ว ✓' : code} readOnly={code.startsWith('HDTLINK:')} maxLength={9} placeholder="เช่น ACDE-7KQR"
     onChange={e=>setCode(e.target.value)}/><button className="btn ghost sm" onClick={()=>setScan(true)}><Camera size={14}/> สแกน</button></span></label>
    <label>HN<input value={hn} maxLength={20} placeholder="เช่น 65-123456" onChange={e=>setHn(e.target.value)}/></label>
    <label className="lineCheck"><input type="checkbox" checked={idChecked} onChange={e=>setIdChecked(e.target.checked)}/><ShieldCheck size={16}/> ตรวจบัตรประชาชนแล้ว ตรงกับ HN นี้</label>
    <button className="btn" disabled={!on || busy || !code.trim() || !hn.trim() || !idChecked} onClick={()=>void confirm()}><CheckCircle2 size={15}/> {busy?'กำลังเชื่อม…':'ยืนยันเชื่อมบัญชี'}</button>
   </div>
  </section>
  <section className="lineBox">
   <h3><Search size={18}/> ตรวจสถานะการเชื่อม</h3>
   <form className="lineForm row" onSubmit={e=>{ e.preventDefault(); void look(); }}><input value={lookHn} maxLength={20} placeholder="HN" onChange={e=>setLookHn(e.target.value)}/><button className="btn ghost">ตรวจสอบ</button></form>
   {status && <div className="lineStatus"><span>HN ••{status.hn.slice(-4)} · {status.linked ? <b className="ok">เชื่อม LINE แล้ว</b> : <b>ยังไม่ได้เชื่อม</b>}
    {status.since && <small className="muted"> ตั้งแต่ {new Date(status.since).toLocaleString('th-TH',{dateStyle:'medium',timeStyle:'short'})}</small>}</span>
    {status.linked && (revoking ? <span className="slotCancel">{revokeReasons.map(r=><button key={r} className="btn ghost sm" onClick={()=>void revoke(r)}>{r}</button>)}<button className="linkBtn dark" onClick={()=>setRevoking(false)}>กลับ</button></span>
     : <button className="linkBtn danger" onClick={()=>setRevoking(true)}>ยกเลิกการเชื่อม</button>)}</div>}
   <p className="cmdNote">ระบบไม่แสดงบัญชี LINE ของผู้ป่วย · การตรวจสถานะบันทึกในประวัติการใช้งาน</p>
  </section>
  {scan && <Scanner title="สแกน QR เชื่อมบัญชีจากมือถือผู้ป่วย" onClose={()=>setScan(false)} onResult={t=>{ setScan(false); if (t.startsWith('HDTLINK:')) setCode(t); else setMsg({text:'QR นี้ไม่ใช่ QR เชื่อมบัญชี',bad:true}); }}/>}
 </div>;
}
