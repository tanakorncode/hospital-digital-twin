'use client';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { Bell, BellOff, BellRing, ChevronRight, FlaskConical, HandHelping, ListChecks, Pill, Route, UsersRound } from 'lucide-react';
import { etaOf, fmtDurRange, fmtMin, knownUntil, patientAt, patientToken, placeText, statusColor, stepText } from '../../../lib/patients';
import { useDemoClock } from '../../../lib/use-demo-clock';
import { peopleAhead, waitRange } from '../../../lib/queue-status';
import { PORTER_TOPIC, applyQueueEvents, basePatients, helpRequests, helpTopics, isLive, moveNote, scopeName, stationById, stepGroup, useQueueEvents, worldKey } from '../../../lib/queue';
import type { Step } from '../../../lib/patients';
import FloorPlanSvg, { liftSpot } from '../../../components/FloorPlanSvg';
import { fBuilding } from '../../../lib/facility';

// Patient-facing status page opened from the QR on the queue slip. Shows only the queue number, clinic and journey —
// never the HN or a name — and refreshes by itself. The token is checked by the API (random, expires at the end of the
// day); a family link is a separate read-only token made from the patient's page.
type Note = {key:string; at:number; title:string; body:string};
const loadJson = <T,>(k:string, d:T):T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const saveJson = (k:string, v:unknown) => { try { localStorage.setItem(k,JSON.stringify(v)); } catch { /* ignore */ } };
// useSearchParams needs a Suspense boundary in the app router.
export default function QueueStatusPageRoute() { return <Suspense fallback={<QsLoading/>}><QueueStatusPage/></Suspense>; }
// Shown straight from the server while the page's script loads (slow phones / tunnels), instead of a blank screen.
function QsLoading() {
  return <main className="qs"><section className="qsCard qsLoading" aria-busy="true">
    <div className="qsHero"><div><p className="qsLabel">หมายเลขคิวของคุณ</p><h1 className="qsQueue qsSkel">····</h1><p className="qsDept">กำลังโหลดข้อมูลคิว…</p></div><span className="qsSpinner" aria-hidden/></div>
    <div className="qsDo"><span className="qsSkelLine"/><span className="qsSkelLine short"/></div>
    <p className="qsFoot">กำลังเชื่อมต่อระบบคิว · ถ้ารอนาน ลองรีเฟรชหน้านี้</p></section></main>;
}
function QueueStatusPage() {
  const { token } = useParams<{token:string}>();
  const params = useSearchParams();
  const { events, send, settings, online, resolveTicket, familyTicket, features, lineLink, visits } = useQueueEvents();
  const [lineCode,setLineCode] = useState<{code:string; url:string}|null>(null);
  // Who this link belongs to: the API's answer, or — when the API can't be reached (local demo) — the offline demo link.
  const [ticket,setTicket] = useState<{patientId?:string; kind?:'patient'|'family'; expiresAt?:string; error?:string; offline?:boolean}|null>(null);
  useEffect(()=>{
    if (online) { void resolveTicket(token).then(r=>setTicket(r.ok && r.ticket ? {patientId:r.ticket.patientId,kind:r.ticket.kind,expiresAt:r.ticket.expiresAt} : {error:r.reason ?? 'ไม่พบคิวนี้'})); return; }
    const t = setTimeout(()=>setTicket(x=>x ?? {offline:true}),5000); return ()=>clearTimeout(t);
  },[online,token,resolveTicket]);
  const family = ticket?.kind==='family';
  const minute = useDemoClock(15000,settings.demoOffset ?? 0);
  const world = worldKey(settings);
  const liveData = isLive(settings);
  const all = useMemo(()=>basePatients(settings,visits,events),[world,liveData,liveData?visits:null,liveData?events:null]); // eslint-disable-line react-hooks/exhaustive-deps
  const patients = useMemo(()=>applyQueueEvents(all,events),[all,events]);
  const patient = ticket?.patientId ? patients.find(p=>p.id===ticket.patientId) : ticket?.offline ? patients.find(p=>patientToken(p)===token) : undefined;
  const [notify,setNotify] = useState(false);
  const [notes,setNotes] = useState<Note[]>([]);
  const [toast,setToast] = useState<Note|null>(null);
  const [sheet,setSheet] = useState<null|'map'|'steps'|'notes'|'help'>(null);
  const seen = useRef<Set<string>>(new Set());
  useEffect(()=>{ setNotify(loadJson(`hdt.notify.${token}`,false)); const n = loadJson<Note[]>(`hdt.notes.${token}`,[]); setNotes(n); seen.current = new Set(n.map(x=>x.key)); },[token]);
  const m = minute===null ? 0 : Math.floor(minute), st = patient && minute!==null ? patientAt(patient,m) : null;
  // People ahead in the same queue (what the station console would call next), and the estimate as a range.
  const ahead = useMemo(()=>peopleAhead(st,patients,m,events),[st,patients,m,events]);
  // Notifications: what the LINE Official Account would push (here: on this page, and the browser's own notice if allowed).
  useEffect(()=>{
    if (!st || !patient || family) return;
    const where = st.step.place.where, out:Note[] = [], steps0 = patient.steps;
    if (st.status==='calling') out.push({key:`call-${st.index}-${st.step.calls?.length ?? 0}`,at:m,title:`คิว ${patient.queue} ถึงคิวคุณแล้ว`,body:`เชิญที่ ${stationById(st.step.manual)?.label ?? where}`});
    else if (ahead!==undefined && ahead>0 && ahead<=3) out.push({key:`near-${st.index}`,at:m,title:`คิว ${patient.queue} อีก ${ahead} คิวจะถึงคุณ`,body:`กรุณากลับมารอที่ ${where}`});
    if (m<st.step.called && st.step.movedFrom && st.step.assigned) out.push({key:`move-${st.index}-${st.step.assigned}`,at:m,title:`คิว ${patient.queue} ย้ายจุดบริการ`,body:moveNote(stationById(st.step.movedFrom),stationById(st.step.assigned)!)});
    if (st.step.kind==='pharmacy' && st.step.ready!==undefined && (minute ?? 0)>=st.step.ready && m<st.step.called) out.push({key:`rx-${st.index}`,at:m,title:`คิว ${patient.queue} ยาพร้อมแล้ว`,body:'กรุณามารอที่ห้องยา ชั้น 1 · จะเรียกตามคิว'});
    if (st.step.kind==='followup' && steps0[st.index-1]?.kind==='labResult') out.push({key:`lab-${st.index}`,at:m,title:`คิว ${patient.queue} ผลแล็บออกแล้ว`,body:`รอพบแพทย์ฟังผลที่ ${where}`});
    const porter = helpRequests(events).filter(h=>h.report.patientId===patient.id && h.report.reason===PORTER_TOPIC && h.assigned && !h.closed).at(-1);
    if (porter) out.push({key:`porter-${porter.report.id}`,at:m,title:'ผู้ช่วยกำลังไปหาคุณ',body:`${porter.assigned!.reason!.slice(7)} กำลังไปพร้อมรถเข็น · กรุณารออยู่ที่เดิม`});
    if (st.index>0 && m<st.step.called && st.status!=='calling') out.push({key:`step-${st.index}`,at:m,title:`คิว ${patient.queue} ขั้นต่อไป`,body:`${stepText[st.step.kind].wait} ที่ ${where}`});
    const fresh = out.filter(n=>!seen.current.has(n.key));
    if (!fresh.length) return;
    fresh.forEach(n=>seen.current.add(n.key));
    setNotes(prev=>{ const next = [...fresh,...prev].slice(0,12); saveJson(`hdt.notes.${token}`,next); return next; });
    setToast(fresh[0]);
    if (notify && 'Notification' in window && Notification.permission==='granted') fresh.forEach(n=>{ try { new Notification(n.title,{body:n.body,tag:n.key}); } catch { /* some browsers need a service worker */ } });
    if (notify) navigator.vibrate?.(fresh.some(n=>n.key.startsWith('call'))?[300,120,300]:200);
  },[st?.status,st?.index,ahead,st?.step.assigned,notify,(minute ?? 0)>=(st?.step.ready ?? Infinity),events.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{ if (!toast) return; const t = setTimeout(()=>setToast(null),8000); return ()=>clearTimeout(t); },[toast]);
  if (minute===null || !ticket) return <QsLoading/>;
  if (ticket.error) return <main className="qs"><section className="qsCard"><h1>{ticket.error}</h1><p>QR ใช้ได้เฉพาะวันที่รับบัตรคิว · ถ้าบัตรหายหรือมีการออกบัตรใหม่ ลิงก์เดิมจะใช้ไม่ได้ · กรุณาติดต่อจุดประชาสัมพันธ์{family?'':' หรือขอลิงก์ใหม่จากผู้ป่วย (สำหรับญาติ)'}</p></section></main>;
  if (!patient) return <main className="qs"><section className="qsCard"><h1>ไม่พบคิวนี้</h1><p>QR อาจหมดอายุแล้ว (ใช้ได้เฉพาะวันที่รับบัตรคิว) กรุณาติดต่อจุดประชาสัมพันธ์</p></section></main>;
  const steps = patient.steps, current = st?.index ?? (m<patient.arrival ? -1 : steps.length);
  // Wayfinding, always: where to wait now (from the counter they just left), the room calling them (from their
  // waiting area), or — while being seen — where the next step waits. The start is the last place we know they were.
  const way = st ? wayOf(st,steps,placeText(st,m)) : undefined;
  const known = knownUntil(patient,m), waiting = !!st && m<st.step.called, eta = st ? etaOf(st,m) : 0, next = current+1<=known ? steps[current+1] : undefined;
  // Estimate from the queue itself when we know the position (lib/queue-status.ts, shared with the reception kiosk).
  const { center, lo, hi } = st ? waitRange(st,ahead,m,events) : { center:eta, lo:0, hi:2 };
  // Help request: goes to the station (or queue) the patient is waiting for, as a short topic — never free text.
  const myReports = events.filter(e=>e.action==='report' && e.patientId===patient.id).sort((x,y)=>y.at-x.at), lastReport = myReports[0];
  const lastHelp = lastReport ? helpRequests(events).find(h=>h.report.id===lastReport.id) : undefined, resolved = lastHelp?.closed, assignedTo = lastHelp?.assigned?.reason?.slice(7);
  const askHelp = async (topic:string) => { if (!st) return; setSheet(null);
    // A step without a queue of its own (waiting for a lab result): the clinic's exam rooms see to it, else registration.
    const where = st.step.manual ?? st.step.assigned ?? st.step.stationId ?? `group:${stepGroup(st) ?? (patient.clinicKey ? `exam:${patient.clinicKey}` : 'counter:registration')}`;
    const r = await send({action:'report',at:m,station:where,patientId:patient.id,step:st.index,reason:topic,by:'ผู้ป่วย',ticket:token});
    setToast({key:'help',at:m,title:r.ok?'ส่งเรื่องถึงเจ้าหน้าที่แล้ว':'ส่งไม่สำเร็จ',body:r.ok?`${topic} · ${scopeName(where.replace(/^group:/,''))}`:r.reason ?? ''}); };
  const shareFamily = async () => {
    // A separate read-only token for family (the API refuses to make one from a family link).
    const r:{ok:boolean; reason?:string; ticket?:{token:string; expiresAt?:string}} = ticket.offline ? {ok:true,ticket:{token}} : await familyTicket(token);
    if (!r.ok || !r.ticket) { setToast({key:'share',at:m,title:'สร้างลิงก์ไม่สำเร็จ',body:r.reason ?? ''}); return; }
    const q = new URLSearchParams(); ['demoStart','hour'].forEach(k=>{ const v = params.get(k); if (v!==null) q.set(k,v); });
    const url = `${window.location.origin}/q/${r.ticket.token}${q.toString()?`?${q}`:''}`;
    const until = r.ticket.expiresAt ? new Date(r.ticket.expiresAt).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'}) : '23:59';
    try { if (navigator.share) { await navigator.share({title:`ติดตามคิว ${patient.queue}`,url}); setToast({key:'share',at:m,title:'ส่งลิงก์ให้ญาติแล้ว',body:`ญาติเห็นเฉพาะเลขคิว ขั้นตอน และเส้นทาง · ใช้ได้ถึง ${until} น.`}); return; } } catch { /* cancelled */ }
    try { await navigator.clipboard.writeText(url); setToast({key:'share',at:m,title:'คัดลอกลิงก์ให้ญาติแล้ว',body:`วางใน LINE ได้เลย · ญาติเห็นเฉพาะเลขคิว ขั้นตอน และเส้นทาง · ใช้ได้ถึง ${until} น.`}); } catch { setToast({key:'share',at:m,title:'ลิงก์สำหรับญาติ',body:url}); }
  };
  const enableNotify = async () => {
    const on = !notify; setNotify(on); saveJson(`hdt.notify.${token}`,on);
    if (on && 'Notification' in window && Notification.permission==='default') { try { await Notification.requestPermission(); } catch { /* ignore */ } }
  };
  // What to do now, in one sentence; everything else opens on demand (bottom sheets).
  const calling = st?.status==='calling', moved = !!st && waiting && !!st.step.movedFrom && !!st.step.assigned && !calling;
  const walk = way?.from && (way.from.b!==way.to.b || way.from.level!==way.to.level || Math.hypot(way.from.x-way.to.x,way.from.z-way.to.z)>3);
  const showMapInline = !!way && (calling || moved || !!walk);
  const stepList = steps.slice(0,known+1).filter(s=>s.kind!=='leave'), stepNo = Math.min(stepList.length,Math.max(1,current+1));
  const doText = !st ? (m<patient.arrival ? 'ยังไม่ถึงเวลารับบริการ' : 'รับบริการครบแล้ว ขอบคุณที่ใช้บริการ')
    : st.status==='missed' ? 'เรียกคิวแล้วแต่ไม่พบ กรุณาติดต่อจุดซักประวัติ'
    : calling ? `เดินไปที่ ${stationById(st.step.manual)?.label ?? st.step.place.where}`
    : waiting ? `${stepText[st.step.kind].wait}` : stepText[st.step.kind].serve;
  const helpText = lastReport ? (resolved ? `เจ้าหน้าที่รับเรื่อง "${lastReport.reason}" แล้ว` : assignedTo ? `${assignedTo} กำลังไปหาคุณพร้อมรถเข็น · รออยู่ที่เดิม` : `ส่งเรื่อง "${lastReport.reason}" แล้ว · รอเจ้าหน้าที่`) : '';
  const who = family ? 'ผู้ป่วย' : 'คุณ';
  return <main className="qs">
    {toast && <div className={'qsToast'+(toast.key.startsWith('call')?' call':toast.key==='help'||toast.key.startsWith('porter')?' help':'')} role="alert" onClick={()=>setToast(null)}>
      <span className="qsToastIco">{toast.key.startsWith('call') ? <BellRing size={20}/> : toast.key==='help'||toast.key.startsWith('porter') ? <HandHelping size={20}/> : <Bell size={20}/>}</span>
      <span className="qsToastText"><b>{toast.title}</b><span>{toast.body}</span></span><small>แตะเพื่อปิด</small></div>}
    <section className="qsCard">
      {family && <p className="qsFamily">มุมมองญาติ · ดูได้อย่างเดียว · ลิงก์ใช้ได้ถึง {ticket.expiresAt ? new Date(ticket.expiresAt).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'}) : '23:59'} น.</p>}
      <div className="qsHero">
        <div><p className="qsLabel">หมายเลขคิว{family?'ของผู้ป่วย':'ของคุณ'}</p><h1 className="qsQueue">{patient.queue}</h1><p className="qsDept">{patient.dept}</p></div>
        {st && <div className="qsRingWrap"><Ring progress={!waiting ? 1 : Math.min(0.97,Math.max(0.05,st.stepWait/(st.stepWait+Math.max(1,center))))}
          label={calling ? 'ถึงคิว' : !waiting ? 'กำลังรับ' : ahead!==undefined ? (ahead===0?'ถัดไป':`อีก ${ahead}`) : 'รอ'} sub={waiting && ahead!==undefined && ahead>0 ? 'คิว' : !waiting && !calling ? 'บริการ' : ''} calling={calling}/>
          {waiting && !calling && st.status!=='missed' && (eta>0 || ahead!==undefined) && <small>~{fmtDurRange(lo,hi)}</small>}</div>}
      </div>
      {calling && <div className="qsCalling" role="alert">ถึงคิว{who}แล้ว<br/><b>เชิญที่ {stationById(st!.step.manual)?.label}</b></div>}
      <div className={'qsDo'+(st?.status==='missed'?' warn':calling?' go':'')}>
        <b>{doText}</b>
        {st && !calling && <span>{placeText(st,m)}</span>}
        {moved && <span className="qsTag">คิวย้ายมาจาก {stationById(st!.step.movedFrom)?.label} · ลำดับเดิม · {moveNote(stationById(st!.step.movedFrom),stationById(st!.step.assigned)!).split(' · ')[0]}</span>}
        {st?.step.kind==='pharmacy' && waiting && st.step.ready!==undefined && <span className={'qsRx'+(minute>=st.step.ready?' ok':'')}><Pill size={15}/>{minute>=st.step.ready ? 'ยาพร้อมแล้ว · รอเรียกที่ช่องจ่ายยา' : `กำลังจัดยา · พร้อมประมาณ ${fmtMin(Math.ceil(st.step.ready))} น.`}</span>}
        {st?.step.kind==='labResult' && <span className="qsRx"><FlaskConical size={15}/>รอผลแล็บ · คาดว่าออกประมาณ {fmtMin(st.step.end)} น. · ไปทำธุระได้ ระบบจะแจ้ง</span>}
        {waiting && !calling && <small>เวลาเป็นค่าประมาณ อาจเปลี่ยนตามจำนวนผู้ป่วยและเวลาตรวจของแพทย์</small>}
      </div>
      {showMapInline && way && <WayFinder way={way}/>}
      {helpText && <button className={'qsStrip'+(resolved||assignedTo?' ok':' wait')} onClick={()=>setSheet('help')}><HandHelping size={17}/><span className="qsStripText">{helpText}</span><ChevronRight size={17} className="qsChev"/></button>}
      {notes[0] && <button className="qsStrip" onClick={()=>setSheet('notes')}><span className="lineIcon">LINE</span><span className="qsStripText">{notes[0].title} · {fmtMin(notes[0].at)}</span>{notes.length>1 && <em>+{notes.length-1}</em>}<ChevronRight size={17} className="qsChev"/></button>}
      {stepList.length>0 && <button className="qsProgress" onClick={()=>setSheet('steps')}>
        <span className="qsDots">{stepList.map((_,i)=><i key={i} className={i<current?'done':i===current?'now':''}/>)}</span>
        <span className="qsProgText"><b>ขั้นที่ {stepNo} จาก {stepList.length}</b>{next && next.kind!=='leave' ? ` · ถัดไป: ${stepText[next.kind].serve}` : current>=steps.length ? ' · เสร็จครบ' : ' · ขั้นต่อไปจะแจ้งหลังแพทย์สั่ง'}</span><ChevronRight size={17} className="qsChev"/></button>}
      <div className="qsActions">
        <button className="t-route" onClick={()=>setSheet('map')} disabled={!way}><span className="qsIco"><Route size={22}/></span>เส้นทาง</button>
        {!family && <button className={'t-bell'+(notify?' on':'')} onClick={()=>setSheet('notes')}><span className="qsIco">{notify?<BellRing size={22}/>:<BellOff size={22}/>}</span>{notify?'แจ้งเตือนเปิด':'แจ้งเตือน'}</button>}
        {!family && <button className="t-family" onClick={()=>void shareFamily()}><span className="qsIco"><UsersRound size={22}/></span>ญาติติดตาม</button>}
        {!family && st && st.step.kind!=='leave' && <button className="t-help" onClick={()=>setSheet('help')}><span className="qsIco"><HandHelping size={22}/></span>ขอช่วยเหลือ</button>}
        {family && <button className="t-steps" onClick={()=>setSheet('steps')}><span className="qsIco"><ListChecks size={22}/></span>ขั้นตอน</button>}
      </div>
      <p className="qsFoot">อัปเดตอัตโนมัติ · {fmtMin(m)} น.{liveData?'':' · ข้อมูลจำลอง'}<br/>{family?'ลิงก์นี้ไม่แสดงชื่อ HN หรือผลการรักษา':'ไม่ต้องนั่งรอหน้าห้อง ระบบจะแจ้งเมื่อใกล้ถึงคิว'}</p>
    </section>

    {sheet && <div className="qsSheetBack" onClick={()=>setSheet(null)}>
      <div className="qsSheet" role="dialog" aria-modal="true" onClick={e=>e.stopPropagation()}>
        <span className="qsHandle"/>
        <header><b>{({map:'เส้นทาง',steps:'ขั้นตอนการรับบริการ',notes:'การแจ้งเตือน',help:'ขอความช่วยเหลือ'} as const)[sheet]}</b><button onClick={()=>setSheet(null)} aria-label="ปิด">✕</button></header>
        {sheet==='map' && (way ? <WayFinder way={way}/> : <p className="muted">ตอนนี้ไม่มีจุดที่ต้องเดินไป</p>)}
        {sheet==='steps' && <><ol className="qsSteps">{stepList.map((s,i)=>{ const state = i<current ? 'done' : i===current ? 'now' : 'next';
          return <li key={i} className={state}><span>{state==='done' ? fmtMin(s.end) : state==='now' ? 'ตอนนี้' : ''}</span>{stepText[s.kind].serve}<small>{s.place.where}</small></li>; })}</ol>
          {!next && st && st.step.kind!=='leave' && current<steps.length-1 && <p className="muted">ขั้นต่อไปจะแจ้งหลังแพทย์สั่ง เช่น รับยา หรือส่งตรวจเพิ่ม</p>}</>}
        {sheet==='notes' && <>
          {!family && <button className={'qsTool'+(notify?' on':'')} onClick={()=>void enableNotify()}>{notify?<><Bell size={16}/> แจ้งเตือนบนเครื่องนี้เปิดอยู่ · กดเพื่อปิด</>:<><BellOff size={16}/> เปิดการแจ้งเตือนบนเครื่องนี้</>}</button>}
          {!family && features.line && !ticket.offline && (lineCode
            ? <div className="qsLine"><b>ส่งรหัสนี้ในแชท LINE ของโรงพยาบาล</b><span className="qsLineCode">{lineCode.code}</span>
               <a className="qsLineBtn" href={lineCode.url} target="_blank" rel="noreferrer">เปิด LINE อีกครั้ง</a><small>ข้อความพิมพ์ไว้ให้แล้ว กดส่งได้เลย · รหัสใช้ได้ 15 นาที · พิมพ์ "หยุด" ใน LINE เพื่อหยุดแจ้งเตือน</small></div>
            : <button className="qsLineBtn" onClick={async ()=>{ const r = await lineLink(token,patient.queue);
                if (r.ok && r.code && r.url) { setLineCode({code:r.code,url:r.url}); window.open(r.url,'_blank','noopener'); } else setToast({key:'line',at:m,title:'เปิดการแจ้งเตือนทาง LINE ไม่สำเร็จ',body:r.reason ?? ''}); }}>
               <span className="lineIcon">LINE</span> รับแจ้งเตือนทาง LINE (แม้ปิดหน้านี้)</button>)}
          {notes.length ? <ul className="qsNoteList">{notes.slice(0,8).map(n=><li key={n.key}><span className="lineIcon">LINE</span><div><b>{n.title}</b><span>{n.body}</span><small>{fmtMin(n.at)} น.</small></div></li>)}</ul> : <p className="muted">ยังไม่มีการแจ้งเตือน</p>}
          <small className="muted">{features.line ? 'ทาง LINE แจ้งเมื่อถึงคิว ย้ายจุด หรือเจ้าหน้าที่รับเรื่อง · บนหน้านี้แจ้งได้เมื่อหน้านี้เปิดอยู่' : 'บนหน้านี้แจ้งได้เมื่อหน้านี้เปิดอยู่ · โรงพยาบาลเปิดใช้การแจ้งเตือนทาง LINE ได้ในการตั้งค่าระบบ'}</small></>}
        {sheet==='help' && <>
          {helpText && <p className={'qsHelpStatus'+(resolved||assignedTo?' ok':'')}>{helpText}</p>}
          <div className="qsHelpTopics">{helpTopics.map(t=><button key={t} onClick={()=>void askHelp(t)}>{t}</button>)}</div>
          <small className="muted">เรื่องจะส่งถึงเจ้าหน้าที่ของจุดที่คุณรออยู่ทันที · ไม่ต้องพิมพ์ข้อมูลส่วนตัว</small></>}
      </div></div>}
  </main>;
}

function Ring({progress,label,sub,calling}:{progress:number;label:string;sub:string;calling:boolean}) {
  const r = 42, c = 2*Math.PI*r;
  return <div className={'qsRing'+(calling?' calling':'')} aria-label={`${label} ${sub}`}>
    <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r={r} className="track"/><circle cx="50" cy="50" r={r} className="prog" strokeDasharray={c} strokeDashoffset={c*(1-progress)}/></svg>
    <span><b>{label}</b>{sub && <small>{sub}</small>}</span></div>;
}
type Loc = {b:string; level:number; x:number; z:number; label:string; roomId?:string};
const waitLoc = (step:Step, label:string):Loc|undefined => { const b = step.place.waitArea?.buildingId ?? step.place.buildingId, level = step.place.waitArea?.level ?? step.place.level;
  return b && level ? {b,level,x:step.place.wait.x,z:step.place.wait.z,label} : undefined; };
const serveLoc = (step:Step, label:string):Loc|undefined => step.place.buildingId && step.place.level ? {b:step.place.buildingId,level:step.place.level,x:step.place.serve.x,z:step.place.serve.z,label} : undefined;
type Way = {title:string; note?:string; from?:Loc; to:Loc};
function wayOf(st:NonNullable<ReturnType<typeof patientAt>>, steps:Step[], waitText:string):Way|undefined {
  if (st.step.kind==='leave' || st.step.kind==='ward') return undefined;
  if (st.status==='calling') { const station = stationById(st.step.manual); if (!station) return undefined;
    return {title:'ทางไปห้องที่เรียกคุณ',from:waitLoc(st.step,'จุดรอของคุณ'),to:{b:station.buildingId,level:station.level,x:station.spot.x,z:station.spot.z,label:station.label,roomId:station.roomId}}; }
  const prev = steps[st.index-1];
  if (st.status!=='serving' && st.status!=='result') { const to = waitLoc(st.step,'รอที่นี่'); if (!to) return undefined;
    const from = prev ? serveLoc(prev,prev.kind==='kiosk'?'ตู้รับบัตรคิว':'จุดที่เพิ่งเสร็จ') : undefined;
    const there = from && from.b===to.b && from.level===to.level && Math.hypot(from.x-to.x,from.z-to.z)<=3; // already in this waiting area
    return {title:there?'คุณอยู่ที่จุดรอแล้ว':`ไปรอที่: ${waitText}`,note:'รอเรียกที่นี่ หน้านี้จะแจ้งเมื่อถึงคิว',from:there?undefined:from,to}; }
  const next = steps[st.index+1];
  if (st.status==='serving' && next && next.kind!=='leave' && next.kind!=='labResult') { const to = waitLoc(next,'จุดถัดไป'); if (!to) return undefined;
    return {title:`ขั้นต่อไป: ${next.place.where}`,note:'ไปเมื่อเสร็จจากจุดนี้',from:serveLoc(st.step,'จุดที่อยู่ตอนนี้'),to}; }
  return undefined;
}
// A building by the name on its signs (the facility's), without the short form in brackets.
const bName = (b:string) => { const x = fBuilding(b); return x ? x.name.replace(/\s*\(.+\)$/,'') : 'อาคาร'; };
// "You are here → there": same floor draws the walk; another floor (or building) starts at the lift with the steps written out.
function WayFinder({way}:{way:Way}) {
  const {from,to} = way, sameFloor = !!from && from.b===to.b && from.level===to.level;
  const start = sameFloor ? from! : from ? {...liftSpot(to.b),label:'เริ่มที่ลิฟต์'} : undefined;
  const floorText = `${bName(to.b)} ชั้น ${to.level}`;
  return <div className="qsWay">
    <b>{way.title}</b>
    <ol className="qsWaySteps">
      {from && !sameFloor && from.b!==to.b && <li>เดินไปที่ <b>{bName(to.b)}</b></li>}
      {from && !sameFloor && (from.b!==to.b || from.level!==to.level) && <li>{from.b===to.b && from.level>to.level ? 'ลง' : 'ขึ้น'}ลิฟต์หรือบันไดไป <b>ชั้น {to.level}</b></li>}
      <li>{start ? <>เดินตามเส้นสีน้ำเงินไปที่ <b>{to.roomId ? to.label : 'จุดที่ไฮไลต์'}</b></> : <>ไปที่ <b>{floorText}</b> ตามจุดที่ไฮไลต์</>}</li>
    </ol>
    <FloorPlanSvg buildingId={to.b} level={to.level} highlightRoom={to.roomId} zoneAt={to.roomId ? undefined : to} showLift={!!from && !sameFloor} height={190}
      route={start ? {from:start,to} : undefined} dots={[...(start ? [{x:start.x,z:start.z,tone:'me' as const,label:sameFloor?start.label:undefined}] : []),{x:to.x,z:to.z,tone:'target',label:to.label}]}/>
    <small>{floorText}{way.note?` · ${way.note}`:''} · ผังโดยประมาณ</small>
  </div>;
}
