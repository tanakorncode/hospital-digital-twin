'use client';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ScanLine, Search, Ticket } from 'lucide-react';
import { fmtDurRange, patientAt, placeText, stepText, type Patient } from '../../lib/patients';
import { applyQueueEvents, basePatients, isLive, stationById, useQueueEvents, worldKey, type QueueEvent } from '../../lib/queue';
import { peopleAhead, waitRange } from '../../lib/queue-status';
import { deptScreen, nowStates, screenDepts } from '../../lib/queue-screen';
import { useDemoClock } from '../../lib/use-demo-clock';

// Queue information on the Digital Reception kiosk, when an administrator allows it (Settings → ตู้ต้อนรับ):
//  • the board — per department / counter: how many wait and which numbers are being called (what the TV screens show);
//  • "คิวของฉัน" — the visitor scans the QR on their own queue slip (the kiosk's barcode reader types it): their number,
//    what to do now, people ahead, the wait. Shown on screen only — never read aloud — and cleared after 30 seconds.
// The same public queue stream as the TV screens; nothing personal (no name, no HN) is in it.
type Feed = {patients:Patient[]; events:QueueEvent[]; m:number|null; resolve:(token:string)=>Promise<{ok:boolean; reason?:string; ticket?:{patientId:string}}>};
const QueueCtx = createContext<Feed|null>(null);
export function QueueFeed({children}:{children:ReactNode}) {
 const { events, settings, visits, resolveTicket } = useQueueEvents();
 const minute = useDemoClock(5000,settings.demoOffset ?? 0);
 const world = worldKey(settings), live = isLive(settings);
 const base = useMemo(()=>basePatients(settings,visits,events),[world,live,live?visits:null,live?events:null]); // eslint-disable-line react-hooks/exhaustive-deps
 const patients = useMemo(()=>applyQueueEvents(base,events),[base,events]);
 const value = useMemo(()=>({patients,events,m:minute===null ? null : Math.floor(minute),resolve:resolveTicket as Feed['resolve']}),[patients,events,minute,resolveTicket]);
 return <QueueCtx.Provider value={value}>{children}</QueueCtx.Provider>;
}

export function QueueBoard({myQueue,openMine,touch}:{myQueue:boolean; openMine:()=>void; touch:()=>void}) {
 const feed = useContext(QueueCtx);
 const [q,setQ] = useState('');
 const list = useMemo(()=>{ if (!feed || feed.m===null) return null; const now = nowStates(feed.patients,feed.m);
  return screenDepts().map(d=>({...d,data:deptScreen(d.name,now,feed.m!)})).filter(x=>x.data && (!q.trim() || x.name.includes(q.trim()))); },[feed,q]);
 return <div className="rcpCard">
  <h2>ภาพรวมคิวตอนนี้</h2>
  {myQueue && <button className="rcpMine" onClick={openMine}><Ticket size={26}/> คิวของฉัน — สแกน QR บนบัตรคิว</button>}
  <label className="rcpSearch"><Search size={24}/><input value={q} onChange={e=>{ touch(); setQ(e.target.value); }} placeholder="ค้นหาแผนก เช่น อายุรกรรม ห้องยา" aria-label="ค้นหาแผนก"/></label>
  {list===null ? <p className="rcpNote">กำลังโหลดข้อมูลคิว…</p> : <div className="rcpBoard">{list.map(({name,where,letter,data})=><section key={name} className={'rcpQ'+(data!.closed?' off':'')}>
   <h3>{letter && <span className="rcpLetter">{letter}</span>}{name}<small>{where}</small></h3>
   {data!.closed ? <p>งดให้บริการวันนี้</p> : <>
    <div className="rcpQNow">{data!.rows.filter(r=>r.calling).slice(0,3).map(r=><b key={r.queue}>เชิญ {r.queue}<small>{r.label}</small></b>)}
     {!data!.rows.some(r=>r.calling) && <span className="rcpNote">ยังไม่มีการเรียก</span>}</div>
    <p className="rcpQWait">รอ <b>{data!.waiting}</b> คน{data!.next.length ? ` · ถัดไป ${data!.next.slice(0,4).join(' ')}` : ''}</p></>}
  </section>)}</div>}
  <p className="rcpNote">ข้อมูลเดียวกับจอเรียกคิว · ไม่แสดงชื่อหรือข้อมูลส่วนตัว</p>
 </div>;
}

