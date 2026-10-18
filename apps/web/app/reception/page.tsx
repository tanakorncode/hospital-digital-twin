'use client';
import { useEffect, useRef, useState } from 'react';
import { ReceptionShell } from '../../components/reception/ReceptionShell';
import { KioskClient, pairFinish, pairStart, saveCredential, savedCredential, type Capabilities, type PairStart } from '../../lib/reception/client';
import { useFacility } from '../../lib/use-facility';

// Digital Reception kiosk (/reception) — a public touch screen, separate from the check-in kiosk (/kiosk). The device
// signs in with its own credential, never with a staff account. Setup: open this page on the kiosk, an administrator
// signs in once and picks this kiosk from the list (or adds it) — the credential goes straight into this browser and
// the administrator's session ends. Pasting a credential from Settings → ตู้ต้อนรับ still works. To set it again, hold
// the bottom-right corner 5 seconds.
type State = {kind:'loading'} | {kind:'setup'; error?:string} | {kind:'closed'; reason:string} | {kind:'ready'; client:KioskClient; caps:Capabilities};

export default function ReceptionPage() {
 useFacility(true); // the hospital's places for directions
 const [state,setState] = useState<State>({kind:'loading'});
 const hold = useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const connect = async (credential:string) => {
  if (!credential) { setState({kind:'setup'}); return; }
  const client = new KioskClient(credential), r = await client.start();
  if (r.ok) { setState({kind:'ready',client,caps:r}); return; }
  client.stop();
  if (r.code==='AUTH_REQUIRED') setState({kind:'setup',error:r.reason});
  else setState({kind:'closed',reason:r.code==='FEATURE_DISABLED' ? 'ตู้ต้อนรับปิดให้บริการชั่วคราว กรุณาติดต่อจุดประชาสัมพันธ์' : r.reason});
 };
 useEffect(()=>{ void connect(savedCredential()); },[]);
 // Closed / offline: try again every minute.
 useEffect(()=>{ if (state.kind!=='closed') return; const t = setTimeout(()=>void connect(savedCredential()),60_000); return ()=>clearTimeout(t); },[state]);
 const corner = <span className="rcpCorner" aria-hidden="true" onPointerDown={()=>{ hold.current = setTimeout(()=>setState({kind:'setup'}),5000); }}
  onPointerUp={()=>clearTimeout(hold.current)} onPointerLeave={()=>clearTimeout(hold.current)}/>;
 if (state.kind==='ready') return <>{<ReceptionShell client={state.client} caps={state.caps}/>}{corner}</>;
 if (state.kind==='setup') return <Setup error={state.error} onSave={c=>{ saveCredential(c); setState({kind:'loading'}); void connect(c); }}/>;
 return <main className="rcp idle"><div className="rcpWelcome"><h1>{state.kind==='loading' ? 'กำลังเตรียมระบบ…' : 'ขออภัย'}</h1>{state.kind==='closed' && <p>{state.reason}</p>}</div>{corner}</main>;
}

