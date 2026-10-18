'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { CalendarCheck, CalendarClock, CheckCircle2, ChevronLeft, IdCard, ListOrdered, Map as MapIcon, ShieldCheck, Unlink } from 'lucide-react';
import { Appointments, BookQueue, HospitalMap, MyQueue } from '../../components/LiffViews';
import { loadSession, patientApi, saveSession } from '../../lib/patient-api';
import { useFacility } from '../../lib/use-facility';

// The patient's page inside LINE (LIFF), opened from the hospital's rich menu.
// 1. Sign in: the LIFF SDK gives an ID token, the API checks it with LINE and opens an app session.
//    No LIFF id configured: with the API's test switch on, a "test" sign-in as a made-up LINE user (never real patients).
// 2. Not linked yet: explain why and what is used, then show a one-time QR / code to take to the counter with the ID card.
// 3. Linked: the patient's own menu — my queue, booking, appointments, map (components/LiffViews).
// Big text, high contrast, one thing per screen; nothing personal beyond the HN's last 4 digits.
type Liff = { init:(o:{liffId:string})=>Promise<void>; isLoggedIn:()=>boolean; login:()=>void; getIDToken:()=>string|null; isInClient:()=>boolean };
type Me = {linked:false} | {linked:true; hn:string; linkedAt:string};
type View = 'queue'|'book'|'appts'|'map';
// A rich-menu button opens /liff?view=… straight on that screen (LIFF keeps the query through its sign-in).
const startView = ():View|null => { const v = typeof window==='undefined' ? null : new URLSearchParams(window.location.search).get('view'); return v==='queue'||v==='book'||v==='appts'||v==='map' ? v : null; };
type Stage = {kind:'loading'} | {kind:'error'; text:string} | {kind:'dev'} | {kind:'ready'; me:Me};
const SDK = 'https://static.line-scdn.net/liff/edge/2/sdk.js';

function loadSdk():Promise<Liff> {
 return new Promise((resolve,reject)=>{
  const w = window as unknown as {liff?:Liff};
  if (w.liff) { resolve(w.liff); return; }
  const s = document.createElement('script'); s.src = SDK; s.async = true;
  s.onload = ()=>w.liff ? resolve(w.liff) : reject(new Error('no liff')); s.onerror = ()=>reject(new Error('sdk'));
  document.head.appendChild(s);
 });
}

export default function LiffPage() {
 useFacility(true); // the hospital's departments and places for the map and directions
 const [stage,setStage] = useState<Stage>({kind:'loading'});
 const [linking,setLinking] = useState(false); // the hospital has switched account linking on
 const refresh = useCallback(async ()=>{
  const me = await patientApi<Me>('GET','/me');
  if (me.ok) setStage({kind:'ready',me:me as Me});
  else if (me.code==='AUTH_REQUIRED') setStage({kind:'error',text:'กรุณาเปิดหน้านี้จากเมนูใน LINE อีกครั้ง'});
  else setStage({kind:'error',text:me.reason});
 },[]);
 const signIn = useCallback(async (idToken:string)=>{
  const r = await patientApi<{token:string}>('POST','/line/session',{idToken});
  if (!r.ok) { setStage({kind:'error',text:r.reason}); return; }
  saveSession(r.token); await refresh();
 },[refresh]);
 useEffect(()=>{ void (async ()=>{
  const cfg = await patientApi<{liffId:string|null; devLogin:boolean; linking:boolean}>('GET','/config');
  if (!cfg.ok) { setStage({kind:'error',text:cfg.reason}); return; }
  setLinking(cfg.linking);
  if (loadSession()) { const me = await patientApi<Me>('GET','/me'); if (me.ok) { setStage({kind:'ready',me:me as Me}); return; } }
  if (cfg.liffId) {
   try {
    const liff = await loadSdk(); await liff.init({liffId:cfg.liffId});
    if (!liff.isLoggedIn()) { liff.login(); return; }
    const t = liff.getIDToken();
    if (!t) { setStage({kind:'error',text:'ไม่ได้รับข้อมูลจาก LINE กรุณาเปิดจากเมนูใน LINE อีกครั้ง'}); return; }
    await signIn(t);
   } catch { setStage({kind:'error',text:'เปิด LINE ไม่สำเร็จ กรุณาลองใหม่'}); }
  } else if (cfg.devLogin) setStage({kind:'dev'});
  else setStage({kind:'error',text:'โรงพยาบาลยังไม่ได้เปิดใช้บริการผ่าน LINE'});
 })(); },[signIn]);

 return <main className="liff">
  <header className="liffHead"><span className="liffLogo">+</span><div><b>โรงพยาบาลตัวอย่าง</b><small>บริการผู้ป่วยผ่าน LINE</small></div></header>
  {stage.kind==='loading' && <p className="liffWait">กำลังเปิด…</p>}
  {stage.kind==='error' && <section className="liffCard"><h1>เปิดไม่สำเร็จ</h1><p>{stage.text}</p><button className="liffBtn" onClick={()=>window.location.reload()}>ลองใหม่</button></section>}
  {stage.kind==='dev' && <DevSignIn onSignIn={signIn}/>}
  {stage.kind==='ready' && (stage.me.linked
   ? <Home me={stage.me} onUnlinked={refresh} initial={startView()}/>
   : <LinkFlow enabled={linking} onLinked={refresh}/>)}
 </main>;
}

