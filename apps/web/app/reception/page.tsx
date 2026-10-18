'use client';
import { useEffect, useRef, useState } from 'react';
import { ReceptionShell } from '../../components/reception/ReceptionShell';
import { KioskClient, saveCredential, savedCredential, type Capabilities } from '../../lib/reception/client';
import { useFacility } from '../../lib/use-facility';

// Digital Reception kiosk (/reception) — a public touch screen, separate from the check-in kiosk (/kiosk). The device
// signs in with its own credential (Settings → ตู้ต้อนรับ), never with a staff account. Setup: open this page on the
// kiosk, paste the credential once; it stays in this browser. To set it again, hold the bottom-right corner 5 seconds.
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
 const [c,setC] = useState('');
 return <main className="rcp idle"><div className="rcpWelcome rcpSetup">
  <h1>ตั้งค่าตู้ต้อนรับ</h1>
  <p>ผู้ดูแลระบบ: สร้างตู้ที่ ตั้งค่า → ตู้ต้อนรับ แล้ววางรหัสตู้ที่ได้ที่นี่ (ทำครั้งเดียวต่อเครื่อง)</p>
  {error && <p className="rcpError" role="alert">{error}</p>}
  <form onSubmit={e=>{ e.preventDefault(); if (c.trim()) onSave(c.trim()); }}>
   <input value={c} onChange={e=>setC(e.target.value)} placeholder="รหัสตู้ เช่น k-xxxxxxxx.xxxxxxxx" autoComplete="off" spellCheck={false} aria-label="รหัสตู้"/>
   <button disabled={!c.trim()}>บันทึก</button>
  </form>
 </div></main>;
}