// The slip's QR holds the link to the patient's own page (/q/<token>); a plain token is accepted too.
export const ticketToken = (text:string) => { const t = text.trim(); const m = t.match(/\/q\/([A-Za-z0-9_-]{16,128})/); return m ? m[1] : /^[A-Za-z0-9_-]{16,128}$/.test(t) ? t : ''; };
const SHOW_SECONDS = 30;

export function MyQueue({touch,done}:{touch:()=>void; done:()=>void}) {
 const feed = useContext(QueueCtx);
 const [code,setCode] = useState('');
 const [patientId,setPatientId] = useState('');
 const [error,setError] = useState('');
 const [left,setLeft] = useState(SHOW_SECONDS);
 const input = useRef<HTMLInputElement>(null);
 useEffect(()=>{ if (!patientId) input.current?.focus(); },[patientId]);
 // Shown for 30 seconds, then cleared — the next person in line must not see it.
 useEffect(()=>{ if (!patientId) return; setLeft(SHOW_SECONDS);
  const t = setInterval(()=>setLeft(s=>{ if (s<=1) { setPatientId(''); done(); return SHOW_SECONDS; } return s-1; }),1000); return ()=>clearInterval(t); },[patientId,done]);
 const lookUp = async (text:string) => {
  touch(); setError(''); setCode('');
  const token = ticketToken(text);
  if (!token || !feed) { setError('อ่าน QR ไม่ได้ — สแกน QR บนบัตรคิวอีกครั้ง'); return; }
  const r = await feed.resolve(token);
  if (!r.ok || !r.ticket) { setError(r.reason ?? 'ไม่พบคิวนี้ — QR ใช้ได้เฉพาะวันที่รับบัตรคิว'); return; }
  setPatientId(r.ticket.patientId);
 };
 const p = feed && patientId ? feed.patients.find(x=>x.id===patientId) : undefined;
 const m = feed?.m ?? 0, st = p ? patientAt(p,m) : null;
 const ahead = feed && st ? peopleAhead(st,feed.patients,m,feed.events) : undefined;
 const range = feed && st ? waitRange(st,ahead,m,feed.events) : undefined;
 if (!patientId) return <div className="rcpCard rcpScan">
  <ScanLine size={56}/><h2>คิวของฉัน</h2><p>สแกน QR บนบัตรคิวของคุณที่เครื่องอ่านของตู้</p>
  <form onSubmit={e=>{ e.preventDefault(); void lookUp(code); }}><input ref={input} value={code} onChange={e=>setCode(e.target.value)} placeholder="รอสแกน…" aria-label="QR บนบัตรคิว" autoComplete="off"/></form>
  {error && <p className="rcpError" role="alert">{error}</p>}
  <p className="rcpNote">ข้อมูลแสดงบนจอนี้ 30 วินาทีแล้วลบเอง · ไม่อ่านออกเสียง · ดูต่อบนมือถือได้โดยสแกน QR เดียวกันด้วยกล้องมือถือ</p>
 </div>;
 if (!p) return <div className="rcpCard"><p>ไม่พบคิวนี้ในวันนี้ กรุณาสอบถามเจ้าหน้าที่</p></div>;
 const calling = st?.status==='calling', waiting = !!st && m<st.step.called;
 const doText = !st ? (m<p.arrival ? 'ยังไม่ถึงเวลารับบริการ' : 'รับบริการครบแล้ว ขอบคุณที่ใช้บริการ')
  : st.status==='missed' ? 'เรียกคิวแล้วแต่ไม่พบ กรุณาติดต่อเจ้าหน้าที่' : calling ? `ถึงคิวแล้ว เชิญที่ ${stationById(st.step.manual)?.label ?? st.step.place.where}`
  : waiting ? stepText[st.step.kind].wait : stepText[st.step.kind].serve;
 return <div className={'rcpCard rcpMineCard'+(calling?' go':'')}>
  <p className="rcpNote">หมายเลขคิวของคุณ</p><h2 className="rcpMineNo">{p.queue}</h2><p className="rcpWhere">{p.dept}</p>
  <p className="rcpAnswer">{doText}</p>
  {st && !calling && <p className="rcpWhere">{placeText(st,m)}</p>}
  {waiting && !calling && ahead!==undefined && <p className="rcpQWait">{ahead===0 ? 'คุณเป็นคิวถัดไป' : <>ก่อนหน้าคุณ <b>{ahead}</b> คิว</>}{range?.known ? ` · รอประมาณ ${fmtDurRange(range.lo,range.hi)}` : ''}</p>}
  <span className="segBtns"><button onClick={()=>{ setPatientId(''); done(); }}>ซ่อนข้อมูล ({left})</button></span>
 </div>;
}