// Test sign-in (API switch PATIENT_DEV_LOGIN=on, no LIFF id): a made-up LINE user kept in this browser.
function DevSignIn({onSignIn}:{onSignIn:(t:string)=>Promise<void>}) {
 const [busy,setBusy] = useState(false);
 const go = async () => {
  setBusy(true);
  let id = ''; try { id = localStorage.getItem('hdt.devLineUser') ?? ''; } catch { /* ignore */ }
  if (!/^U[0-9a-f]{32}$/.test(id)) { id = 'U'+Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''); try { localStorage.setItem('hdt.devLineUser',id); } catch { /* ignore */ } }
  await onSignIn(`dev:${id}`); setBusy(false);
 };
 return <section className="liffCard dev"><h1>โหมดทดสอบ</h1><p>ยังไม่ได้ตั้งค่า LINE ของโรงพยาบาล · หน้านี้จำลองผู้ใช้ LINE สำหรับทดสอบเท่านั้น ห้ามใช้กับผู้ป่วยจริง</p>
  <button className="liffBtn" disabled={busy} onClick={()=>void go()}>เข้าใช้แบบทดสอบ</button></section>;
}

function LinkFlow({enabled,onLinked}:{enabled:boolean; onLinked:()=>Promise<void>}) {
 const [code,setCode] = useState<{qr:string; code:string; expiresAt:string}|null>(null);
 const [src,setSrc] = useState('');
 const [error,setError] = useState('');
 const [left,setLeft] = useState(0);
 const timer = useRef<ReturnType<typeof setInterval>|undefined>(undefined);
 const start = async () => {
  setError('');
  const r = await patientApi<{qr:string; code:string; expiresAt:string}>('POST','/link/start');
  if (!r.ok) { setError(r.reason); return; }
  setCode(r); setSrc(await QRCode.toDataURL(r.qr,{margin:1,width:280}));
 };
 // While the code is shown: count down, and look every 3 s whether staff have confirmed it.
 useEffect(()=>{
  if (!code) return;
  const tick = async () => {
   const s = Math.max(0,Math.round((new Date(code.expiresAt).getTime()-Date.now())/1000)); setLeft(s);
   if (s<=0) { setCode(null); setError('รหัสหมดเวลาแล้ว กดขอรหัสใหม่ได้'); return; }
   const me = await patientApi<Me>('GET','/me');
   if (me.ok && (me as Me).linked) await onLinked();
  };
  void tick(); timer.current = setInterval(()=>void tick(),3000);
  return ()=>clearInterval(timer.current);
 },[code,onLinked]);
 if (!enabled) return <section className="liffCard"><h1>เชื่อมบัญชีผู้ป่วย</h1><p>โรงพยาบาลยังไม่เปิดให้เชื่อมบัญชีผ่าน LINE · ติดต่อเคาน์เตอร์ลงทะเบียน</p></section>;
 if (code) return <section className="liffCard center"><h1>แสดงหน้าจอนี้ที่เคาน์เตอร์</h1>
  <p>พร้อม <b>บัตรประชาชน</b> · เจ้าหน้าที่จะสแกน QR และตรวจบัตร</p>
  {src && <img className="liffQr" src={src} alt="QR สำหรับเชื่อมบัญชี"/>}
  <p className="liffCode" aria-label="รหัสสำรอง">{code.code}</p>
  <small className="liffNote">ถ้าสแกนไม่ได้ ให้เจ้าหน้าที่พิมพ์รหัสนี้ · หมดเวลาใน {Math.floor(left/60)}:{String(left%60).padStart(2,'0')} นาที</small>
  <small className="liffNote">หน้านี้จะเปลี่ยนเองเมื่อเชื่อมเรียบร้อย</small></section>;
 return <section className="liffCard"><h1>เชื่อมบัญชีผู้ป่วย</h1>
  <p>เชื่อม LINE นี้กับประวัติผู้ป่วยของคุณ เพื่อดูคิว การจอง และนัดหมายของตัวเองได้ในที่เดียว</p>
  <ul className="liffList"><li><ShieldCheck size={20}/> ยืนยันตัวตนที่เคาน์เตอร์ด้วยบัตรประชาชน (ครั้งเดียว)</li>
   <li><IdCard size={20}/> ระบบใช้เพียง HN ของคุณ ไม่ส่งชื่อหรือผลตรวจทาง LINE</li>
   <li><Unlink size={20}/> ยกเลิกการเชื่อมได้ทุกเมื่อจากหน้านี้</li></ul>
  {error && <p className="liffError" role="alert">{error}</p>}
  <button className="liffBtn" onClick={()=>void start()}>ขอรหัสเชื่อมบัญชี</button>
  <small className="liffNote">ไม่สะดวกใช้ LINE? ยังใช้บริการที่เคาน์เตอร์ได้ตามปกติทุกอย่าง</small></section>;
}