function Setup({error,onSave}:{error?:string; onSave:(c:string)=>void}) {
 const [step,setStep] = useState<'login'|'pick'|'paste'>('login');
 const [user,setUser] = useState(''), [pass,setPass] = useState('');
 const [pair,setPair] = useState<PairStart|null>(null);
 const [newName,setNewName] = useState(''), [newAt,setNewAt] = useState('');
 const [busy,setBusy] = useState(false), [err,setErr] = useState(error ?? '');
 const [c,setC] = useState('');
 const login = async () => { setBusy(true); setErr(''); const r = await pairStart(user.trim(),pass); setBusy(false); setPass('');
  if (r.ok) { setPair(r); setStep('pick'); } else setErr(r.reason); };
 const finish = async (body:{kioskId?:string; name?:string; atCode?:string}) => { if (!pair) return; setBusy(true); setErr('');
  const r = await pairFinish({ticket:pair.ticket,...body}); setBusy(false);
  if (r.ok) onSave(r.credential); else { setErr(r.reason); if (r.code==='AUTH_REQUIRED') { setPair(null); setStep('login'); } } };
 const ago = (iso?:string) => { if (!iso) return 'ยังไม่เคยใช้งาน'; const m = Math.round((Date.now()-new Date(iso).getTime())/60000); return m<1 ? 'ใช้งานอยู่ตอนนี้' : m<60 ? `ใช้งานล่าสุด ${m} นาทีที่แล้ว` : m<1440 ? `ใช้งานล่าสุด ${Math.floor(m/60)} ชม.ที่แล้ว` : `ใช้งานล่าสุด ${Math.floor(m/1440)} วันที่แล้ว`; };
 const place = (code?:string) => code ? pair?.places.find(p=>p.code===code)?.nameTh ?? code : 'ยังไม่ระบุจุดที่ตั้ง';
 return <main className="rcp idle rcpSetupPage"><div className="rcpWelcome rcpSetup">
  <h1>ตั้งค่าตู้ต้อนรับ</h1>
  {err && <p className="rcpError" role="alert">{err}</p>}
  {step==='login' && <>
   <p>ผู้ดูแลระบบเข้าสู่ระบบครั้งเดียว แล้วเลือกว่าเครื่องนี้คือตู้ไหน · ตู้จะไม่จำบัญชีผู้ดูแล</p>
   <form className="rcpPairLogin" onSubmit={e=>{ e.preventDefault(); if (user.trim() && pass) void login(); }}>
    <input value={user} onChange={e=>setUser(e.target.value)} placeholder="ชื่อผู้ใช้ผู้ดูแลระบบ" autoComplete="off" spellCheck={false} aria-label="ชื่อผู้ใช้"/>
    <input type="password" value={pass} onChange={e=>setPass(e.target.value)} placeholder="รหัสผ่าน" autoComplete="off" aria-label="รหัสผ่าน"/>
    <button disabled={busy || !user.trim() || !pass}>{busy ? 'กำลังตรวจสอบ…' : 'เข้าสู่ระบบ'}</button>
   </form>
   <button type="button" className="rcpLink" onClick={()=>{ setErr(''); setStep('paste'); }}>มีรหัสตู้อยู่แล้ว (วางรหัส)</button>
  </>}
  {step==='pick' && pair && <>
   <p>เครื่องนี้คือตู้ไหน · {pair.admin}</p>
   <div className="rcpPairList">{pair.kiosks.map(k=><button key={k.id} type="button" disabled={busy} onClick={()=>{
     if (k.online && !window.confirm(`${k.name} กำลังใช้งานอยู่ที่เครื่องอื่น — ถ้าเลือก เครื่องนั้นจะหลุดและต้องตั้งค่าใหม่ ใช้เครื่องนี้แทนใช่ไหม`)) return; void finish({kioskId:k.id}); }}>
     <b>{k.name}</b><small>{place(k.atCode)}</small><em className={k.online?'on':''}>{k.online ? 'ออนไลน์อยู่ที่เครื่องอื่น' : ago(k.lastSeenAt)}</em></button>)}
    {!pair.kiosks.length && <p className="rcpEmpty">ยังไม่มีตู้ในระบบ — เพิ่มตู้ใหม่ด้านล่าง</p>}</div>
   <form className="rcpPairNew" onSubmit={e=>{ e.preventDefault(); if (newName.trim()) void finish({name:newName.trim(),atCode:newAt || undefined}); }}>
    <b>หรือเพิ่มเป็นตู้ใหม่</b>
    <input value={newName} maxLength={60} onChange={e=>setNewName(e.target.value)} placeholder="ชื่อตู้ เช่น ตู้ล็อบบี้ OPD ชั้น 1" aria-label="ชื่อตู้ใหม่"/>
    <select value={newAt} onChange={e=>setNewAt(e.target.value)} aria-label="จุดที่ตั้งตู้"><option value="">จุดที่ตั้งตู้ (ไม่บังคับ)</option>{pair.places.map(p=><option key={p.code} value={p.code}>{p.nameTh} · {p.whereTh}</option>)}</select>
    <button disabled={busy || !newName.trim()}>เพิ่มและใช้เครื่องนี้</button>
   </form>
   <button type="button" className="rcpLink" onClick={()=>{ setPair(null); setStep('login'); }}>ยกเลิก</button>
  </>}
  {step==='paste' && <>
   <p>วางรหัสตู้จาก ตั้งค่า → ตู้ต้อนรับ (ทำครั้งเดียวต่อเครื่อง)</p>
   <form onSubmit={e=>{ e.preventDefault(); if (c.trim()) onSave(c.trim()); }}>
    <input value={c} onChange={e=>setC(e.target.value)} placeholder="รหัสตู้ เช่น k-xxxxxxxx.xxxxxxxx" autoComplete="off" spellCheck={false} aria-label="รหัสตู้"/>
    <button disabled={!c.trim()}>บันทึก</button>
   </form>
   <button type="button" className="rcpLink" onClick={()=>{ setErr(''); setStep('login'); }}>ตั้งค่าด้วยบัญชีผู้ดูแลระบบแทน</button>
  </>}
 </div></main>;
}
