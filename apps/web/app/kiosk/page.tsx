'use client';
import { useEffect, useRef, useState } from 'react';
import { Delete, LogIn } from 'lucide-react';
import { CheckInCard, type CheckInResult } from '../../components/CheckInCard';
import { LoginScreen } from '../../components/LoginScreen';
import { applyWorld, canDo, isLive, useQueueEvents } from '../../lib/queue';

// Self check-in kiosk for patients who booked ahead (/kiosk). The kiosk is signed in once with a staff account; the
// patient types — or scans with the kiosk's barcode reader, which types too — the booking code (BK + 6) and gets
// a queue number, where to wait and the QR of their own queue page. Inside the check-in window only; otherwise the
// screen sends them to the counter. Big keys, high contrast, nothing personal on screen.
const KEYS = 'ACDEFGHJKLMNPQRTUVWXY3479'.split('');
const RESET_SECONDS = 45;

export default function KioskPage() {
 const sync = useQueueEvents();
 const [code,setCode] = useState('');
 const [busy,setBusy] = useState(false);
 const [error,setError] = useState('');
 const [result,setResult] = useState<CheckInResult|null>(null);
 const [left,setLeft] = useState(RESET_SECONDS);
 const input = useRef<HTMLInputElement>(null);
 useEffect(()=>{ applyWorld(sync.settings); },[sync.settings]);
 // Back to the start screen on its own, so the next patient never sees the previous one's number.
 useEffect(()=>{ if (!result) return; setLeft(RESET_SECONDS); const t = setInterval(()=>setLeft(s=>{ if (s<=1) { reset(); return RESET_SECONDS; } return s-1; }),1000); return ()=>clearInterval(t); },[result]); // eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{ if (!result) input.current?.focus(); },[result,sync.user]);
 const reset = () => { setResult(null); setCode(''); setError(''); };
 const typed = (v:string) => { setError(''); setCode(v.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8)); };
 const full = code.startsWith('BK') ? code : `BK${code}`;
 const submit = async () => {
  if (busy || full.length!==8) return;
  setBusy(true); setError('');
  const now = new Date();
  const r = await sync.api<CheckInResult>('checkin:booking',{code:full,channel:'KIOSK',at:now.getHours()*60+now.getMinutes()});
  setBusy(false);
  if (r.ok) setResult(r); else setError(r.reason ?? 'เช็กอินไม่สำเร็จ กรุณาติดต่อเคาน์เตอร์');
 };
 if (sync.online && sync.authReady && !sync.user) return <LoginScreen login={sync.login}/>;
 if (!sync.online || !sync.authReady) return <main className="kiosk"><p className="kioskWait">กำลังเชื่อมต่อระบบ…</p></main>;
 if (!canDo(sync.user,'staff')) return <main className="kiosk"><p className="kioskWait">บัญชีนี้ใช้ตู้เช็กอินไม่ได้</p></main>;
 if (!isLive(sync.settings)) return <main className="kiosk"><p className="kioskWait">ตู้เช็กอินพร้อมใช้เมื่อเปิดโหมดผู้ป่วยจริง</p></main>;
 return <main className="kiosk">
  <header className="kioskHead"><h1>เช็กอิน สำหรับผู้ที่จองคิวล่วงหน้า</h1><p>มาถึงแล้ว? ใส่รหัสจอง หรือสแกนบาร์โค้ดจากใบจอง / LINE</p></header>
  {result ? <section className="kioskDone">
   <CheckInCard r={result} big/>
   <div className="kioskActs"><button className="kBtn ghost" onClick={()=>window.print()}>พิมพ์บัตรคิว</button><button className="kBtn" onClick={reset}>เสร็จ · คนถัดไป ({left})</button></div>
  </section> : <section className="kioskForm">
   <label className="kioskCode"><span>BK</span><input ref={input} value={full.slice(2)} inputMode="none" autoComplete="off" spellCheck={false} aria-label="รหัสจอง 6 ตัวหลัง BK"
    onChange={e=>typed(e.target.value.toUpperCase().startsWith('BK') ? e.target.value : `BK${e.target.value}`)} onKeyDown={e=>{ if (e.key==='Enter') void submit(); }}/></label>
   {error && <p className="kioskError" role="alert">{error}</p>}
   <div className="kioskKeys">{KEYS.map(k=><button key={k} onClick={()=>typed(full+k)}>{k}</button>)}
    <button className="del" aria-label="ลบ" onClick={()=>typed(full.slice(0,-1))}><Delete size={30}/></button></div>
   <button className="kBtn go" disabled={busy || full.length!==8} onClick={()=>void submit()}><LogIn size={28}/> {busy?'กำลังตรวจสอบ…':'เช็กอิน'}</button>
   <p className="kioskHelp">ไม่มีรหัสจอง หรือมีปัญหา · ติดต่อเคาน์เตอร์ลงทะเบียน</p>
  </section>}
 </main>;
}