function Home({me,onUnlinked,initial}:{me:Extract<Me,{linked:true}>; onUnlinked:()=>Promise<void>; initial:View|null}) {
 const [justLinked] = useState(()=>Date.now()-new Date(me.linkedAt).getTime()<5*60_000);
 const [confirm,setConfirm] = useState(false);
 const [view,setView] = useState<View|null>(initial);
 // The phone's back button closes a screen instead of leaving the page.
 useEffect(()=>{ const back = ()=>setView(null); window.addEventListener('popstate',back); return ()=>window.removeEventListener('popstate',back); },[]);
 const open = (v:View) => { window.history.pushState({view:v},''); setView(v); window.scrollTo(0,0); };
 const unlink = async () => { const r = await patientApi('POST','/link/unlink'); if (r.ok) await onUnlinked(); };
 const tiles:[View,typeof ListOrdered,string,string][] = [['queue',ListOrdered,'คิวของฉัน','ดูลำดับและเวลารอ'],['book',CalendarCheck,'จองคิว','จองล่วงหน้า'],['appts',CalendarClock,'นัดหมาย','ดู · ขอเลื่อน · ยกเลิก'],['map',MapIcon,'แผนที่','ทางไปจุดบริการ']];
 if (view) { const t = tiles.find(x=>x[0]===view)!;
  return <><div className="liffBar"><button className="liffBack" onClick={()=>{ if ((window.history.state as {view?:View}|null)?.view) window.history.back(); else setView(null); }}><ChevronLeft size={24}/> เมนู</button><h1>{t[2]}</h1></div>
   {view==='queue' ? <MyQueue/> : view==='book' ? <BookQueue/> : view==='appts' ? <Appointments/> : <HospitalMap/>}</>; }
 return <>
  {justLinked && <section className="liffCard ok"><CheckCircle2 size={32}/><h1>เชื่อมบัญชีเรียบร้อย</h1></section>}
  <section className="liffCard"><p className="liffWho">ผู้ป่วย HN <b>{me.hn}</b></p>
   <div className="liffTiles">{tiles.map(([v,I,t,s])=><button key={v} className="liffTile" onClick={()=>open(v)}><I size={30}/><b>{t}</b><small>{s}</small></button>)}</div></section>
  <section className="liffCard muted">{confirm
   ? <><p>ยกเลิกการเชื่อมบัญชี? ครั้งหน้าต้องยืนยันตัวตนที่เคาน์เตอร์ใหม่</p><div className="liffRow"><button className="liffBtn ghost" onClick={()=>setConfirm(false)}>ไม่ยกเลิก</button><button className="liffBtn danger" onClick={()=>void unlink()}>ยกเลิกการเชื่อม</button></div></>
   : <button className="liffLink" onClick={()=>setConfirm(true)}><Unlink size={16}/> ยกเลิกการเชื่อมบัญชี</button>}</section>
 </>;
}
