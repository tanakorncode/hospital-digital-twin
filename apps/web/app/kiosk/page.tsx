'use client';
import { useEffect, useRef, useState } from 'react';
import { Delete, LogIn } from 'lucide-react';
import { CheckInCard, type CheckInResult } from '../../components/CheckInCard';
import { LoginScreen } from '../../components/LoginScreen';
import { applyWorld, canDo, isLive, useQueueEvents } from '../../lib/queue';

// Self check-in kiosk for patients who booked ahead or have a doctor's appointment (/kiosk). The kiosk is signed in once
// with a staff account; the patient types — or scans with the kiosk's barcode reader, which types too — the code
// (BK + 6 for a booking, AP + 6 for an appointment) and gets
// a queue number, where to wait and the QR of their own queue page. Inside the check-in window only; otherwise the
// screen sends them to the counter. Big keys, high contrast, nothing personal on screen.
const KEYS = 'ACDEFGHJKLMNPQRTUVWXY3479'.split('');
const RESET_SECONDS = 45;

export default function KioskPage() {
 const sync = useQueueEvents();
 const [kind,setKind] = useState<'BK'|'AP'>('BK');
 const [code,setCode] = useState(''); // the 6 characters after the prefix
 const [busy,setBusy] = useState(false);
 const [error,setError] = useState('');
 const [result,setResult] = useState<CheckInResult|null>(null);
 const [left,setLeft] = useState(RESET_SECONDS);
 const input = useRef<HTMLInputElement>(null);
 useEffect(()=>{ applyWorld(sync.settings); },[sync.settings]);
 // Back to the start screen on its own, so the next patient never sees the previous one's number.
 useEffect(()=>{ if (!result) return; setLeft(RESET_SECONDS); const t = setInterval(()=>setLeft(s=>{ if (s<=1) { reset(); return RESET_SECONDS; } return s-1; }),1000); return ()=>clearInterval(t); },[result]); // eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{ if (!result) input.current?.focus(); },[result,sync.user]);
 const reset = () => { setResult(null); setCode(''); setError(''); setKind('BK'); };
 // A barcode reader types the whole code (BK… / AP…): it sets the kind; the keypad types the 6 characters.
 const typed = (v:string) => { setError(''); let x = v.toUpperCase().replace(/[^A-Z0-9]/g,'');
  if (/^(BK|AP)/.test(x) && x.length>6) { setKind(x.slice(0,2) as 'BK'|'AP'); x = x.slice(2); }
  setCode(x.slice(0,6)); };
 const full = `${kind}${code}`;
 const submit = async () => {
  if (busy || full.length!==8) return;
  setBusy(true); setError('');
  const now = new Date();
  const r = await sync.api<CheckInResult>('checkin:code',{code:full,channel:'KIOSK',at:now.getHours()*60+now.getMinutes()});
  setBusy(false);
  if (r.ok) setResult(r); else setError(r.reason ?? 'เช็กอินไม่สำเร็จ กรุณาติดต่อเคาน์เตอร์');
 };
 if (sync.online && sync.authReady && !sync.user) return <LoginScreen login={sync.login}/>;
 if (!sync.online || !sync.authReady) return <main className="kiosk"><p className="kioskWait">กำลังเชื่อมต่อระบบ…</p></main>;
 if (!canDo(sync.user,'staff')) return <main className="kiosk"><p className="kioskWait">บัญชีนี้ใช้ตู้เช็กอินไม่ได้</p></main>;
 if (!isLive(sync.settings)) return <main className="kiosk"><p className="kioskWait">ตู้เช็กอินพร้อมใช้เมื่อเปิดโหมดผู้ป่วยจริง</p></main>;
 return <main className="kiosk">
  <header className="kioskHead"><h1>เช็กอิน · จองคิวล่วงหน้า / นัดแพทย์</h1><p>มาถึงแล้ว? ใส่รหัส หรือสแกนบาร์โค้ดจากใบนัด / LINE</p></header>
  {result ? <section className="kioskDone">
   <CheckInCard r={result} big/>
   <div className="kioskActs"><button className="kBtn ghost" onClick={()=>window.print()}>พิมพ์บัตรคิว</button><button className="kBtn" onClick={reset}>เสร็จ · คนถัดไป ({left})</button></div>
  </section> : <section className="kioskForm">
   <div className="kioskKind" role="radiogroup" aria-label="ประเภทรหัส">
    <button role="radio" aria-checked={kind==='BK'} className={kind==='BK'?'on':''} onClick={()=>{ setKind('BK'); input.current?.focus(); }}><b>BK</b> จองคิวล่วงหน้า</button>
    <button role="radio" aria-checked={kind==='AP'} className={kind==='AP'?'on':''} onClick={()=>{ setKind('AP'); input.current?.focus(); }}><b>AP</b> นัดแพทย์</button></div>
   <label className="kioskCode"><span>{kind}</span><input ref={input} value={code} inputMode="none" autoComplete="off" spellCheck={false} aria-label={`รหัส 6 ตัวหลัง ${kind}`}
    onChange={e=>typed(e.target.value)} onKeyDown={e=>{ if (e.key==='Enter') void submit(); }}/></label>
   {error && <p className="kioskError" role="alert">{error}</p>}
   <div className="kioskKeys">{KEYS.map(k=><button key={k} onClick={()=>typed(code+k)}>{k}</button>)}
    <button className="del" aria-label="ลบ" onClick={()=>typed(code.slice(0,-1))}><Delete size={30}/></button></div>
   <button className="kBtn go" disabled={busy || full.length!==8} onClick={()=>void submit()}><LogIn size={28}/> {busy?'กำลังตรวจสอบ…':'เช็กอิน'}</button>
   <p className="kioskHelp">ไม่มีรหัส หรือมีปัญหา · ติดต่อเคาน์เตอร์ลงทะเบียน</p>
  </section>}
 </main>;
}
