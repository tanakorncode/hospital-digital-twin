'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PriorityTag } from '../PriorityIcon';
import { EnterVisitButton, SendOnBar, type VisitControl } from './LiveVisit';
import { BookingTab } from './Booking';
import { ApptTab } from './Appointments';
import { LineLinkTab } from './LineLink';
import dynamic from 'next/dynamic';
import QRCode from 'qrcode';
import { ArrowLeftRight, CalendarCheck, CalendarClock, Camera, Link2, Coffee, Copy, Hand, Lock, LockOpen, MapPin, QrCode, Sparkles, CheckCircle2, ChevronDown, ChevronRight, ClipboardList, ExternalLink, HeartPulse, LayoutList, List, Map as MapIcon, Megaphone, Pause, PhoneCall, Pill, Play, Repeat, ScanLine, Settings2, Siren, SkipForward, Stethoscope, TestTube, UserCheck, Volume2, VolumeX, Wallet, X } from 'lucide-react';
import { LONG_WAIT, NO_SHOW, fmtDur, fmtMin, maskHN, opdClinics, patientAt, patientToken, placeText, statusColor, statusText, stepText, triageLevels, type Patient, type PatientState, type PatientStatus, type StepKind } from '../../lib/patients';
import { erBoard, serviceNote } from '../../lib/ops';
import { DEFAULT_POLICY, SYSTEM_BY, actionText, openReports, groupName, moveNote, sameZone, allStations, everyStation, announce, capFor, healthText, modeText, rulesFor, scopeName, suggestionText, type AssistView, type Suggestion, groupOf, openStations, priorityOf, stationById, stationDoctor, stationQueue, stepGroup, type PriorityPolicy, type QueueCommand, type QueueEvent, type QueueSettings, type SettingsPatch, type Station, type AuthUser, type QueueSync, useTicket, canDo, isLive } from '../../lib/queue';

import { DEFAULT_HOURS, buildings, floorRooms, layoutRevision, waitingSeats, deptArea } from '../../lib/scene-data';
import FloorPlanSvg from '../FloorPlanSvg';
import type { FloorUnit, SceneMode } from '../HospitalScene';
const FloorScene = dynamic(()=>import('../HospitalScene').then(m=>m.FloorScene),{ssr:false,loading:()=><div className="loading">กำลังโหลดผัง…</div>});

type Tab = 'station'|'overview'|'er'|'booking'|'appts'|'line';
const tabs:[Tab,string,typeof Siren][] = [['station','ช่องบริการของฉัน',PhoneCall],['overview','ภาพรวมคิว',LayoutList],['er','ห้องฉุกเฉิน',Siren],['booking','การจอง',CalendarCheck],['appts','นัดหมาย',CalendarClock],['line','เชื่อม LINE',Link2]];
export type QueueControl = {events:QueueEvent[]; online:boolean; user?:AuthUser|null; resolveTicket?:QueueSync['resolveTicket']; send:(c:QueueCommand)=>Promise<{ok:boolean;reason?:string}>; canAct:boolean; onNow:()=>void; settings:QueueSettings;
 saveSettings?:(patch:SettingsPatch, audit:{at:number; scope:string; summary:string; by?:string})=>Promise<{ok:boolean;reason?:string}>} & Partial<VisitControl> & Partial<Pick<QueueSync,'api'|'bookingRev'|'apptRev'|'features'>>;
// Live data mode, signed-in staff on a connected screen: real patients can be taken in and sent on.
const visitControl = (q:QueueControl):VisitControl|undefined => isLive(q.settings) && q.online && canDo(q.user,'staff') && q.enterVisit && q.addVisitStep && q.cancelVisit
 ? {enterVisit:q.enterVisit,addVisitStep:q.addVisitStep,cancelVisit:q.cancelVisit} : undefined;

type OpenPlace = (buildingId:string, level:number, roomId?:string)=>void;
export default function QueuePage({patients,minute,timeNote,onOpenPatient,queue,assist,onOpenSettings,onOpenPlace}:{patients:Patient[];minute:number;timeNote:string;onOpenPatient:(id:string)=>void;queue:QueueControl;assist:AssistView;onOpenSettings:(group:string|null)=>void;onOpenPlace:OpenPlace}) {
 const [tab,setTab] = useState<Tab>('station');
 const m = Math.floor(minute);
 // Bookings live on the server: the tab is for signed-in staff on a connected screen.
 const bookingOk = queue.online && canDo(queue.user,'staff') && !!queue.api && !!queue.features;
 return <div className="page">
  <div className="pageHead"><h2>ติดตามคิว</h2><span className="pageTime">{timeNote}</span>
   <span className={'syncBadge'+(queue.online?' on':'')}>{queue.online?'ซิงก์กับระบบคิวกลาง':'ออฟไลน์ · บันทึกเฉพาะเครื่องนี้'}</span>
   {isLive(queue.settings) && <span className="syncBadge live">ผู้ป่วยจริง</span>}
   {visitControl(queue) && <EnterVisitButton visits={visitControl(queue)!} minute={minute} disabled={!queue.canAct} patients={patients} QrButton={QrButton}/>}
   <div className="pageTabs" role="tablist">{tabs.filter(([id])=>!['booking','appts','line'].includes(id) || bookingOk).map(([id,label,Icon])=><button key={id} role="tab" aria-selected={tab===id} className={tab===id?'on':''} onClick={()=>setTab(id)}><Icon size={15}/>{label}</button>)}</div>
  </div>
  {serviceNote(m) && <OffHours m={m} queue={queue}/>}
  {tab==='station' ? <StationConsole patients={patients} minute={minute} queue={queue} onOpen={onOpenPatient} assist={assist} onOpenSettings={onOpenSettings}/>
   : tab==='booking' && bookingOk ? <BookingTab api={queue.api!} rev={queue.bookingRev ?? 0} features={queue.features!}/>
   : tab==='line' && bookingOk ? <LineLinkTab api={queue.api!} features={queue.features!} Scanner={CameraScanner}/>
   : tab==='appts' && bookingOk ? <ApptTab api={queue.api!} rev={queue.apptRev ?? 0} user={queue.user} features={queue.features!}/>
   : tab==='overview' ? <OverviewTab patients={patients} m={m} onOpen={onOpenPatient} queue={queue} assist={assist} onOpenSettings={onOpenSettings} onOpenPlace={onOpenPlace}/>
   : <ErTab patients={patients} m={m} onOpen={onOpenPatient}/>}
 </div>;
}

// The patient's own status page (what the QR on their slip opens). Staff can open it, or show the QR again for a
// patient who lost the slip. The link keeps this screen's demo clock so both show the same time.
export const qrUrl = (token:string) => { if (typeof window==='undefined' || !token) return ''; const q = new URLSearchParams(window.location.search), keep = new URLSearchParams();
 ['demoStart','hour'].forEach(k=>{ const v = q.get(k); if (v!==null) keep.set(k,v); }); const qs = keep.toString();
 return `${window.location.origin}/q/${token}${qs?`?${qs}`:''}`; };
function QrButton({p,label}:{p:Patient;label?:string}) {
 const [open,setOpen] = useState(false);
 const [src,setSrc] = useState('');
 const [copied,setCopied] = useState(false);
 const [confirmRenew,setConfirmRenew] = useState(false);
 const ticket = useTicket(p,open), url = qrUrl(ticket.token);
 useEffect(()=>{ if (!url) setSrc(''); },[url]);
 useEffect(()=>{ if (open && url) QRCode.toDataURL(url,{margin:1,width:220}).then(setSrc).catch(()=>setSrc('')); },[open,url]);
 useEffect(()=>{ if (!open) return; const k = (e:KeyboardEvent)=>{ if (e.key==='Escape') setOpen(false); }; window.addEventListener('keydown',k); return ()=>window.removeEventListener('keydown',k); },[open]);
 return <>
  <button className={label?'linkBtn dark':'iconBtn qrBtn'} title={`หน้าคิวของผู้ป่วย ${p.queue} (QR)`} aria-label={`หน้าคิวของผู้ป่วย ${p.queue}`} onClick={e=>{ e.stopPropagation(); setOpen(true); }}>
   {label ? label : <QrCode size={14}/>}</button>
  {open && <div className="modalBack" onClick={e=>{ e.stopPropagation(); setOpen(false); }}>
   <div className="qrDialog" role="dialog" aria-modal="true" aria-label={`QR คิว ${p.queue}`} onClick={e=>e.stopPropagation()}>
    <header><b>หน้าคิวของผู้ป่วย <span className="mvQueue">{p.queue}</span></b><button className="iconBtn" aria-label="ปิด" onClick={()=>setOpen(false)}><X size={16}/></button></header>
    {ticket.error ? <p className="loginError">{ticket.error}</p> : src ? <img src={src} alt={`QR หน้าสถานะคิว ${p.queue}`}/> : <div className="qrPh"/>}
    <p className="muted">ให้ผู้ป่วยสแกนด้วยมือถือเพื่อดูสถานะคิวและแผนที่นำทาง · แสดงเฉพาะเลขคิว ไม่มีชื่อ/HN</p>
    <p className="qrExp">{ticket.offline ? 'โหมดออฟไลน์ · ลิงก์สาธิตในเครื่องนี้' : ticket.expiresAt ? `ลิงก์ใช้ได้ถึง ${new Date(ticket.expiresAt).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})} น. วันนี้` : ''}</p>
    <div className="qrActs"><a className={'btn'+(url?'':' disabled')} href={url || undefined} target="_blank" rel="noreferrer"><ExternalLink size={14}/> เปิดหน้าคิว</a>
     <button className="btn ghost" disabled={!url} onClick={()=>{ void navigator.clipboard?.writeText(url).then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),2000); }); }}><Copy size={14}/> {copied?'คัดลอกแล้ว':'คัดลอกลิงก์'}</button></div>
    {!ticket.offline && (confirmRenew
     ? <div className="qrRenew"><span>บัตรหาย/ลิงก์รั่ว? ออก QR ใหม่แล้ว <b>ลิงก์เดิมและลิงก์ญาติจะใช้ไม่ได้ทันที</b></span>
        <button className="btn ghost sm" onClick={()=>setConfirmRenew(false)}>ยกเลิก</button><button className="btn sm" onClick={()=>{ setConfirmRenew(false); void ticket.renew(); }}>ออก QR ใหม่</button></div>
     : <button className="linkBtn dark qrRenewBtn" onClick={()=>setConfirmRenew(true)}>ออก QR ใหม่ (ยกเลิกลิงก์เดิม)</button>)}
   </div></div>}
 </>;
}

// Outside OPD hours there is no outpatient queue to work with: say so, and offer a one-click test time in the busy part
// of the day (shared with every screen), or a way back to the real clock.
function OffHours({m,queue}:{m:number;queue:QueueControl}) {
 const {opdOpen:o, opdClose:c} = queue.settings.hours ?? DEFAULT_HOURS, peak = Math.round((o+(c-o)*0.4)*2)/2*60, off = queue.settings.demoOffset ?? 0;
 const setClock = (target:number|null) => { if (!queue.saveSettings) return; const d = new Date(), real = d.getHours()*60+d.getMinutes();
  void queue.saveSettings(target===null ? {demoOffset:null} : {demoOffset:Math.round(target-real)},{at:m,scope:'system',summary:target===null?'เวลาทดสอบ: กลับไปใช้เวลาจริง':`เวลาทดสอบ: เริ่มที่ ${fmtMin(target)}`,by:loadPref('hdt.operator','') || undefined}); };
 return <div className="serviceNote offHours"><span>{serviceNote(m)}{off!==0 && <b> · ตอนนี้ใช้เวลาทดสอบ</b>}</span>
  {queue.saveSettings && <span className="offActs"><button className="btn" onClick={()=>setClock(peak)}>ทดสอบช่วงที่มีคิว ({fmtMin(peak)})</button>
   {off!==0 && <button className="btn ghost" onClick={()=>setClock(null)}>กลับไปใช้เวลาจริง</button>}</span>}</div>;
}

// ---- Station console: one big context button, shortcuts, scan, hold chips ----------------------------------
const fmtTime = (m:number) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(Math.floor(m%60)).padStart(2,'0')}`;
const holdReasons:[string,number|undefined][] = [['ไปห้องน้ำ',10],['รอญาติ',15],['ไปทำแล็บก่อน',60],[NO_SHOW,undefined],['อื่น ๆ',undefined]];
const sinceText = (m:number) => m<1 ? 'เมื่อสักครู่' : `${Math.floor(m)} นาที`;
const loadPref = (k:string, d:string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const savePref = (k:string, v:string) => { try { localStorage.setItem(k,v); } catch { /* ignore */ } };
const clockText = (min:number) => { const sec = Math.max(0,Math.floor(min*60)); return `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`; };
// People waiting per queue group (clinic queue, counter queue) at a minute.
function waitingByGroup(patients:Patient[], m:number) {
 const c = new Map<string,number>();
 patients.forEach(p=>{ const s = patientAt(p,m); if (s && (s.status==='waiting' || s.status==='long')) { const g = stepGroup(s); if (g) c.set(g,(c.get(g) ?? 0)+1); } });
 return c;
}
type Msg = {text:string; bad?:boolean; undo?:{label:string; run:()=>void}};
function StationConsole({patients,minute,queue,onOpen,assist,onOpenSettings}:{patients:Patient[];minute:number;queue:QueueControl;onOpen:(id:string)=>void;assist:AssistView;onOpenSettings:(group:string|null)=>void}) {
 const stations = allStations(); // cached per layout revision
 const [stationId,setStationId] = useState('');
 const [prevStation,setPrevStation] = useState(''); // to go back when "change station" was pressed by mistake
 const [sound,setSound] = useState(true);
 const [autoNext,setAutoNext] = useState(false); // "done" also calls the next patient — off unless the station asks for it
 const [holdOpen,setHoldOpen] = useState(false);
 const [msg,setMsg] = useState<Msg|null>(null);
 const [scan,setScan] = useState('');
 const [camera,setCamera] = useState(false);
 const [operator,setOperator] = useState('');
 const [policy,setPolicy] = useState<PriorityPolicy>(DEFAULT_POLICY);
 const [moveFor,setMoveFor] = useState<string|null>(null); // patient id being moved (dialog)
 const [list,setList] = useState<'wait'|'held'|'done'>('wait');
 const [settings,setSettings] = useState(false);
 const [pauseOpen,setPauseOpen] = useState(false);
 const [assistAll,setAssistAll] = useState(false);
 const [planOpen,setPlanOpen] = useState(false);
 useEffect(()=>{ setPlanOpen(loadPref('hdt.stationPlan','0')==='1'); },[]);
 const [dismissed,setDismissed] = useState<Set<string>>(new Set()); // assistant suggestions this station said "no" to
 const busy = useRef(false);
 useEffect(()=>{ setStationId(loadPref('hdt.station','')); setSound(loadPref('hdt.sound','1')==='1'); setOperator(loadPref('hdt.operator','')); setAutoNext(loadPref('hdt.autoNext','0')==='1');
  try { setPolicy({...DEFAULT_POLICY,...JSON.parse(loadPref('hdt.priorityPolicy','{}'))}); } catch { /* defaults */ } },[]);
 const savePolicy = (p:PriorityPolicy) => { setPolicy(p); savePref('hdt.priorityPolicy',JSON.stringify(p)); };
 useEffect(()=>{ if (!msg) return; const t = setTimeout(()=>setMsg(null),msg.undo?8000:4000); return ()=>clearTimeout(t); },[msg]);
 const st = stationById(stationId);
 const m = minute;
 const q = useMemo(()=>st ? stationQueue(patients,st,m,policy,queue.events) : null,[patients,st,m,policy,queue.events]);
 const isOpen = useMemo(()=>{ if (!st) return false; const last = [...queue.events].filter(e=>e.station===st.id && (e.action==='open'||e.action==='close')).sort((a,b)=>a.at-b.at).at(-1); return last?.action==='open'; },[queue.events,st]);
 const doc = st ? stationDoctor(st,m) : undefined;
 const openIds = useMemo(()=>new Set(openStations(queue.events).map(x=>x.id)),[queue.events]);
 const byId = useMemo(()=>new Map(patients.map(p=>[p.id,p])),[patients]);
 // Today at this station: finished patients, minutes each (first call → done), no-shows.
 const today = useMemo(()=>{
  const mine = st ? queue.events.filter(e=>e.station===st.id).sort((a,b)=>a.at-b.at) : [];
  const done = mine.filter(e=>e.action==='done').map(e=>{ const first = mine.find(x=>x.patientId===e.patientId && x.step===e.step && (x.action==='call'||x.action==='start'));
   return {e,p:byId.get(e.patientId!),min:first?e.at-first.at:undefined}; }).reverse();
  const timed = done.filter(d=>d.min!==undefined);
  return {done,avg:timed.length?Math.round(timed.reduce((a,d)=>a+d.min!,0)/timed.length):undefined,noShow:mine.filter(e=>e.action==='hold' && e.reason===NO_SHOW).length};
 },[queue.events,st,byId]);

 const act = async (cmd:Omit<QueueCommand,'at'|'station'>, ok?:string|Msg) => {
  if (!st || !queue.canAct || busy.current) return false;
  busy.current = true;
  const res = await queue.send({...cmd,at:m,station:st.id,by:operator.trim() || undefined});
  busy.current = false;
  if (!res.ok) { setMsg({text:res.reason ?? 'ทำรายการไม่สำเร็จ',bad:true}); return false; }
  if (ok) setMsg(typeof ok==='string'?{text:ok}:ok);
  return true;
 };
 const open = () => act({action:'open'},'เปิดจุดบริการแล้ว · ระบบจะไม่เรียกคิวแทนคุณที่จุดนี้');
 const call = async (s:PatientState, again=false) => {
  if (!isOpen) await open();
  if (await act({action:again?'recall':'call',patientId:s.p.id,step:s.index},`${again?'เรียกซ้ำ':'เรียก'} ${s.p.queue}`) && sound && st) announce(s.p.queue,st.label);
 };
 const start = (s:PatientState) => act({action:'start',patientId:s.p.id,step:s.index},`${s.p.queue} เข้ารับบริการ`);
 const next = q?.waiting[0]?.s;
 const done = async (s:PatientState) => {
  const nx = q?.waiting.find(x=>x.s.p.id!==s.p.id)?.s;
  if (!(await act({action:'done',patientId:s.p.id,step:s.index},`${s.p.queue} เสร็จแล้ว${nx && !autoNext?` · กด Space เมื่อพร้อมเรียก ${nx.p.queue}`:''}`))) return;
  if (autoNext && nx) await call(nx);
 };
 const hold = (s:PatientState, reason:string, after?:number) => { setHoldOpen(false); return act({action:'hold',patientId:s.p.id,step:s.index,reason,returnAfter:after},`พักคิว ${s.p.queue} · ${reason}`); };
 const skip = (s:PatientState) => act({action:'hold',patientId:s.p.id,step:s.index,reason:'ข้ามไปก่อน',returnAfter:0},`ข้าม ${s.p.queue} · กลับเข้าท้ายคิว`);
 const move = async (s:PatientState, target:string, position:'keep'|'end', reason?:string) => {
  setMoveFor(null);
  const to = stationById(target);
  await act({action:'transfer',patientId:s.p.id,step:s.index,target,position,reason},
   {text:`ย้าย ${s.p.queue} ไป ${to?.label}${position==='end'?' · ต่อท้ายคิว':''}`,undo:st?{label:'เลิกทำ',run:()=>{ setMsg(null); void act({action:'transfer',patientId:s.p.id,step:s.index,target:st.id,position:'keep',reason:'เลิกทำการย้าย'},`ย้าย ${s.p.queue} กลับมาแล้ว`); }}:undefined});
 };
 const back = (s:PatientState) => act({action:'return',patientId:s.p.id,step:s.index},`คืน ${s.p.queue} เข้าคิว`);
 const cur = q?.current;
 const mode:'idle'|'calling'|'serving' = !cur ? 'idle' : cur.status==='serving' ? 'serving' : 'calling';
 // The main button follows the job: call next → arrived → done. "Done" never calls the next patient unless asked to.
 const main = async () => {
  if (!q) return;
  if (mode==='calling') return start(cur!);
  if (mode==='serving') return done(cur!);
  if (next) return call(next); else setMsg({text:'ไม่มีคิวรอ'});
 };
 const lastCall = cur?.step.calls?.at(-1), callCount = cur?.step.calls?.length ?? 0;
 // Called three times without showing up: move to hold as no-show automatically.
 useEffect(()=>{ if (cur && mode==='calling' && callCount>=3 && lastCall!==undefined && m-lastCall>=3) void hold(cur,NO_SHOW); },[cur?.p.id,mode,callCount,lastCall,Math.floor(m)]); // eslint-disable-line react-hooks/exhaustive-deps
 // Keyboard: Space/Enter main · R recall · H hold · S skip · D done · M move. A barcode scanner types into the scan box.
 useEffect(()=>{
  const onKey = (e:KeyboardEvent) => {
   const t = e.target as HTMLElement;
   if (moveFor || (t && (t.tagName==='INPUT' || t.tagName==='SELECT' || t.tagName==='TEXTAREA' || t.tagName==='BUTTON'))) return;
   if (e.key===' ' || e.key==='Enter') { e.preventDefault(); void main(); }
   else if ((e.key==='r'||e.key==='R') && cur && mode==='calling') void call(cur,true);
   else if ((e.key==='h'||e.key==='H') && cur) { e.preventDefault(); setHoldOpen(o=>!o); }
   else if ((e.key==='s'||e.key==='S') && cur && mode==='calling') void skip(cur);
   else if ((e.key==='d'||e.key==='D') && cur) void done(cur);
   else if ((e.key==='m'||e.key==='M') && cur) { e.preventDefault(); setMoveFor(cur.p.id); } // don't type the "m" into the dialog's search box
  };
  window.addEventListener('keydown',onKey); return ()=>window.removeEventListener('keydown',onKey);
 });
 // Scan / type: QR link on the slip, queue number, or HN digits — then act on that patient at this station.
 const findScanned = (text:string) => {
  const t = text.trim(); if (!t) return;
  const token = t.match(/\/q\/([A-Za-z0-9_-]+)/)?.[1];
  if (token && token.length>=20 && queue.resolveTicket) { // a link issued by the API: ask who it belongs to
   void queue.resolveTicket(token).then(r=>{ if (r.ok && r.ticket) findScanned(patients.find(x=>x.id===r.ticket!.patientId)?.queue ?? t); else { setScan(''); setMsg({text:r.reason ?? `ไม่พบ ${t}`,bad:true}); } });
   return;
  }
  const p = token ? patients.find(x=>patientToken(x)===token) : patients.find(x=>x.queue===t.toUpperCase() || (t.replace(/\D/g,'').length>=4 && x.hn.replace(/\D/g,'').endsWith(t.replace(/\D/g,''))));
  setScan('');
  if (!p) { setMsg({text:`ไม่พบ ${t}`,bad:true}); return; }
  const s = patientAt(p,m);
  if (!s || !q) { setMsg({text:`${p.queue} ไม่ได้อยู่ในโรงพยาบาลขณะนี้`,bad:true}); return; }
  if (cur?.p.id===p.id) { void (mode==='calling' ? start(cur) : done(cur)); return; }
  if ([...q.waiting.map(x=>x.s),...q.held].some(x=>x.p.id===p.id)) { void call(s); return; }
  setMsg({text:`${p.queue} ไม่ได้อยู่ในคิวนี้ · ตอนนี้: ${m<s.step.called?stepText[s.step.kind].wait:stepText[s.step.kind].serve} (${placeText(s,m)})`,bad:true});
 };

 if (!st) return <section className="panel"><h3>เลือกจุดบริการของคุณ</h3><p className="muted spIntro">เลือกครั้งเดียว เครื่องนี้จะจำไว้ เปิดครั้งหน้าเข้าจุดเดิมทันที</p>
  {stationId && (()=>{ const was = everyStation().find(x=>x.id===stationId); return was && <p className="unitNote">{was.label} ถูกปิดใช้งานในหน้าตั้งค่า (แผนกและจุดบริการ) · เลือกจุดที่เปิดอยู่</p>; })()}
  <StationPicker stations={stations} patients={patients} minute={m} openIds={openIds} current={stationById(prevStation)} onCancel={()=>setStationId(prevStation)}
   onPick={id=>{ setStationId(id); savePref('hdt.station',id); }}/></section>;
 const elapsed = mode==='calling' && lastCall!==undefined ? m-lastCall : cur ? m-cur.step.called : 0;
 const [, typeLabel, tc, TI] = typeInfo(st), letter = st.clinicKey ? clinicLetter.get(st.clinicKey) : undefined;
 const moving = moveFor ? [cur,...(q?.waiting.map(x=>x.s) ?? []),...(q?.held ?? [])].find(x=>x?.p.id===moveFor) : undefined;
 const prio = cur ? priorityOf(cur.p) : undefined;
 const disabled = !queue.canAct;
 // Queue assistant, as it concerns this station.
 const rules = rulesFor(queue.settings,st.group), cap = capFor(queue.settings,st);
 const myLoad = assist.loads.get(st.id)?.length ?? 0, health = assist.health.get(st.id), paused = health?.state==='paused';
 const mySg = rules.mode==='suggest' ? assist.suggestions.filter(sg=>(sg.from.id===st.id || sg.to.id===st.id) && !dismissed.has(sg.key)) : [];
 const sysMoves = queue.events.filter(e=>e.by===SYSTEM_BY && e.action==='transfer' && (e.station===st.id || e.target===st.id) && m-e.at<15).slice().reverse();
 // Help requests from patients waiting for this station or its queue group.
 const reports = openReports(queue.events).filter(e=>e.station===st.id || e.station===`group:${st.group}` || stationById(e.station)?.group===st.group);
 const takeReport = (e:QueueEvent) => act({action:'resolve',patientId:e.patientId,step:e.step,target:e.id},`รับเรื่องของ ${byId.get(e.patientId ?? '')?.queue} แล้ว · ผู้ป่วยเห็นในหน้าคิวทันที`);
 const stuck = assist.lockedStuck.get(st.id) ?? [], stranded = rules.mode!=='off' ? assist.stranded.get(st.id) ?? 0 : 0;
 const pause = (min?:number) => { setPauseOpen(false); return act({action:'pause',returnAfter:min},`พักช่อง${min?` ${min} นาที`:''} · ระบบจะไม่ส่งคิวใหม่มาที่ช่องนี้`); };
 const resume = () => act({action:'resume'},'กลับมาให้บริการแล้ว');
 const lock = (s:PatientState, on:boolean) => act({action:on?'lock':'unlock',patientId:s.p.id,step:s.index},on?`ล็อก ${s.p.queue} ไว้กับ ${st.label} · ระบบจะไม่ย้ายคิวนี้`:`ปลดล็อก ${s.p.queue}`);
 const applySg = async (sg:Suggestion) => { let n = 0;
  for (const s of sg.moves) if (await act({action:'transfer',patientId:s.p.id,step:s.index,target:sg.to.id,position:'keep',reason:`${suggestionText[sg.kind]} · ${sg.reason}`})) n++;
  setMsg({text:`ย้าย ${n} คิวไป ${sg.to.label} แล้ว`}); };
 // Undo an automatic move: back where it came from, locked there so the assistant leaves it alone.
 const undoSys = async (e:QueueEvent) => { if (e.patientId===undefined || e.step===undefined) return;
  if (await act({action:'transfer',patientId:e.patientId,step:e.step,target:e.station,position:'keep',reason:'เลิกทำการย้ายอัตโนมัติ'}))
   await act({action:'lock',patientId:e.patientId,step:e.step},`ย้าย ${byId.get(e.patientId)?.queue} กลับแล้ว และล็อกไว้ไม่ให้ระบบย้ายอีก`); };
 return <div className="console" style={{'--tc':tc} as React.CSSProperties}>
  <section className="panel consoleMain">
   <div className="stHead">
    <span className="spBadge big">{letter ?? <TI size={20}/>}</span>
    <div className="stTitle"><h3>{st.label}</h3>
     <small>{st.section.split(' · ').slice(-1)[0]} · {typeLabel}{st.roomId && <> · <i className={'dutyDot '+(doc?.status ?? 'vacant')}/>{doc?.name || 'ไม่มีแพทย์เข้าเวร'}{doc?.status==='break'?' (พัก)':''}</>}</small></div>
    <span className={'openBadge'+(isOpen?' on':'')}>{isOpen?'● เปิดให้บริการ':'ยังไม่เปิด · ตัวจำลองเรียกแทน'}</span>
    {health && !['ok','auto'].includes(health.state) && <span className={'healthPill '+health.state} title={health.text}>{healthText[health.state]}</span>}
    <button className={'btn ghost'+(paused?' warnBtn':'')} disabled={disabled} onClick={()=>paused?void resume():setPauseOpen(o=>!o)}>{paused?<><Play size={14}/> กลับมาให้บริการ</>:<><Coffee size={14}/> พักช่อง</>}</button>
    <button className="iconBtn" title={sound?'ปิดเสียงประกาศ':'เปิดเสียงประกาศ'} aria-label={sound?'ปิดเสียงประกาศ':'เปิดเสียงประกาศ'} onClick={()=>{ setSound(!sound); savePref('hdt.sound',sound?'0':'1'); }}>{sound?<Volume2 size={18}/>:<VolumeX size={18}/>}</button>
    <button className="btn ghost" onClick={()=>{ setPrevStation(stationId); setStationId(''); }}><ArrowLeftRight size={14}/> เปลี่ยนจุด</button>
   </div>
   {pauseOpen && !paused && <div className="holdChips"><span className="muted">พักช่องนาน</span>{[10,20,30].map(n=><button key={n} onClick={()=>void pause(n)}>{n} นาที</button>)}<button onClick={()=>void pause()}>ไม่กำหนด</button>
    <small className="muted">ระหว่างพัก ระบบไม่ส่งคิวใหม่มาที่ช่องนี้ · คิวที่รอช่องนี้{rules.mode==='auto'?'จะถูกย้ายไปช่องอื่นให้':rules.mode==='suggest'?'จะมีข้อเสนอให้ย้าย':' ยังอยู่ที่เดิม (ตัวช่วยปิดอยู่)'} ยกเว้นคิวที่ล็อก</small></div>}
   {paused && <p className="pausedBar"><Coffee size={16}/> {health!.text} · ไม่รับคิวใหม่{stuck.length?` · คิวที่ล็อกไว้กับช่องนี้ ${stuck.length} คิวยังรออยู่`:''}<button className="btn" disabled={disabled} onClick={()=>void resume()}>กลับมาให้บริการ</button></p>}
   <div className="stStats">
    <div className={cap>0 && myLoad>cap?'over':''} title="คิวที่ระบบจัดให้จุดนี้ (รวมคิวที่ย้ายมาและคิวนัดหมอเจ้าของไข้) เทียบกับเพดาน"><small>จัดให้จุดนี้</small><b>{myLoad}{cap>0 && <em> / {cap}</em>}</b></div>
    <div><small>รอเรียก (ทั้งกลุ่ม)</small><b>{q?.waiting.length ?? 0}</b></div>
    <div><small>เสร็จวันนี้</small><b>{today.done.length}</b></div>
    <div><small>เฉลี่ยต่อคน</small><b>{today.avg!==undefined?today.avg:'–'}<em> นาที</em></b></div>
   </div>
   {disabled && <p className="serviceNote">กำลังดูช่วงเวลาอื่น · จัดการคิวได้เฉพาะเวลาปัจจุบัน <button className="btn" onClick={queue.onNow}>กลับมาเวลาปัจจุบัน</button></p>}

   <div className={'nowCard '+mode}>
    <div className="ncTop"><span className="ncState">{mode==='calling'?<><PhoneCall size={15}/> กำลังเรียก</>:mode==='serving'?<><Stethoscope size={15}/> กำลังให้บริการ</>:<><CheckCircle2 size={15}/> ว่าง · พร้อมเรียกคิว</>}</span>
     {cur && <span className="ncTimer" title={mode==='calling'?'นับตั้งแต่เรียกครั้งล่าสุด (เริ่มนับใหม่เมื่อกดเรียกซ้ำ)':'นับตั้งแต่เริ่มให้บริการ'}><small>{mode==='calling'?'เรียกไปแล้ว':'ให้บริการมาแล้ว'}</small> {clockText(elapsed)}</span>}</div>
    {cur ? <div className="ncBody">
     <b className="ncQueue">{cur.p.queue}</b>
     <div className="ncInfo">
      <div className="ncTags">{prio && <PriorityTag p={prio}/>}{cur.p.booked && <span className="tag booked">{cur.p.booked}</span>}<span className="tag">{cur.step.kind==='followup'?'ฟังผล':stepText[cur.step.kind].serve}</span>
       {cur.step.assigned===st.id && cur.step.movedFrom!==st.id && <span className="tag moved">ย้ายมาจาก {stationById(cur.step.movedFrom)?.label}</span>}
       {cur.step.owner && <span className="tag owner">หมอเจ้าของไข้</span>}{cur.step.locked && <span className="tag lock">🔒 ล็อก</span>}<span className="tag hn">{maskHN(cur.p.hn)}</span></div>
      <span className="ncDept">{cur.p.dept} · มาถึง {fmtMin(cur.p.arrival)} · รอ {Math.round(Math.max(0,(cur.step.calls?.[0] ?? m)-cur.step.start))} นาที</span>
      {mode==='calling' && <span className="ncCalls" aria-label={`เรียกแล้ว ${callCount} ครั้ง`}>{[1,2,3].map(i=><i key={i} className={i<=callCount?'on':''}/>)} เรียกแล้ว {callCount}/3 ครั้ง{callCount>=2?' · ครบ 3 ครั้งระบบจะพักคิวเป็น "ไม่มาตามเรียก" ให้':''}</span>}
      <span className="ncLinks"><button className="linkBtn dark" onClick={()=>onOpen(cur.p.id)}>ดูเส้นทางบนแผนที่</button>
       <button className="linkBtn dark" disabled={disabled} onClick={()=>void lock(cur,!cur.step.locked)}>{cur.step.locked?'ปลดล็อก':'ล็อกไว้กับจุดนี้'}</button>
       <QrButton p={cur.p} label="หน้าคิวผู้ป่วย (QR)"/></span>
      {cur.p.live && visitControl(queue) && <SendOnBar s={cur} minute={m} visits={visitControl(queue)!} disabled={disabled} onMsg={(text,bad)=>setMsg({text,bad})}/>}
     </div>
    </div> : <div className="ncBody idle">
     {next ? <><span className="ncNextLabel">คิวถัดไป</span><b className="ncQueue soft">{next.p.queue}</b>
      <span className="ncDept">{priorityOf(next.p) && <><PriorityTag p={priorityOf(next.p)!}/> </>}{next.step.kind==='followup'?'ฟังผล · ':''}รอ {fmtDur(next.stepWait)}</span></> : <span className="ncEmpty">ไม่มีคิวรอ</span>}
    </div>}
   </div>

   <div className="actRow">
    {mode==='idle' && <button className="mainBtn idle" disabled={disabled || !next} onClick={()=>void main()}><Megaphone size={22}/> เรียกคิวถัดไป{next?` · ${next.p.queue}`:''}<kbd>Space</kbd></button>}
    {mode==='calling' && <>
     <button className="mainBtn calling" disabled={disabled} onClick={()=>void main()}><UserCheck size={22}/> มาแล้ว · เริ่มให้บริการ<kbd>Space</kbd></button>
     <button className="sideBtn" disabled={disabled} onClick={()=>void call(cur!,true)}><Repeat size={18}/> เรียกซ้ำ<kbd>R</kbd></button></>}
    {mode==='serving' && <button className="mainBtn serving" disabled={disabled} onClick={()=>void main()}><CheckCircle2 size={22}/> เสร็จ{autoNext && next?` · แล้วเรียก ${next.p.queue}`:''}<kbd>Space</kbd></button>}
   </div>
   {cur && <div className="subBtns">
    <button disabled={disabled || mode!=='calling'} onClick={()=>void skip(cur)}><SkipForward size={16}/> ข้าม<kbd>S</kbd></button>
    <button disabled={disabled} className={holdOpen?'on':''} onClick={()=>setHoldOpen(o=>!o)}><Pause size={16}/> พักคิว<kbd>H</kbd></button>
    <button disabled={disabled} onClick={()=>setMoveFor(cur.p.id)}><ArrowLeftRight size={16}/> ย้าย / ส่งต่อ<kbd>M</kbd></button>
    <button disabled={disabled || mode!=='calling'} title="จบคิวนี้โดยไม่ต้องกด 'มาแล้ว'" onClick={()=>void done(cur)}><CheckCircle2 size={16}/> เสร็จ<kbd>D</kbd></button>
   </div>}
   {holdOpen && cur && <div className="holdChips"><span className="muted">พักคิว {cur.p.queue} เพราะ</span>{holdReasons.map(([r,after])=><button key={r} onClick={()=>void hold(cur,r,after)}>{r}{after?<small> · คืนคิวใน {after} นาที</small>:''}</button>)}</div>}
   {msg && <p className={'consoleMsg'+(msg.bad?' bad':'')} role="status">{msg.text}{msg.undo && <button className="linkBtn" onClick={msg.undo.run}>{msg.undo.label}</button>}</p>}
   {(()=>{ // Assistant notices: one line each, two at most unless opened.
    const lines = [
     ...reports.map(e=><div key={e.id} className="aLine warn help"><Hand size={14}/><span className="aText"><em>ผู้ป่วยแจ้ง</em><b>{byId.get(e.patientId ?? '')?.queue}</b> {e.reason} · {fmtMin(e.at)}</span>
      <button className="btn sm" disabled={disabled} onClick={()=>void takeReport(e)}>รับเรื่อง</button></div>),
     ...mySg.map(sg=><div key={sg.key} className="aLine"><Sparkles size={14}/><span className="aText" title={sg.reason}><em>{suggestionText[sg.kind]}</em>
      {sg.to.id===st.id ? <>รับ <b>{sg.moves.map(x=>x.p.queue).join(', ')}</b> จาก {sg.from.label}</> : <>ย้าย <b>{sg.moves.map(x=>x.p.queue).join(', ')}</b> → {sg.to.label}</>}</span>
      <button className="btn sm" disabled={disabled} onClick={()=>void applySg(sg)}>{sg.to.id===st.id?'รับ':'ย้าย'}</button>
      <button className="iconBtn xs" aria-label="ไม่ต้อง" title="ไม่ต้อง" onClick={()=>setDismissed(d=>new Set(d).add(sg.key))}><X size={13}/></button></div>),
     ...sysMoves.map(e=>{ const p = e.patientId ? byId.get(e.patientId) : undefined;
      return <div key={e.id} className="aLine done"><Sparkles size={14}/><span className="aText" title={e.reason}><em>ระบบย้าย</em><b>{p?.queue}</b> {e.station===st.id?<>→ {stationById(e.target)?.label}</>:<>จาก {stationById(e.station)?.label} มาที่นี่</>} · {fmtMin(e.at)}</span>
       <button className="linkBtn dark" disabled={disabled} onClick={()=>void undoSys(e)}>เลิกทำ</button></div>; }),
     ...(stranded>0 ? [<div key="stranded" className="aLine warn"><Sparkles size={14}/><span className="aText"><em>ไม่มีที่รับแทน</em>{stranded} คิวรอจุดนี้ · ส่งข้ามแผนกด้วยปุ่ม "ย้าย / ส่งต่อ"</span></div>] : []),
     ...(stuck.length>0 && !paused ? [<div key="stuck" className="aLine"><Lock size={13}/><span className="aText"><b>{stuck.map(x=>x.p.queue).join(', ')}</b> ล็อกไว้กับจุดนี้ ระบบไม่ย้าย</span></div>] : []),
    ];
    if (!lines.length) return null;
    return <div className="aLines">{assistAll ? lines : lines.slice(0,2)}{lines.length>2 && <button className="linkBtn dark aMore" onClick={()=>setAssistAll(o=>!o)}>{assistAll?'ย่อ':`ดูอีก ${lines.length-2} รายการ`}</button>}</div>;
   })()}
   <div className="scanRow">
    <ScanLine size={18}/>
    <input value={scan} onChange={e=>setScan(e.target.value)} onKeyDown={e=>{ if (e.key==='Enter') findScanned(scan); }} placeholder="สแกน QR บนบัตรคิว หรือพิมพ์เลขคิว / เลขท้าย HN แล้วกด Enter" aria-label="สแกนหรือค้นหาคิว"/>
    <button className="btn ghost" onClick={()=>setCamera(true)}><Camera size={15}/> กล้อง</button>
   </div>
   <div className="consoleFoot">
    <span className="keys"><kbd>Space</kbd> ปุ่มหลัก <kbd>R</kbd> เรียกซ้ำ <kbd>S</kbd> ข้าม <kbd>H</kbd> พักคิว <kbd>M</kbd> ย้าย <kbd>D</kbd> เสร็จ</span>
    {isOpen && <button className="linkBtn dark" onClick={()=>void act({action:'close'},'ปิดจุดบริการแล้ว · ตัวจำลองกลับมาเรียกคิวแทน')}>ปิดจุดบริการ</button>}
   </div>
  </section>

  <section className="panel consoleSide">
   <div className="qTabs" role="tablist">
    {([['wait','รอเรียก',q?.waiting.length ?? 0],['held','พักคิว',q?.held.length ?? 0],['done','เสร็จแล้ว',today.done.length]] as const).map(([k,l,n])=>
     <button key={k} role="tab" aria-selected={list===k} className={list===k?'on':''} onClick={()=>setList(k)}>{l}<span>{n}</span></button>)}
    <button className={'iconBtn'+(settings?' on':'')} title="ตั้งค่าจุดบริการ" aria-label="ตั้งค่าจุดบริการ" onClick={()=>setSettings(o=>!o)}><Settings2 size={16}/></button>
   </div>
   {settings && <div className="stSettings">
    <label><input type="checkbox" checked={autoNext} onChange={e=>{ setAutoNext(e.target.checked); savePref('hdt.autoNext',e.target.checked?'1':'0'); }}/> กด "เสร็จ" แล้วเรียกคิวถัดไปทันที <small>(ปิดไว้ = ต้องกดเรียกเอง กันเผลอเรียก)</small></label>
    <label><input type="checkbox" checked={policy.enabled} onChange={e=>savePolicy({...policy,enabled:e.target.checked})}/> คิวพิเศษ แทรก 1 คิวทุก <input type="number" min={1} max={10} value={policy.every} disabled={!policy.enabled} onChange={e=>savePolicy({...policy,every:Math.max(1,Math.min(10,Number(e.target.value)||1))})}/> คิวปกติ</label>
    <div className="stAssistInfo">ตัวช่วยกระจายคิวของ{groupName(st.group)}: <b>{modeText[rules.mode]}</b> · เพดาน {cap>0?`${cap} คน`:'ไม่จำกัด'}
     <button className="linkBtn dark" onClick={()=>onOpenSettings(st.group)}>ตั้งค่ากลุ่มนี้</button></div>
    {queue.user ? <span className="operator">ผู้ปฏิบัติงาน <b>{queue.user.name}</b> (บัญชีที่เข้าสู่ระบบ)</span> : <label className="operator">ผู้ปฏิบัติงาน <input value={operator} maxLength={40} placeholder="ชื่อ / รหัส (บันทึกในประวัติ)" onChange={e=>{ setOperator(e.target.value); savePref('hdt.operator',e.target.value); }}/></label>}
   </div>}
   {list==='wait' && <><ol className="qList">{q?.waiting.slice(0,40).map(({s,priority},i)=>{ const w = Math.round(s.stepWait);
    return <li key={s.p.id} className={(priority?'prio ':'')+(s.status==='long'?'long':'')}>
     <span className="qNo">{i+1}</span>
     <div className="qMain"><b>{s.p.queue}</b><span className="qTags">{priority && <PriorityTag p={priority}/>}{s.step.kind==='followup' && <em className="tag">ฟังผล</em>}{s.step.assigned===st.id && s.step.movedFrom!==st.id && <em className="tag moved" title={`จาก ${stationById(s.step.movedFrom)?.label ?? ''}`}>ย้ายมา</em>}{s.step.owner && <em className="tag owner" title={`หมอเจ้าของไข้ · ${stationById(s.step.assigned)?.label ?? ''}`}>เจ้าของไข้</em>}{s.step.locked && <em className="tag lock">🔒</em>}{s.step.holds?.length ? <em className="tag">คืนคิว</em> : null}</span></div>
     <span className="qWait"><span>รอ <b>{fmtDur(w,true)}</b></span><i><i style={{width:`${Math.min(100,w/LONG_WAIT*100)}%`}}/></i></span>
     <span className="qActs"><button className="iconBtn" title={`เรียก ${s.p.queue}`} aria-label={`เรียก ${s.p.queue}`} disabled={disabled || !!cur} onClick={()=>void call(s)}><Megaphone size={15}/></button>
      <button className="iconBtn" title={`ย้าย ${s.p.queue}`} aria-label={`ย้าย ${s.p.queue}`} disabled={disabled} onClick={()=>setMoveFor(s.p.id)}><ArrowLeftRight size={15}/></button>
      <QrButton p={s.p}/>
      <button className={'iconBtn'+(s.step.locked?' on':'')} title={s.step.locked?`ปลดล็อก ${s.p.queue}`:`ล็อก ${s.p.queue} ไว้กับจุดนี้`} aria-label={s.step.locked?`ปลดล็อก ${s.p.queue}`:`ล็อก ${s.p.queue}`} disabled={disabled} onClick={()=>void lock(s,!s.step.locked)}>{s.step.locked?<Lock size={14}/>:<LockOpen size={14}/>}</button></span>
    </li>; })}</ol>
    {!q?.waiting.length && <p className="qEmpty">ไม่มีคิวรอ</p>}
    {!!cur && !!q?.waiting.length && <p className="note">เรียกข้ามลำดับได้หลังจบคิวปัจจุบัน (เสร็จ / ข้าม / พักคิว)</p>}</>}
   {list==='held' && <><ul className="qList held">{q?.held.map(s=>{ const h = s.step.holds?.at(-1);
    return <li key={s.p.id}><span className="qNo"><Pause size={13}/></span><div className="qMain"><b>{s.p.queue}</b><span className="qTags"><em className={'tag'+(h?.reason===NO_SHOW?' bad':'')}>{h?.reason}</em></span></div>
     <span className="qWait"><span>{h?.until?<>คืนคิวใน <b>{Math.max(0,Math.round(h.until-m))}</b> น.</>:'รอเรียก'}</span></span>
     <span className="qActs"><button className="iconBtn" title="เรียก" aria-label={`เรียก ${s.p.queue}`} disabled={disabled || !!cur} onClick={()=>void call(s)}><Megaphone size={15}/></button>
      <button className="btn ghost sm" disabled={disabled} onClick={()=>void back(s)}>คืนคิว</button></span></li>; })}</ul>
    {!q?.held.length && <p className="qEmpty">ไม่มีคิวที่พักไว้</p>}</>}
   {list==='done' && <><ul className="qList done">{today.done.slice(0,40).map(d=><li key={d.e.id}><span className="qNo"><CheckCircle2 size={13}/></span>
     <div className="qMain"><b>{d.p?.queue ?? '—'}</b><span className="qTags">{d.e.by && <em className="tag">{d.e.by}</em>}</span></div>
     <span className="qWait"><span>{fmtMin(d.e.at)}{d.min!==undefined?<> · <b>{Math.round(d.min)}</b> น.</>:''}</span></span><span/></li>)}</ul>
    {!today.done.length && <p className="qEmpty">ยังไม่มีคิวที่เสร็จที่จุดนี้วันนี้</p>}</>}
   <details className="stPlan" open={planOpen} onToggle={e=>{ const o = (e.target as HTMLDetailsElement).open; setPlanOpen(o); savePref('hdt.stationPlan',o?'1':'0'); }}>
    <summary><MapPin size={14}/> ผังจุดบริการ <small>ที่นั่งของคิวที่เรียกและคิวถัดไป</small></summary>
    {planOpen && <><FloorPlanSvg buildingId={st.buildingId} level={st.level} highlightRoom={st.roomId} highlightZone={zoneOf(st)} height={190}
     route={cur && mode==='calling' ? {from:{x:cur.pos.x,z:cur.pos.z},to:{x:st.spot.x,z:st.spot.z}} : undefined}
     dots={[{x:st.spot.x,z:st.spot.z,tone:'target',label:st.roomId?st.label.replace('ห้องตรวจ ','ห้อง '):'จุดนี้'},
      ...(cur && mode==='calling' ? [{x:cur.pos.x,z:cur.pos.z,tone:'called' as const,label:cur.p.queue}] : []),
      ...(q?.waiting.slice(0,3).map(({s:x},i)=>({x:x.pos.x+(i-1)*0.12,z:x.pos.z,tone:'next' as const,num:String(i+1)})) ?? [])]}/>
     <div className="stPlanKey">{cur && mode==='calling' && <span><i className="called"/>{cur.p.queue} (กำลังเรียก)</span>}{q?.waiting.slice(0,3).map(({s:x},i)=><span key={x.p.id}><i className="next">{i+1}</i>{x.p.queue}</span>)}</div>
     <small className="muted">ตำแหน่งที่นั่งมาจากตัวจำลอง · ระบบจริงต้องสแกนบัตรคิวที่โซนรอ หรือใช้เซนเซอร์</small></>}
   </details>
   {!!q?.calledElsewhere.length && <p className="note">กำลังถูกเรียกที่จุดอื่น: {q.calledElsewhere.map(s=>`${s.p.queue} (${stationById(s.step.manual)?.label})`).join(', ')}</p>}
   <span className="tvLinks"><a className="tvLink" href={`/tv?station=${encodeURIComponent(st.id)}`} target="_blank" rel="noreferrer">จอหน้า{st.roomId?'ห้อง':'ช่อง'}นี้ <ExternalLink size={12}/></a>
    <a className="tvLink" href={`/tv?dept=${encodeURIComponent(st.clinicKey ? st.section.split(' · ').slice(-1)[0] : st.section)}`} target="_blank" rel="noreferrer">จอพื้นที่รอ <ExternalLink size={12}/></a>
    {st.buildingId==='opd' && <a className="tvLink" href={`/tv?floor=${st.level}`} target="_blank" rel="noreferrer">จอรวมชั้น {st.level} <ExternalLink size={12}/></a>}</span>
  </section>
  {moving && <MoveDialog s={moving} from={st} patients={patients} minute={m} openIds={openIds} assist={assist} onClose={()=>setMoveFor(null)} onMove={(t,pos,r)=>void move(moving,t,pos,r)}/>}
  {camera && <CameraScanner onResult={t=>{ setCamera(false); findScanned(t); }} onClose={()=>setCamera(false)}/>}
 </div>;
}

// Move / refer a patient: other rooms of the same clinic first, then other clinics (or other counters of the same
// service). Rooms without a doctor on duty cannot take patients. Rooms nobody runs on screen are served by the
// simulator in the demo.
function MoveDialog({s:one,list,from,atFrom=true,patients,minute,openIds,assist,onClose,onMove}:{s?:PatientState;list?:PatientState[];from:Station;atFrom?:boolean;patients:Patient[];minute:number;openIds:Set<string>;assist:AssistView;onClose:()=>void;onMove:(target:string,position:'keep'|'end',reason?:string)=>void}) {
 const m = Math.floor(minute);
 const many = list ?? (one ? [one] : []), s = many[0], label = many.length>1 ? `${many.length} คิว` : s.p.queue; // one patient, or several from the same queue
 const [q,setQ] = useState('');
 const [target,setTarget] = useState('');
 const [position,setPosition] = useState<'keep'|'end'>('keep');
 const [reason,setReason] = useState('');
 const waiting = useMemo(()=>waitingByGroup(patients,m),[patients,m]);
 useEffect(()=>{ const k = (e:KeyboardEvent)=>{ if (e.key==='Escape') onClose(); }; window.addEventListener('keydown',k); return ()=>window.removeEventListener('keydown',k); },[onClose]);
 // atFrom: the patients are at `from` itself (else `from` only stands for their queue, and it is a valid target too).
 const all = allStations().filter(t=>(!atFrom || t.id!==from.id) && t.kinds.some(k=>from.kinds.includes(k)));
 const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
 const shown = all.filter(t=>terms.every(w=>norm(`${t.label} ${t.section} ${stationDoctor(t,m)?.name ?? ''}`).includes(norm(w))));
 const same = shown.filter(t=>t.group===from.group), other = shown.filter(t=>t.group!==from.group);
 const vacantOf = (t:Station) => { const d = stationDoctor(t,m); return !!t.roomId && (!d?.name || d.status==='vacant'); };
 const loadOf = (t:Station) => assist.loads.get(t.id)?.length ?? 0;
 const blocked = (t:Station) => vacantOf(t) || assist.health.get(t.id)?.state==='paused';
 // Counters (screening, pharmacy…) share one queue per group: across groups the choice is the group, and the
 // least-loaded working counter in it is taken. Exam rooms are doctors, so they stay a per-room choice.
 const byGroup = !from.roomId;
 const bestIn = (list:Station[]) => list.filter(t=>!blocked(t)).sort((x,y)=>loadOf(x)-loadOf(y))[0];
 const otherGroups = [...new Set(other.map(t=>t.group))];
 const leastGroup = otherGroups.filter(g=>bestIn(other.filter(t=>t.group===g))).sort((x,y)=>(waiting.get(x) ?? 0)-(waiting.get(y) ?? 0))[0];
 const floorsOf = [...new Set(other.map(floorKey))].sort((x,y)=>floorOrder.indexOf(x.split(':')[0])-floorOrder.indexOf(y.split(':')[0]) || Number(x.split(':')[1])-Number(y.split(':')[1]));
 const reasons = from.roomId ? ['แพทย์ติดภารกิจ','ส่งพบแพทย์เฉพาะทาง','เกลี่ยคิว','มาผิดห้อง'] : from.clinicKey ? ['มาผิดแผนก','เกลี่ยคิว','ช่องนี้ปิดชั่วคราว'] : ['เกลี่ยคิว','ช่องนี้ปิดชั่วคราว','มาผิดช่อง'];
 const tgt = stationById(target), tgtName = tgt ? (byGroup && tgt.group!==from.group ? groupName(tgt.group) : tgt.label) : '';
 const dept = (t:Station) => t.section.split(' · ').slice(-1)[0];
 const short = (t:Station) => t.roomId ? t.label : t.label.replace(/^.* (\d+)$/,'ช่อง $1');
 const badge = (t:Station) => { const l = t.clinicKey ? clinicLetter.get(t.clinicKey) : undefined, I = typeInfo(t)[3];
  return <span className="spBadge" style={{'--tc':typeInfo(t)[2]} as React.CSSProperties}>{l ?? <I size={14}/>}</span>; };
 const waitPill = (n:number) => <span className={'mvWait'+(n===0?' zero':'')}>รอ <b>{n}</b></span>;
 // Same group: small chips — the patient keeps their seat.
 const chip = (t:Station) => { const h = assist.health.get(t.id), off = blocked(t);
  return <button key={t.id} className={'mvChip'+(target===t.id?' on':'')} disabled={off} onClick={()=>setTarget(t.id)}>
   <b>{short(t)}</b>{t.roomId && <small><i className={'dutyDot '+(vacantOf(t)?'vacant':stationDoctor(t,m)!.status)}/>{stationDoctor(t,m)?.name || 'ไม่มีแพทย์'}</small>}
   {off ? (vacantOf(t) ? null : <em>พักช่อง</em>) : <span className="mvLoad">รอ {loadOf(t)}</span>}{h?.state==='paused' ? null : openIds.has(t.id) && <i className="spDot" title="มีเจ้าหน้าที่เปิดอยู่"/>}</button>; };
 // Another clinic / service as one card.
 const groupCard = (g:string) => { const list = other.filter(t=>t.group===g), best = bestIn(list), first = list[0], n = waiting.get(g) ?? 0;
  return <button key={g} className={'mvCard'+(tgt?.group===g?' on':'')} disabled={!best} onClick={()=>best && setTarget(best.id)} style={{'--tc':typeInfo(first)[2]} as React.CSSProperties}>
   {badge(first)}<span className="mvText"><b>{first.clinicKey ? dept(first) : first.section}</b><small>{best ? `${list.length} ช่อง` : 'ปิดทุกช่อง'}</small></span>
   {waitPill(n)}{leastGroup===g && <em className="mvBest">คิวน้อยสุด</em>}</button>; };
 const roomCard = (t:Station) => { const d = stationDoctor(t,m), off = blocked(t);
  return <button key={t.id} className={'mvCard'+(target===t.id?' on':'')} disabled={off} onClick={()=>setTarget(t.id)} style={{'--tc':typeInfo(t)[2]} as React.CSSProperties}>
   <span className="mvText"><b>{t.label}{openIds.has(t.id) && <i className="spDot" title="มีเจ้าหน้าที่เปิดอยู่"/>}</b>
    <small><i className={'dutyDot '+(vacantOf(t)?'vacant':d!.status)}/>{vacantOf(t)?'ไม่มีแพทย์เข้าเวร':`${d!.name}${d!.status==='break'?' (พัก)':''}`}</small></span>
   {leastGroup===t.group && bestIn(other.filter(x=>x.group===t.group))?.id===t.id && <em className="mvBest">คิวน้อยสุด</em>}</button>; };
 const floorBlock = (fk:string) => { const list = other.filter(t=>floorKey(t)===fk), elsewhere = fk!==floorKey(from);
  const head = <h4>{floorName(list[0])}{elsewhere && <em className="mvFloorTag">ต่างชั้น · ผู้ป่วยต้องเดินไป</em>}</h4>;
  if (byGroup) return <div key={fk} className="mvGroup">{head}<div className="mvGrid">{[...new Set(list.map(t=>t.group))].map(groupCard)}</div></div>;
  const secs = [...new Set(list.map(t=>t.section))];
  return <div key={fk} className="mvGroup">{head}
   {secs.map(sec=>{ const rooms = list.filter(t=>t.section===sec);
    return <div key={sec} className="mvClinic"><span className="mvClinicName">{badge(rooms[0])}<span className="mvText"><b>{dept(rooms[0])}</b><small>คิวรวม {waitPill(waiting.get(rooms[0].group) ?? 0)}</small></span></span>
     <div className="mvRooms">{rooms.map(roomCard)}</div></div>; })}</div>; };
 return <div className="modalBack" onClick={onClose}>
  <div className="moveDialog" role="dialog" aria-modal="true" aria-label={`ย้ายหรือส่งต่อ ${label}`} onClick={e=>e.stopPropagation()}>
   <header><div><h3>ย้าย / ส่งต่อคิว <span className="mvQueue">{label}</span></h3>
    <small className="muted">{many.length>1 ? <>{many.map(x=>x.p.queue).join(', ')} · {groupName(from.group)}</> : <>จาก {from.label} · {s.p.dept} · {maskHN(s.p.hn)}</>}</small></div><button className="iconBtn" aria-label="ปิด" onClick={onClose}><X size={18}/></button></header>
   <label className="spSearch"><ScanLine size={16}/><input autoFocus value={q} onChange={e=>setQ(e.target.value)} placeholder={byGroup?'ค้นหาแผนกหรือจุดบริการ':'ค้นหาห้อง แผนก หรือชื่อแพทย์'}/></label>
   <div className="mvBody">
    {same.length>0 && <div className="mvGroup same"><h4>{from.roomId?'ห้องอื่นในแผนกเดียวกัน':'ช่องอื่นของจุดนี้'} <small>ผู้ป่วยรอที่เดิม ไม่ต้องย้ายที่นั่ง</small></h4><div className="mvChips">{same.map(chip)}</div></div>}
    {floorsOf.length>0 && <p className="mvDivider">{from.clinicKey?(byGroup?'ส่งต่อแผนกอื่น · ระบบเลือกช่องที่คิวน้อยสุดให้':'ส่งต่อแผนกอื่น'):'จุดอื่น'}</p>}
    {floorsOf.map(floorBlock)}
    {!shown.length && <p className="qEmpty">ไม่พบห้องที่ตรงกับคำค้น</p>}
   </div>
   <div className="mvOptions">
    <div className="mvOpt"><span>ลำดับที่ปลายทาง</span>
     <label className={position==='keep'?'on':''}><input type="radio" checked={position==='keep'} onChange={()=>setPosition('keep')}/> รักษาลำดับเดิม <small>เรียงตามเวลาที่มาถึง (แนะนำ)</small></label>
     <label className={position==='end'?'on':''}><input type="radio" checked={position==='end'} onChange={()=>setPosition('end')}/> ต่อท้ายคิว</label></div>
    <div className="mvOpt"><span>เหตุผล (ไม่บังคับ)</span><div className="chipRow">{reasons.map(r=><button key={r} className={'chip'+(reason===r?' on':'')} onClick={()=>setReason(reason===r?'':r)}>{r}</button>)}</div></div>
   </div>
   <footer>
    <span className={'muted'+(tgt && !sameZone(from,tgt)?' mvWalk':'')}>{tgt ? <><b>ผู้ป่วย: {moveNote(from,tgt)}</b> · แจ้งในหน้าสถานะคิว (QR) และจอทีวีทันที{!sameZone(from,tgt)?' · ควรบอกผู้ป่วยด้วยตัวเองอีกครั้ง':''}</> : 'เลือกปลายทาง'}</span>
    <button className="btn ghost" onClick={onClose}>ยกเลิก</button>
    <button className="btn" disabled={!tgt} onClick={()=>tgt && onMove(tgt.id,position,reason || undefined)}><ArrowLeftRight size={15}/> ย้าย {label}{tgt?` ไป ${tgtName}`:''}</button>
   </footer>
  </div>
 </div>;
}

// Station types staff think in. Each type has one identity colour + icon, used on the cards and the floor map.
const stationTypes:[string,string,string,typeof Siren][] = [['exam','ห้องตรวจ','#2a78d6',Stethoscope],['screening','ซักประวัติ','#0f9f9a',HeartPulse],['registration','ลงทะเบียน','#5b5bd6',ClipboardList],
 ['lab','เจาะเลือด','#d9534f',TestTube],['xray','เอกซเรย์','#8b4fe6',ScanLine],['pharmacy','จ่ายยา','#1f9d55',Pill],['finance','การเงิน','#c27c0e',Wallet],['triage','คัดแยก ER','#e0368c',Siren]];
const typeOf = (s:Station) => s.kinds[0]==='followup' ? 'exam' : s.kinds[0];
const typeInfo = (s:Station) => stationTypes.find(t=>t[0]===typeOf(s))!;
const norm = (t:string) => t.toLowerCase().replace(/\s+/g,'');
const floorKey = (s:Station) => `${s.buildingId}:${s.level}`;
const floorName = (s:Station) => `${s.buildingId==='opd'?'OPD':s.buildingId==='er'?'อาคารฉุกเฉิน':'ศูนย์การแพทย์'} ชั้น ${s.level}`;
const floorOrder = ['opd','diagnostics','er'];
const loadLevel = (n:number) => n>=12 ? 'critical' : n>=6 ? 'busy' : 'normal';
const loadText = {normal:'คิวปกติ',busy:'คิวเริ่มยาว',critical:'คิวยาว'};
// Read live: departments can be added in Settings.
const clinicLetter = {get:(key:string)=>opdClinics().find(c=>c.key===key)?.letter};
// Which waiting band of the floor a station faces (clinics: their own band; OPD floor 1: registration, pharmacy, finance).
const zoneOf = (st:Station) => st.clinicKey ? opdClinics().find(c=>c.key===st.clinicKey)?.deptIndex : st.buildingId==='opd' && st.level===1 ? ({registration:0,pharmacy:1,finance:2} as Record<string,number>)[st.kinds[0]] : undefined;

function StationPicker({stations,patients,minute,openIds,current,onPick,onCancel}:{stations:Station[];patients:Patient[];minute:number;openIds:Set<string>;current?:Station;onPick:(id:string)=>void;onCancel?:()=>void}) {
 const [q,setQ] = useState('');
 const [type,setType] = useState('');
 const [view,setView] = useState<'list'|'map'>('list');
 const [recent,setRecent] = useState<string[]>([]);
 useEffect(()=>{ try { setRecent(JSON.parse(loadPref('hdt.recentStations','[]'))); } catch { /* none */ } setView(loadPref('hdt.pickerView','list')==='map'?'map':'list'); },[]);
 const m = Math.floor(minute);
 // Waiting per queue group, so staff can see at a glance where the queue is.
 const waitingBy = useMemo(()=>waitingByGroup(patients,m),[patients,m]);
 const doctors = useMemo(()=>new Map(stations.map(s=>[s.id,stationDoctor(s,m)])),[stations,m]);
 const terms = norm(q) ? q.trim().toLowerCase().split(/\s+/) : [];
 const hay = (s:Station) => norm(`${s.label} ${s.section} ${typeInfo(s)[1]} ${doctors.get(s.id)?.name ?? ''} ${s.roomId?.replace(/\D/g,'') ?? ''}`);
 const name = (s:Station) => norm(`${s.label} ${doctors.get(s.id)?.name ?? ''}`);
 const typed = stations.filter(s=>!type || typeOf(s)===type);
 // Matches on the station's own name or doctor win; the section/type text is only a fallback ("ยา" ≠ รังสีวิทยา).
 const strong = terms.length ? typed.filter(s=>terms.every(t=>name(s).includes(norm(t)))) : [];
 const shown = strong.length ? strong : typed.filter(s=>terms.every(t=>hay(s).includes(norm(t))));
 const pick = (id:string) => { const r = [id,...recent.filter(x=>x!==id)].slice(0,5); savePref('hdt.recentStations',JSON.stringify(r)); onPick(id); };
 const switchView = (v:'list'|'map') => { setView(v); savePref('hdt.pickerView',v); };
 const recents = recent.map(id=>stationById(id)).filter((x):x is Station=>!!x);
 const count = (t:string) => stations.filter(s=>typeOf(s)===t).length;
 const btn = (s:Station, full=false) => { const d = doctors.get(s.id), w = waitingBy.get(s.group) ?? 0, duty = s.roomId ? d?.status ?? 'vacant' : 'na';
  return <button key={s.id} className={`duty-${duty}`+(openIds.has(s.id)?' busy':'')+(current?.id===s.id?' cur':'')} style={{'--tc':typeInfo(s)[2]} as React.CSSProperties} onClick={()=>pick(s.id)}>
   <b>{!full && s.kinds[0]==='screening' ? s.label.replace(/^ซักประวัติ .+ (\d+)$/,'ซักประวัติ $1') : s.label}{openIds.has(s.id) && <i title="มีเจ้าหน้าที่เปิดจุดนี้อยู่" aria-label="เปิดอยู่"/>}</b>
   <small>{s.roomId ? (d?.name ? `${d.name}${duty==='break'?' · พัก':''}` : 'ไม่มีแพทย์เข้าเวร') : `รอ ${w} คน`}</small></button>; };
 const sections = [...new Set(shown.map(s=>s.section))];
 const floors = [...new Set(shown.map(floorKey))].sort((a,b)=>floorOrder.indexOf(a.split(':')[0])-floorOrder.indexOf(b.split(':')[0]) || Number(a.split(':')[1])-Number(b.split(':')[1]));
 const maxWait = Math.max(1,...sections.map(sec=>waitingBy.get(shown.find(s=>s.section===sec)!.group) ?? 0));
 return <div className="stationPicker">
  <div className="spTop">
   <label className="spSearch"><ScanLine size={16}/><input autoFocus value={q} onChange={e=>setQ(e.target.value)} placeholder="พิมพ์เลขห้อง ชื่อแผนก หรือชื่อแพทย์ เช่น 204, ยา, ตา"
    onKeyDown={e=>{ if (e.key==='Enter' && shown.length) pick(shown[0].id); if (e.key==='Escape') setQ(''); }}/>{q && <button className="linkBtn dark" onClick={()=>setQ('')}>ล้าง</button>}</label>
   <div className="viewSwitch inline">{([['list','รายการ',List],['map','แผนผัง 3D',MapIcon]] as const).map(([k,l,I])=><button key={k} className={view===k?'active':''} onClick={()=>switchView(k)}><I size={14}/> {l}</button>)}</div>
   {current && onCancel && <button className="btn ghost" onClick={onCancel}>กลับไป {current.label}</button>}
  </div>
  <div className="spTypes"><button className={'chip'+(!type?' on':'')} onClick={()=>setType('')}>ทั้งหมด <small>{stations.length}</small></button>
   {stationTypes.map(([k,l,c,I])=><button key={k} className={'chip typeChip'+(type===k?' on':'')} style={{'--tc':c} as React.CSSProperties} onClick={()=>setType(type===k?'':k)}><I size={13}/> {l} <small>{count(k)}</small></button>)}</div>
  {!q && !type && recents.length>0 && <div className="spRecent"><span className="muted">ใช้ล่าสุด</span>{recents.map(s=>btn(s,true))}</div>}
  {q && <p className="muted spHint">{shown.length ? <>พบ {shown.length} จุด · กด Enter เพื่อเลือก <b>{shown[0].label}</b></> : 'ไม่พบจุดบริการที่ตรงกับคำค้น'}</p>}
  {view==='map' ? <StationMap initialFloor={current ? floorKey(current) : recents[0] ? floorKey(recents[0]) : undefined} stations={shown} patients={patients} minute={minute} openIds={openIds} waitingBy={waitingBy} doctors={doctors} onPick={pick}/> : <>
   <div className="spLegend"><span><i className="dl active"/>มีแพทย์ออกตรวจ</span><span><i className="dl break"/>แพทย์พัก</span><span><i className="dl vacant"/>ไม่มีแพทย์เข้าเวร</span><span><i className="spDot"/>มีเจ้าหน้าที่เปิดจุดนั้นอยู่</span></div>
   {floors.map(fk=>{ const secs = sections.filter(sec=>floorKey(shown.find(s=>s.section===sec)!)===fk);
    return <div key={fk} className="spFloor"><h5>{floorName(shown.find(s=>floorKey(s)===fk)!)}</h5><div className="spGrid">{secs.map(sec=>{
     const list = shown.filter(s=>s.section===sec), first = list[0], [, tl, tc, TI] = typeInfo(first), w = waitingBy.get(first.group) ?? 0, lv = loadLevel(w);
     const letter = first.clinicKey ? clinicLetter.get(first.clinicKey) : undefined;
     return <div key={sec} className="spGroup" style={{'--tc':tc} as React.CSSProperties}>
      <h4><span className="spBadge">{letter ?? <TI size={15}/>}</span><span className="spTitle">{sec.split(' · ').slice(-1)[0]}<small>{first.clinicKey ? 'ห้องตรวจ + ซักประวัติ' : tl}</small></span>
       <span className={'spLoad '+lv} title={loadText[lv]}><em>รอ {w}</em><i><i style={{width:`${Math.max(4,w/maxWait*100)}%`}}/></i></span></h4>
      <div className="spList">{list.map(s=>btn(s))}</div></div>; })}</div></div>; })}
  </>}
 </div>;
}

// The same stations on the 3D floor plan: pick a floor, click a room or counter. Counters that sit side by side
// (registration, pharmacy, finance) are one mark that opens a chooser, so labels never pile up.
// Stations of one floor as marks on the 3D plan: rooms use the room's floor area, counters standing side by side
// (registration, pharmacy, finance, a clinic's screening desks) share one mark so labels never pile up.
function floorStationMarks(floor:string, here:Station[], labelOf:(id:string,list:Station[])=>string, stateOf:(list:Station[])=>string) {
 const [buildingId,lv] = floor.split(':'), level = Number(lv);
 const grouped = (s:Station) => (s.group.startsWith('counter:') && buildingId==='opd') || s.group.startsWith('screening:');
 const b = buildings.find(x=>x.id===buildingId)!, rooms = floorRooms(buildingId,level), rw = b.width/Math.max(1,rooms.length), dz = b.depth*0.42;
 const roomMat = (roomId?:string, name?:string) => { const r = rooms.find(x=>x.id===roomId || x.name===name); if (!r) return undefined;
  const x0 = b.x-b.width/2+r.index*rw, z0 = b.z-b.depth/2; return {x:x0+rw/2,z:z0+dz/2,w:rw-0.15,d:dz-0.15}; };
 const marks = new Map<string,{list:Station[]}>();
 here.forEach(s=>{ const id = grouped(s) ? `grp:${s.group}` : s.id, m = marks.get(id); if (m) m.list.push(s); else marks.set(id,{list:[s]}); });
 const units:FloorUnit[] = [...marks.entries()].map(([id,m])=>{
  const s = m.list[0], n = m.list.length, ax = m.list.reduce((a,x)=>a+x.spot.x,0)/n, az = m.list.reduce((a,x)=>a+x.spot.z,0)/n;
  const mat = (s.roomId && roomMat(s.roomId)) || (s.kinds[0]==='xray' && roomMat(undefined,s.label)) || {x:ax,z:az-0.1,w:id.startsWith('grp:')?1.7:0.95,d:id.startsWith('grp:')?0.9:0.8};
  return {id,label:labelOf(id,m.list),state:stateOf(m.list),at:{x:ax,y:s.spot.y,z:az},mat};
 });
 return {marks,units};
}
const markLabel = (id:string, list:Station[]) => { const s = list[0];
 return id.startsWith('grp:') ? `${typeInfo(s)[1]}${s.clinicKey?` ${clinicLetter.get(s.clinicKey) ?? ''}`:''} ${list.length} ช่อง` : s.roomId ? `ห้อง ${s.label.replace(/\D/g,'')}` : s.kinds[0]==='screening' ? `ซักประวัติ ${clinicLetter.get(s.clinicKey!) ?? ''}` : s.label.replace('ห้องเอกซเรย์','X-ray'); };
const sortFloors = (keys:string[]) => [...new Set(keys)].sort((a,b)=>floorOrder.indexOf(a.split(':')[0])-floorOrder.indexOf(b.split(':')[0]) || Number(a.split(':')[1])-Number(b.split(':')[1]));

function StationMap({initialFloor,stations,patients,minute,openIds,waitingBy,doctors,onPick}:{initialFloor?:string;stations:Station[];patients:Patient[];minute:number;openIds:Set<string>;waitingBy:Map<string,number>;doctors:Map<string,ReturnType<typeof stationDoctor>>;onPick:(id:string)=>void}) {
 const floors = [...new Set(stations.map(floorKey))].sort((a,b)=>floorOrder.indexOf(a.split(':')[0])-floorOrder.indexOf(b.split(':')[0]) || Number(a.split(':')[1])-Number(b.split(':')[1]));
 const [fk,setFk] = useState(initialFloor ?? floors[0] ?? 'opd:2'); // opens on the floor of the station used last
 const [mode,setMode] = useState<SceneMode>('3d');
 const [sel,setSel] = useState<string|null>(null);
 const floor = floors.includes(fk) ? fk : floors[0];
 useEffect(()=>{ setSel(null); },[floor]);
 if (!floor) return <p className="muted">ไม่มีจุดบริการที่ตรงกับตัวกรอง</p>;
 const [buildingId,lv] = floor.split(':'), level = Number(lv);
 const here = stations.filter(s=>floorKey(s)===floor);
 const stateOf = (list:Station[]) => list.some(s=>openIds.has(s.id)) ? 'busy' : list[0].roomId ? (({active:'free',break:'break',vacant:'closed'} as Record<string,string>)[doctors.get(list[0].id)?.status ?? 'vacant'] ?? 'closed') : 'free';
 const {marks,units} = floorStationMarks(floor,here,markLabel,stateOf);
 const chosen = sel ? marks.get(sel) : undefined, cs = chosen?.list[0];
 const states:[string,string][] = here.some(s=>s.roomId) ? [['free','มีแพทย์ออกตรวจ'],['break','แพทย์พัก'],['closed','ไม่มีแพทย์'],['busy','มีเจ้าหน้าที่เปิดอยู่']] : [['free','ยังไม่มีคนเปิด'],['busy','มีเจ้าหน้าที่เปิดอยู่']];
 return <div className="spMap">
  <div className="spFloorTabs">{floors.map(k=>{ const s = stations.find(x=>floorKey(x)===k)!, list = stations.filter(x=>floorKey(x)===k), types = [...new Set(list.map(typeOf))];
   return <button key={k} className={k===floor?'on':''} onClick={()=>setFk(k)}><b>{floorName(s)}</b><span>{types.map(t=>{ const [,l,c] = stationTypes.find(x=>x[0]===t)!; return <em key={t} style={{'--tc':c} as React.CSSProperties}>{l}</em>; })}</span></button>; })}</div>
  <div className="spStage">
   <FloorScene buildingId={buildingId} level={level} minute={minute} patients={patients} units={units} selected={sel} onSelect={id=>setSel(id||null)} mode={mode}/>
   <div className="bedStageBar">
    <strong>{floorName(here[0])}</strong>
    <div className="bedLegend">{states.map(([k,l])=><span key={k}><i className={'bedSwatch '+k}/>{l}</span>)}</div>
    <div className="viewSwitch inline">{(['2d','3d'] as const).map(x=><button key={x} className={mode===x?'active':''} onClick={()=>setMode(x)}>{x.toUpperCase()}</button>)}</div>
   </div>
   <div className={'spPickBar'+(chosen?' on':'')}>{!chosen || !cs ? <span className="muted">คลิกห้องหรือช่องบริการบนผังเพื่อเลือก · ลากเพื่อเลื่อน · เลื่อนลูกกลิ้งเพื่อซูม</span> : <>
    <span className="spBadge" style={{'--tc':typeInfo(cs)[2]} as React.CSSProperties}>{cs.clinicKey ? clinicLetter.get(cs.clinicKey) : (()=>{ const I = typeInfo(cs)[3]; return <I size={15}/>; })()}</span>
    <div className="spPickInfo"><b>{chosen.list.length>1 ? `${typeInfo(cs)[1]} · ${chosen.list.length} ช่อง` : cs.label}</b>
     <small>{cs.section}{cs.roomId ? ` · ${doctors.get(cs.id)?.name || 'ไม่มีแพทย์เข้าเวร'}` : ''} · รอ {waitingBy.get(cs.group) ?? 0} คน</small></div>
    {chosen.list.length>1 ? <div className="chipRow">{chosen.list.map(s=><button key={s.id} className="btn" onClick={()=>onPick(s.id)}>{s.label.replace(/^ช่อง|^จุด/,'')}{openIds.has(s.id) && <i className="spDot"/>}</button>)}</div>
     : <button className="btn primary" onClick={()=>onPick(cs.id)}>เข้าใช้จุดนี้</button>}
    <button className="linkBtn dark" onClick={()=>setSel(null)}>ยกเลิก</button></>}</div>
  </div>
 </div>;
}

// Webcam QR scanning with the browser's built-in BarcodeDetector (Chrome / Edge / Android). A USB/Bluetooth
// barcode scanner needs none of this: it types into the scan box like a keyboard.
type Detector = {detect:(v:HTMLVideoElement)=>Promise<{rawValue:string}[]>};
export function CameraScanner({onResult,onClose,title='สแกน QR บนบัตรคิว'}:{onResult:(t:string)=>void;onClose:()=>void;title?:string}) {
 const video = useRef<HTMLVideoElement>(null);
 const [err,setErr] = useState('');
 useEffect(()=>{
  const BD = (window as unknown as {BarcodeDetector?:new (o:{formats:string[]})=>Detector}).BarcodeDetector;
  if (!BD) { setErr('เบราว์เซอร์นี้ไม่รองรับการสแกนด้วยกล้อง · ใช้เครื่องสแกนบาร์โค้ด หรือ Chrome / Edge'); return; }
  let stream:MediaStream|undefined, stop = false;
  const detector = new BD({formats:['qr_code']});
  navigator.mediaDevices?.getUserMedia({video:{facingMode:'environment'}}).then(async s=>{
   stream = s; if (!video.current) return; video.current.srcObject = s; await video.current.play();
   const loop = async () => { if (stop || !video.current) return;
    try { const r = await detector.detect(video.current); if (r[0]) { onResult(r[0].rawValue); return; } } catch { /* keep trying */ }
    setTimeout(loop,250); };
   loop();
  }).catch(()=>setErr('เปิดกล้องไม่ได้ · ตรวจสอบสิทธิ์การใช้กล้องของเบราว์เซอร์'));
  return ()=>{ stop = true; stream?.getTracks().forEach(t=>t.stop()); };
 },[onResult]);
 return <div className="camModal" role="dialog" aria-label="สแกน QR ด้วยกล้อง"><div className="camBox">
  <div className="panelHead"><h3>{title}</h3><button className="iconBtn" aria-label="ปิด" onClick={onClose}><X size={18}/></button></div>
  {err ? <p className="serviceNote">{err}</p> : <video ref={video} muted playsInline/>}
 </div></div>;
}

// ---- Overview: one table, grouped any way (two levels), for supervisors ------------------------------------
type GroupKey = 'dept'|'floor'|'station'|'doctor'|'status'|'step';
const groupKeys:[GroupKey,string][] = [['dept','แผนก / จุดบริการ'],['station','ห้อง / ช่อง'],['doctor','แพทย์'],['status','สถานะ'],['floor','อาคาร / ชั้น'],['step','ขั้นตอน']];
const overviewStatuses:(PatientStatus|'all')[] = ['all','long','calling','serving','held','missed','result'];
// Board cards: a clinic (screening → exam → follow-up) or a shared service point (registration, lab, pharmacy…).
const svcCard:Record<string,[string,string]> = {registration:['ลงทะเบียน','registration'],lab:['ห้องเจาะเลือด','lab'],xray:['รังสีวิทยา','xray'],pharmacy:['ห้องยา','pharmacy'],finance:['การเงิน','finance'],er:['ห้องฉุกเฉิน','triage']};
const cardKeyOf = (s:PatientState) => s.p.flow==='er' && ['triage','treatment','admit'].includes(s.step.kind) ? 'er'
 : s.p.clinicKey && ['screening','exam','followup','labResult'].includes(s.step.kind) ? `clinic:${s.p.clinicKey}` : s.step.kind;
const clinicsByKey = {get:(key:string)=>opdClinics().find(c=>c.key===key)};
const cardName = (key:string) => key.startsWith('clinic:') ? clinicsByKey.get(key.slice(7))?.dept ?? key : svcCard[key]?.[0] ?? stepText[key as StepKind]?.serve ?? key;
const severityText = {critical:'วิกฤต',warn:'เฝ้าระวัง',ok:'ปกติ'} as const;
type SavedView = {name:string; g1:GroupKey; g2:GroupKey|''; filter:PatientStatus|'all'; q:string};
function OverviewTab({patients,m,onOpen,queue,assist,onOpenSettings,onOpenPlace}:{patients:Patient[];m:number;onOpen:(id:string)=>void;queue:QueueControl;assist:AssistView;onOpenSettings:(group:string|null)=>void;onOpenPlace:OpenPlace}) {
 const [sel,setSel] = useState<Set<string>>(new Set());
 const [views,setViews] = useState<SavedView[]>([]);
 const [viewName,setViewName] = useState('');
 const [logOpen,setLogOpen] = useState(false);
 const [logQ,setLogQ] = useState('');
 const [note,setNote] = useState<string|null>(null);
 useEffect(()=>{ try { setViews(JSON.parse(loadPref('hdt.queueViews','[]'))); } catch { /* none */ } },[]);
 useEffect(()=>{ if (!note) return; const t = setTimeout(()=>setNote(null),4000); return ()=>clearTimeout(t); },[note]);
 const saveViews = (v:SavedView[]) => { setViews(v); savePref('hdt.queueViews',JSON.stringify(v)); };
 const [g1,setG1] = useState<GroupKey>('dept');
 const [g2,setG2] = useState<GroupKey|''>(''); // one level by default: open a group, see the patients
 const [filter,setFilter] = useState<PatientStatus|'all'>('all');
 const [q,setQ] = useState('');
 const [closed,setClosed] = useState<Set<string>>(new Set());
 const rows = useMemo(()=>patients.map(p=>patientAt(p,m)).filter((s):s is PatientState=>!!s && s.p.flow!=='ipd' && s.status!=='done' && s.step.kind!=='kiosk'),[patients,m]);
 // The room / counter a row belongs to right now (called, being served, or sent there).
 const rowStation = (s:PatientState) => stationById(s.step.manual ?? s.step.assigned ?? (m>=s.step.called ? s.step.stationId : undefined));
 const stationOfRow = (s:PatientState) => { const st = rowStation(s); if (st) return st.label;
  return m<s.step.called ? (groupOf(s.p,s.step.kind) ? 'รอเรียก (คิวรวม)' : stepText[s.step.kind].wait) : stepText[s.step.kind].serve; };
 const doctorOfRow = (s:PatientState) => { const st = rowStation(s); return st?.roomId ? stationDoctor(st,m)?.name || 'ไม่มีแพทย์' : '—'; };
 const keyOf = (k:GroupKey, s:PatientState) => k==='dept' ? cardName(cardKeyOf(s)) : k==='floor' ? placeText(s,m).split(' · ').pop() ?? '' : k==='station' ? stationOfRow(s)
  : k==='doctor' ? (doctorOfRow(s)==='—' ? 'ไม่ได้อยู่ที่ห้องตรวจแพทย์' : doctorOfRow(s)) : k==='status' ? statusText[s.status] : stepText[s.step.kind].serve;
 const [focus,setFocus] = useState<string|null>(null); // board card picked: the table shows just that department / service
 const [mapOpen,setMapOpen] = useState(false);
 const [mapFloor,setMapFloor] = useState('opd:2');
 const [mapPatient,setMapPatient] = useState<string|null>(null);
 // Bumped by table clicks: the map glides to that patient, even when they were already selected.
 const [mapFollow,setMapFollow] = useState(0);
 useEffect(()=>{ setMapOpen(loadPref('hdt.ovMap','0')==='1'); },[]);
 const showMap = (on:boolean) => { setMapOpen(on); savePref('hdt.ovMap',on?'1':'0'); };
 const [more,setMore] = useState(false);
 const shown = rows.filter(s=>!focus || cardKeyOf(s)===focus).filter(s=>filter==='all' || s.status===filter).filter(s=>!q.trim() || s.p.queue.includes(q.trim().toUpperCase()) || s.p.dept.includes(q.trim()) || s.p.hn.replace(/\D/g,'').endsWith(q.replace(/\D/g,'') || '#'));
 const waitOf = (list:PatientState[]) => Math.max(0,...list.filter(s=>m<s.step.called).map(s=>s.stepWait));
 // Longest wait first, so the group that needs attention is on top.
 const group = (list:PatientState[], k:GroupKey) => [...list.reduce((map,s)=>map.set(keyOf(k,s),[...(map.get(keyOf(k,s))??[]),s]),new Map<string,PatientState[]>()).entries()].sort((a,b)=>waitOf(b[1])-waitOf(a[1]));
 const toggle = (id:string) => setClosed(c=>{ const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
 const byId = new Map(rows.map(s=>[s.p.id,s]));
 const toggleSel = (id:string) => setSel(c=>{ const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
 const selected = [...sel].map(id=>byId.get(id)).filter((x):x is PatientState=>!!x && m<x.step.called && x.status!=='calling');
 // Any station that serves every selected step and has a doctor on duty (rooms nobody runs on screen are served by the simulator).
 // Several patients move together only from one queue (same service group), so the same destinations fit them all.
 const bulkGroups = new Set(selected.map(stepGroup)), bulkFrom = selected.length && bulkGroups.size===1 ? (rowStation(selected[0]) ?? allStations().find(st=>st.group===stepGroup(selected[0]))) : undefined;
 const [bulkOpen,setBulkOpen] = useState(false);
 const openIds = useMemo(()=>new Set(openStations(queue.events).map(x=>x.id)),[queue.events]);
 // Supervisor moves are logged under the pseudo-station 'supervisor'.
 const moveMany = async (list:PatientState[], target:string, position:'keep'|'end'='keep', reason?:string) => {
  if (!queue.canAct) return;
  let ok = 0;
  for (const s of list) { const r = await queue.send({action:'transfer',at:m,station:'supervisor',patientId:s.p.id,step:s.index,target,position,reason,by:loadPref('hdt.operator','') || undefined}); if (r.ok) ok++; }
  setSel(new Set()); setBulkOpen(false); setNote(`ย้าย ${ok} คิวไป ${stationById(target)?.label} แล้ว`);
 };
 const log = [...queue.events].sort((a,b)=>b.at-a.at).filter(e=>{ const t = logQ.trim(); if (!t) return true; const p = e.patientId ? patients.find(x=>x.id===e.patientId) : undefined;
  return (p?.queue.includes(t.toUpperCase())) || (scopeName(e.station).includes(t)) || (e.reason?.includes(t)) || (e.by?.includes(t)) || actionText[e.action].includes(t); });
 // Board: every department / service point with people in it, worst first.
 const board = useMemo(()=>{
  const map = new Map<string,PatientState[]>();
  rows.forEach(s=>{ const k = cardKeyOf(s); map.set(k,[...(map.get(k) ?? []),s]); });
  return [...map.entries()].map(([key,list])=>{
   const w = list.filter(s=>m<s.step.called && (s.status==='waiting'||s.status==='long'));
   const long = w.filter(s=>s.status==='long').length, max = w.length ? Math.max(...w.map(s=>s.stepWait)) : 0, avg = w.length ? w.reduce((n,s)=>n+s.stepWait,0)/w.length : 0;
   const stations = key.startsWith('clinic:') ? allStations().filter(st=>st.clinicKey===key.slice(7)) : allStations().filter(st=>st.group===`counter:${svcCard[key]?.[1] ?? key}`);
   const bad = stations.filter(st=>['stalled','slow','paused'].includes(assist.health.get(st.id)?.state ?? ''));
   // Clinic waiting area: patients sitting there against the chairs the floor plan has (relatives use seats too).
   const c = key.startsWith('clinic:') ? clinicsByKey.get(key.slice(7)) : undefined;
   const seats = c ? waitingSeats('opd',c.level) : 0, seated = c ? list.filter(s=>m<s.step.called && s.area.buildingId==='opd' && s.area.level===c.level).length : 0, fill = seats ? seated/seats : 0;
   const severity:'critical'|'warn'|'ok' = long>=5 || max>=90 || fill>=1 || bad.some(st=>assist.health.get(st.id)?.state==='stalled') ? 'critical' : long>0 || max>=45 || fill>=0.8 || bad.length ? 'warn' : 'ok';
   return {key,name:cardName(key),list,waiting:w.length,long,max,avg,stations,bad,severity,seats,seated,fill};
  }).filter(c=>c.list.length).sort((x,y)=>({critical:0,warn:1,ok:2}[x.severity]-{critical:0,warn:1,ok:2}[y.severity]) || y.max-x.max);
 },[rows,m,assist]);
 const cardBadge = (key:string) => { if (key.startsWith('clinic:')) return <span className="spBadge" style={{'--tc':'#2a78d6'} as React.CSSProperties}>{clinicLetter.get(key.slice(7))}</span>;
  const t = stationTypes.find(x=>x[0]===(svcCard[key]?.[1] ?? key)), I = t?.[3] ?? LayoutList; return <span className="spBadge" style={{'--tc':t?.[2] ?? '#60738a'} as React.CSSProperties}><I size={14}/></span>; };
 const dotOf = (st:Station) => { const h = assist.health.get(st.id)?.state ?? 'auto'; return h==='ok' ? 'ok' : h==='auto' ? 'auto' : h==='away' ? 'away' : h==='paused' || h==='slow' ? 'warn' : 'bad'; };
 const autoOpen = !!focus || !!q.trim() || filter!=='all';
 const isOpen = (id:string) => autoOpen ? !closed.has(id) : closed.has(id); // `closed` holds the groups the user flipped
 const totals = {waiting:board.reduce((n,c)=>n+c.waiting,0),long:board.reduce((n,c)=>n+c.long,0),critical:board.filter(c=>c.severity==='critical').length};
 const row = (s:PatientState) => { const w = m<s.step.called ? Math.round(s.stepWait) : undefined, st = stationById(s.step.manual ?? s.step.assigned ?? (m>=s.step.called ? s.step.stationId : undefined)), d = st?.roomId ? stationDoctor(st,m) : undefined;
  return <tr key={s.p.id} id={`ovr-${s.p.id}`} onClick={()=>{ setMapPatient(s.p.id); setMapFollow(n=>n+1); setMapFloor(`${s.area.buildingId}:${s.area.level}`); showMap(true); }} className={(sel.has(s.p.id)?'selRow ':'')+(mapPatient===s.p.id?'mapSel':'')}>
  <td onClick={e=>e.stopPropagation()}><input type="checkbox" aria-label={`เลือก ${s.p.queue}`} disabled={!(m<s.step.called) || s.status==='calling'} checked={sel.has(s.p.id)} onChange={()=>toggleSel(s.p.id)}/></td>
  <td><b className="ovQueue">{s.p.queue}</b>{priorityOf(s.p) && <> <PriorityTag p={priorityOf(s.p)!} iconOnly/></>}{g1!=='dept' && !focus && <small className="ovSub">{cardName(cardKeyOf(s))}</small>}</td>
  <td>{w!==undefined ? <span className={'ovWait'+(w>=LONG_WAIT?' long':w>=25?' mid':'')}><i style={{width:`${Math.min(100,w/120*100)}%`}}/><b>{fmtDur(w,true)}</b></span> : <span className="muted">—</span>}</td>
  <td>{m<s.step.called?stepText[s.step.kind].wait:stepText[s.step.kind].serve}</td>
  <td>{st ? <>{st.label}{d && <small className="ovSub">{d.name || 'ไม่มีแพทย์'}</small>}</> : <span className="muted">คิวรวม</span>}</td>
  <td>{s.status!=='waiting' && s.status!=='long' && <span className="statusPill" style={{color:statusColor[s.status],borderColor:statusColor[s.status]}}>{statusText[s.status]}</span>}</td>
  {/* Own column, so the buttons line up on every row whatever the status. */}
  <td className="ovActCell" onClick={e=>e.stopPropagation()}><span className="ovRowActs"><QrButton p={s.p}/><button className={'mapBtn'+(mapPatient===s.p.id && mapOpen?' on':'')} title={`ดู ${s.p.queue} บนผัง`} aria-label={`ดู ${s.p.queue} บนผัง`} onClick={e=>{ e.stopPropagation(); setMapPatient(s.p.id); setMapFollow(n=>n+1); setMapFloor(`${s.area.buildingId}:${s.area.level}`); showMap(true); }}><MapPin size={14}/></button></span></td></tr>; };
 // Where a board card / group is on the map.
 const svcPlace:Record<string,[string,number]> = {registration:['opd',1],pharmacy:['opd',1],finance:['opd',1],lab:['diagnostics',1],xray:['diagnostics',2],er:['er',1],triage:['er',1]};
 const cardPlace = (key:string):[string,number,string?]|undefined => { if (key.startsWith('clinic:')) { const c = clinicsByKey.get(key.slice(7)); return c ? ['opd',c.level] : undefined; } return svcPlace[key]; };
 const groupPlace = (list:PatientState[], k:GroupKey):[string,number,string?]|undefined => {
  if (k==='dept') return cardPlace(cardKeyOf(list[0]));
  if (k==='station' || k==='doctor') { const st = rowStation(list[0]); return st ? [st.buildingId,st.level,st.roomId] : cardPlace(cardKeyOf(list[0])); }
  return undefined; };
 // Map buttons open the floor plan beside the table (no page switch); the full map is one click away inside it.
 const mapBtn = (place:[string,number,string?]|undefined, label:string) => place ? <button className="mapBtn" title={`ดู${label}บนผัง`} aria-label={`ดู${label}บนผัง`}
  onClick={e=>{ e.stopPropagation(); setMapFloor(`${place[0]}:${place[1]}`); setMapPatient(null); showMap(true); }}><MapPin size={14}/> ผัง</button> : null;
 const pickOnMap = (id:string) => { setMapPatient(id); setTimeout(()=>document.getElementById(`ovr-${id}`)?.scrollIntoView({block:'center',behavior:'smooth'}),50); };
 useEffect(()=>{ if (focus) { const pl = cardPlace(focus); if (pl) setMapFloor(`${pl[0]}:${pl[1]}`); } },[focus]); // eslint-disable-line react-hooks/exhaustive-deps
 // Group header in the table's own columns: name | longest wait (and average) | — | room / map | long waits.
 const grpRow = (id:string, label:string, list:PatientState[], open:boolean, level:1|2) => {
  const w = list.filter(s=>m<s.step.called), max = w.length ? Math.round(Math.max(...w.map(s=>s.stepWait))) : 0, avg = w.length ? Math.round(w.reduce((n,s)=>n+s.stepWait,0)/w.length) : 0;
  const long = list.filter(s=>s.status==='long').length, sev = long>=5 || max>=90 ? 'critical' : long>0 || max>=LONG_WAIT ? 'warn' : 'ok';
  return <tr key={id} className={`grpRow l${level} ${sev}`} onClick={()=>toggle(id)} aria-expanded={open}>
   <td>{open?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</td>
   <td><b>{label}</b><small className="ovSub">{list.length} คน · รอ {w.length}</small></td>
   <td>{w.length ? <><span className={'ovWait'+(max>=LONG_WAIT?' long':max>=25?' mid':'')} title="รอนานสุดในกลุ่ม"><i style={{width:`${Math.min(100,max/120*100)}%`}}/><b>{fmtDur(max,true)}</b></span><small className="ovSub">นานสุด · เฉลี่ย {fmtDur(avg,true)}</small></> : <span className="muted">ไม่มีคนรอ</span>}</td>
   <td/>
   <td>{mapBtn(groupPlace(list,level===1?g1:(g2 || g1)),label)}</td>
   <td>{long>0 && <span className="longPill">รอนาน {long}</span>}</td>
   <td/>
  </tr>; };
 return <section className="panel overview">
  <div className="ovBoardHead"><b>สถานการณ์ตอนนี้</b><span className="muted">รอทั้งหมด <b>{totals.waiting}</b> คน · รอนานเกิน {LONG_WAIT} นาที <b className={totals.long?'bad':''}>{totals.long}</b> คน{totals.critical?<> · <b className="bad">{totals.critical} จุดวิกฤต</b></>:''}</span>
   {focus && <span className="ovFocusActs">{mapBtn(cardPlace(focus),cardName(focus))}<button className="linkBtn dark" onClick={()=>setFocus(null)}>ดูทุกแผนก</button></span>}</div>
  <div className="ovBoard">{board.filter(c=>c.severity!=='ok' || focus===c.key).map(c=><button key={c.key} className={`ovCard ${c.severity}`+(focus===c.key?' on':'')} onClick={()=>setFocus(focus===c.key?null:c.key)} aria-pressed={focus===c.key}>
   <span className="ovCardTop">{cardBadge(c.key)}<b className="ovName">{c.name}</b><em className={'sev '+c.severity}>{severityText[c.severity]}</em></span>
   {c.seats>0 && <span className={'ovSeats'+(c.fill>=1?' full':c.fill>=0.8?' near':'')} title="ผู้ป่วยที่นั่งรอในโซนของแผนก เทียบกับเก้าอี้ในผัง (ญาติก็ใช้ที่นั่งด้วย)">
    <i><i style={{width:`${Math.min(100,c.fill*100)}%`}}/></i>ที่นั่ง {c.seated}/{c.seats}{c.fill>=1?' · เต็ม':c.fill>=0.8?' · ใกล้เต็ม':''}</span>}
   <span className="ovNums"><span><b>{c.waiting}</b><small>รอ</small></span><span><b className={c.long?'bad':''}>{c.long}</b><small>รอนาน</small></span><span><b className="dur">{fmtDur(c.max,true)}</b><small>รอนานสุด</small></span></span>
   <span className="ovDots" title={c.stations.map(st=>`${st.label}: ${healthText[assist.health.get(st.id)?.state ?? 'auto']}`).join('\n')}>{c.stations.slice(0,8).map(st=><i key={st.id} className={dotOf(st)}/>)}
    {c.bad.length ? <small className="bad">{c.bad.map(st=>`${st.roomId?st.label.replace('ห้องตรวจ ','ห้อง '):st.label.replace(/^.* (\d+)$/,'ช่อง $1')} ${healthText[assist.health.get(st.id)!.state]}`).slice(0,2).join(' · ')}</small> : <small>{c.stations.length} {c.key.startsWith('clinic:')?'ห้อง/ช่อง':'ช่อง'}</small>}</span>
  </button>)}</div>
  {board.some(c=>c.severity==='ok' && focus!==c.key) && <div className="ovOk"><span className="sev ok">ปกติ</span>
   {board.filter(c=>c.severity==='ok' && focus!==c.key).map(c=><button key={c.key} className="ovChip" onClick={()=>setFocus(c.key)} title={`รอ ${c.waiting} คน · นานสุด ${fmtDur(c.max)}`}>{cardBadge(c.key)}{c.name}<b>{c.waiting}</b></button>)}</div>}
  <AssistPanel assist={assist} queue={queue} m={m} patients={patients} onOpenSettings={onOpenSettings}/>
  <div className="ovTools">
   <input className="miniSearch big" value={q} onChange={e=>setQ(e.target.value)} placeholder="ค้นหาคิว / เลขท้าย HN"/>
   <div className="viewSwitch inline">{groupKeys.slice(0,4).map(([k,l])=><button key={k} className={g1===k?'active':''} onClick={()=>{ setG1(k); if (g2===k) setG2(''); }}>{l}</button>)}</div>
   <div className="chipRow">{overviewStatuses.map(f=><button key={f} className={'chip'+(filter===f?' on':'')} onClick={()=>setFilter(f)}>{f!=='all' && <i style={{background:statusColor[f]}}/>}{f==='all'?'ทั้งหมด':statusText[f]}</button>)}</div>
   <button className={'btn ghost'+(mapOpen?' on':'')} onClick={()=>showMap(!mapOpen)}><MapPin size={14}/> {mapOpen?'ซ่อนผัง':'แสดงผัง'}</button>
   <button className={'linkBtn dark'+(more?' on':'')} onClick={()=>setMore(o=>!o)}>{more?<ChevronDown size={14}/>:<ChevronRight size={14}/>} ปรับมุมมอง</button>
  </div>
  {more && <div className="ovMore">
   <label>จัดกลุ่มตาม <select value={g1} onChange={e=>setG1(e.target.value as GroupKey)}>{groupKeys.map(([k,l])=><option key={k} value={k}>{l}</option>)}</select></label>
   <label>แล้วแบ่งย่อยตาม <select value={g2} onChange={e=>setG2(e.target.value as GroupKey|'')}><option value="">— ไม่แบ่งย่อย —</option>{groupKeys.filter(([k])=>k!==g1).map(([k,l])=><option key={k} value={k}>{l}</option>)}</select></label>
   <span className="viewsBar"><span>มุมมองที่บันทึก</span>
    {views.map(v=><span key={v.name} className="viewChip"><button onClick={()=>{ setG1(v.g1); setG2(v.g2); setFilter(v.filter); setQ(v.q); }}>{v.name}</button>
     <button aria-label={`ลบ ${v.name}`} onClick={()=>saveViews(views.filter(x=>x.name!==v.name))}><X size={12}/></button></span>)}
    <input value={viewName} onChange={e=>setViewName(e.target.value)} maxLength={30} placeholder="ตั้งชื่อมุมมองนี้"/>
    <button className="btn ghost" disabled={!viewName.trim()} onClick={()=>{ saveViews([...views.filter(x=>x.name!==viewName.trim()),{name:viewName.trim(),g1,g2,filter,q}]); setViewName(''); }}>บันทึก</button></span>
  </div>}
  {selected.length>0 && <div className="bulkBar"><b>เลือก {selected.length} คน</b><span className="muted">{selected.slice(0,6).map(x=>x.p.queue).join(', ')}{selected.length>6?' …':''}</span>
   {bulkFrom ? <button className="btn" disabled={!queue.canAct} onClick={()=>setBulkOpen(true)}><ArrowLeftRight size={14}/> ย้าย / ส่งต่อ…</button>
    : <span className="bulkWarn">เลือกเฉพาะคนในคิวเดียวกัน (เช่น รอพบแพทย์แผนกเดียวกัน) เพื่อย้ายพร้อมกัน</span>}
   <button className="linkBtn dark" onClick={()=>setSel(new Set())}>ยกเลิกการเลือก</button></div>}
  {bulkOpen && bulkFrom && <MoveDialog list={selected} from={bulkFrom} atFrom={new Set(selected.map(x=>rowStation(x)?.id)).size===1 && !!rowStation(selected[0])} patients={patients} minute={m} openIds={openIds} assist={assist} onClose={()=>setBulkOpen(false)} onMove={(t,pos,r)=>void moveMany(selected,t,pos,r)}/>}
  {note && <p className="consoleMsg" role="status">{note}</p>}
  <div className={'ovSplit'+(mapOpen?' withMap':'')}>
  <div className="tableWrap tall"><table className="dataTable grouped ovTable">
   <colgroup><col className="cSel"/><col className="cQ"/><col className="cWait"/><col className="cStep"/><col/><col className="cEnd"/><col className="cAct"/></colgroup>
   <thead><tr><th/><th>คิว</th><th>รอ</th><th>ขั้นตอน</th><th>ห้อง / ช่อง</th><th>สถานะ</th><th><span className="srOnly">QR / ผัง</span></th></tr></thead>
   {group(shown,g1).map(([k1,l1])=>{ const id1 = `${g1}:${k1}`, open1 = isOpen(id1);
    return <tbody key={id1}>
     {grpRow(id1,k1,l1,open1,1)}
     {open1 && (g2 ? group(l1,g2).flatMap(([k2,l2])=>{ const id2 = `${id1}/${k2}`, open2 = !closed.has(id2);
      return [grpRow(id2,k2,l2,open2,2),...(open2 ? l2.sort((a,b)=>b.stepWait-a.stepWait).map(row) : [])]; }) : l1.sort((a,b)=>b.stepWait-a.stepWait).map(row))}
    </tbody>; })}
  </table></div>
  {mapOpen && <OverviewMap floor={mapFloor} onFloor={setMapFloor} focusKey={focus} patients={patients} minute={m} assist={assist} patient={mapPatient} follow={mapPatient ? `${mapPatient}:${mapFollow}` : null} onPickPatient={pickOnMap} onOpenPatient={onOpen} onOpenPlace={onOpenPlace} onClose={()=>showMap(false)}/>}
  </div>
  {!shown.length && <p className="muted">ไม่มีผู้ป่วยตามเงื่อนไข</p>}
  <p className="note">{autoOpen?'คลิกหัวกลุ่มเพื่อย่อ':'คลิกการ์ดด้านบนหรือหัวกลุ่มเพื่อดูรายชื่อ'} · คลิกแถวเพื่อดูตำแหน่งบนผัง · ติ๊กเลือกเพื่อย้ายหลายคนพร้อมกัน · ไอคอนข้างเลขคิว = คิวพิเศษ (ชี้เพื่อดูประเภท) · {rows.length} คนในระบบตอนนี้</p>
  <div className="auditBox">
   <button className="linkBtn dark" onClick={()=>setLogOpen(o=>!o)}>{logOpen?<ChevronDown size={14}/>:<ChevronRight size={14}/>} ประวัติการดำเนินการวันนี้ ({queue.events.length})</button>
   {logOpen && <>
    <input className="miniSearch" value={logQ} onChange={e=>setLogQ(e.target.value)} placeholder="คิว / จุดบริการ / ผู้ปฏิบัติงาน / การกระทำ"/>
    <div className="tableWrap"><table className="dataTable compact">
     <thead><tr><th>เวลา</th><th>จุดบริการ</th><th>การกระทำ</th><th>คิว</th><th>รายละเอียด</th><th>ผู้ปฏิบัติงาน</th></tr></thead>
     <tbody>{log.slice(0,200).map(e=><tr key={e.id}><td className="num">{fmtTime(e.at)}</td><td>{e.station==='supervisor'?'ผู้ประสานงาน':scopeName(e.station)}</td><td>{actionText[e.action]}</td>
      <td><b>{patients.find(x=>x.id===e.patientId)?.queue ?? '—'}</b></td><td className="muted">{[e.target?`→ ${stationById(e.target)?.label}`:'',e.reason].filter(Boolean).join(' · ')}</td><td>{e.by ?? <span className="muted">ไม่ระบุ</span>}</td></tr>)}</tbody>
    </table></div>
    {!log.length && <p className="muted">ยังไม่มีการดำเนินการ</p>}
    <p className="note">บันทึกนี้ใช้ตอบข้อร้องเรียน เช่น "เรียกแล้วไม่ได้ยิน" · ของจริงต้องผูกกับผู้ใช้ที่ล็อกอินและเก็บถาวรในฐานข้อมูล</p>
   </>}
  </div>
 </section>;
}

const phaseText = {triage:'คัดแยก',waiting:'รอรักษา',treatment:'กำลังรักษา',boarding:'รอเตียงหอผู้ป่วย',other:''};
// Floor plan beside the overview table: stations coloured by how they are keeping up, patients clickable both ways.
const healthUnit:Record<string,string> = {ok:'free',auto:'free',paused:'break',slow:'break',away:'break',stalled:'boarding'};
function OverviewMap({floor,onFloor,focusKey,patients,minute,assist,patient,follow,onPickPatient,onOpenPatient,onOpenPlace,onClose}:{floor:string;onFloor:(f:string)=>void;focusKey?:string|null;patients:Patient[];minute:number;assist:AssistView;follow?:string|null;
  patient:string|null;onPickPatient:(id:string)=>void;onOpenPatient:(id:string)=>void;onOpenPlace:OpenPlace;onClose:()=>void}) {
 const [mode,setMode] = useState<SceneMode>('3d');
 const [whole,setWhole] = useState(false);
 const m = Math.floor(minute);
 const floors = useMemo(()=>sortFloors(allStations().map(floorKey)),[layoutRevision()]); // eslint-disable-line react-hooks/exhaustive-deps
 const waiting = useMemo(()=>waitingByGroup(patients,m),[patients,m]);
 const [buildingId,lv] = floor.split(':'), level = Number(lv);
 const here = allStations().filter(st=>floorKey(st)===floor);
 const stateOf = (list:Station[]) => { const states = list.map(st=>{ const d = stationDoctor(st,m); return st.roomId && (!d?.name || d.status==='vacant') ? 'closed' : healthUnit[assist.health.get(st.id)?.state ?? 'auto']; });
  return ['boarding','break','free','closed'].find(x=>states.includes(x)) ?? 'free'; };
 const labelOf = (id:string, list:Station[]) => { const n = id.startsWith('grp:') || !list[0].roomId ? waiting.get(list[0].group) ?? 0 : assist.loads.get(list[0].id)?.length ?? 0;
  return `${markLabel(id,list)} · รอ ${n}`; };
 const {units} = floorStationMarks(floor,here,labelOf,stateOf);
 // Zoom to the chosen clinic's rooms and waiting area when it is on this floor.
 const fc = focusKey?.startsWith('clinic:') ? opdClinics().find(c=>c.key===focusKey.slice(7)) : undefined;
 const area = fc && buildingId==='opd' && fc.level===level && !whole ? deptArea('opd',level,fc.deptIndex) : undefined;
 // The assistant's proposals on this floor, as arrows from station to station.
 const arrows = assist.suggestions.filter(sg=>floorKey(sg.from)===floor && floorKey(sg.to)===floor).map(sg=>({from:{x:sg.from.spot.x,z:sg.from.spot.z},to:{x:sg.to.spot.x,z:sg.to.spot.z}}));
 const sel = patient ? patients.find(p=>p.id===patient) : undefined, st = sel ? patientAt(sel,m) : undefined;
 return <div className="ovMap">
  <div className="ovMapHead">
   <select value={floor} onChange={e=>onFloor(e.target.value)} aria-label="เลือกชั้น">{floors.map(f=><option key={f} value={f}>{floorName(allStations().find(x=>floorKey(x)===f)!)}</option>)}</select>
   <div className="viewSwitch inline">{(['2d','3d'] as const).map(x=><button key={x} className={mode===x?'active':''} onClick={()=>setMode(x)}>{x.toUpperCase()}</button>)}</div>
   {fc && fc.level===level && buildingId==='opd' && <button className="chip" onClick={()=>setWhole(w=>!w)}>{whole?`ซูม ${fc.dept}`:'ดูทั้งชั้น'}</button>}
   <button className="linkBtn dark" onClick={()=>onOpenPlace(buildingId,level)}>เปิดแผนที่เต็ม</button>
   <button className="iconBtn" aria-label="ปิดแผนที่" onClick={onClose}><X size={16}/></button>
  </div>
  <div className="ovMapStage">
   <FloorScene buildingId={buildingId} level={level} minute={minute} patients={patients} units={units} selected={null} onSelect={()=>undefined} mode={mode} selectedPatient={patient} onPickPatient={onPickPatient} focus={area} arrows={arrows} follow={follow}/>
  </div>
  <div className="ovMapLegend">{([['free','ทันงาน'],['break','พัก / ช้า'],['boarding','ไม่ตอบรับ'],['closed','ไม่มีแพทย์']] as const).map(([k,l])=><span key={k}><i className={'bedSwatch '+(k==='boarding'?'boarding':k)}/>{l}</span>)}
   {arrows.length>0 && <span><i className="arrowKey"/>ข้อเสนอย้ายคิว ({arrows.length})</span>}
   <small className="muted">คลิกคนบนผังเพื่อหาในตาราง</small></div>
  {sel && st && <div className="ovMapPick"><b>{sel.queue}</b><span>{m<st.step.called?stepText[st.step.kind].wait:stepText[st.step.kind].serve} · {placeText(st,m)}{m<st.step.called?` · รอ ${fmtDur(st.stepWait,true)}`:''}</span>
   <QrButton p={sel} label="หน้า QR"/><button className="linkBtn dark" onClick={()=>onOpenPatient(sel.id)}>ดูการ์ดเต็ม</button></div>}
 </div>;
}

// Supervisor's view of the queue assistant: stations that are not keeping up, what it proposes (or did), and
// groups that are full. Moves from here are logged under the pseudo-station "supervisor".
function AssistPanel({assist,queue,m,patients,onOpenSettings}:{assist:AssistView;queue:QueueControl;m:number;patients:Patient[];onOpenSettings:(group:string|null)=>void}) {
 const [dismissed,setDismissed] = useState<Set<string>>(new Set());
 const [note,setNote] = useState<string|null>(null);
 useEffect(()=>{ if (!note) return; const t = setTimeout(()=>setNote(null),4000); return ()=>clearTimeout(t); },[note]);
 const byId = useMemo(()=>new Map(patients.map(p=>[p.id,p])),[patients]);
 const stranded = [...assist.stranded.entries()].filter(([id])=>rulesFor(queue.settings,stationById(id)!.group).mode!=='off');
 const openIds = new Set(openStations(queue.events).map(x=>x.id));
 const problems = allStations().filter(st=>{ const h = assist.health.get(st.id); return h && (['paused','stalled','slow'].includes(h.state) || (h.state==='away' && openIds.has(st.id))); });
 const sg = assist.suggestions.filter(x=>!dismissed.has(x.key));
 const pending = sg.filter(x=>rulesFor(queue.settings,x.group).mode==='suggest'), autoSoon = sg.filter(x=>rulesFor(queue.settings,x.group).mode==='auto');
 const sys = queue.events.filter(e=>e.by===SYSTEM_BY && e.action==='transfer' && m-e.at<30).slice().reverse();
 const reports = openReports(queue.events);
 const take = async (e:QueueEvent) => { const r = await queue.send({action:'resolve',at:m,station:'supervisor',patientId:e.patientId,step:e.step,target:e.id,by:loadPref('hdt.operator','') || undefined}); setNote(r.ok?`รับเรื่องของ ${byId.get(e.patientId ?? '')?.queue} แล้ว`:r.reason ?? 'ไม่สำเร็จ'); };
 const apply = async (x:Suggestion) => { let n = 0;
  for (const s of x.moves) { const r = await queue.send({action:'transfer',at:m,station:'supervisor',patientId:s.p.id,step:s.index,target:x.to.id,position:'keep',reason:`${suggestionText[x.kind]} · ${x.reason}`,by:loadPref('hdt.operator','') || undefined}); if (r.ok) n++; }
  setNote(`ย้าย ${n} คิวไป ${x.to.label} แล้ว`); };
 const [open,setOpen] = useState(false);
 useEffect(()=>{ setOpen(loadPref('hdt.assistOpen','0')==='1'); },[]);
 const toggle = () => setOpen(o=>{ savePref('hdt.assistOpen',o?'0':'1'); return !o; });
 const issues = problems.length+stranded.length+assist.full.size;
 return <div className={'assistBar'+(open?' open':'')}>
  <div className="abHead">
   <button className="abToggle" onClick={toggle} aria-expanded={open}>{open?<ChevronDown size={15}/>:<ChevronRight size={15}/>}<Sparkles size={15}/> ตัวช่วยกระจายคิว</button>
   {reports.length>0 && <button className="abCount help" onClick={()=>!open && toggle()}>ผู้ป่วยแจ้ง {reports.length}</button>}
   {pending.length>0 && <button className="abCount sg" onClick={()=>!open && toggle()}>{pending.length} ข้อเสนอ</button>}
   {issues>0 && <button className="abCount warn" onClick={()=>!open && toggle()}>{issues} จุดต้องดู</button>}
   {sys.length>0 && <button className="abCount" onClick={()=>!open && toggle()}>ระบบย้ายแล้ว {sys.reduce((n)=>n+1,0)}</button>}
   {!pending.length && !issues && !sys.length && !reports.length && <span className="muted">ทุกจุดทันงาน</span>}
   {autoSoon.length>0 && <span className="muted">กำลังย้ายอัตโนมัติ {autoSoon.reduce((n,x)=>n+x.moves.length,0)} คิว</span>}
   {note && <span className="abNote">{note}</span>}
   <button className="linkBtn dark abSet" onClick={()=>onOpenSettings(null)}>ตั้งค่า</button>
  </div>
  {open && <div className="abBody">
   {reports.map(e=><div key={e.id} className="aLine warn help"><Hand size={14}/><span className="aText"><em>ผู้ป่วยแจ้ง</em><b>{byId.get(e.patientId ?? '')?.queue}</b> {e.reason} · {scopeName(e.station.replace(/^group:/,''))} · {fmtMin(e.at)}</span>
    <button className="btn sm" disabled={!queue.canAct} onClick={()=>void take(e)}>รับเรื่อง</button></div>)}
   {pending.map(x=><div key={x.key} className="aLine"><span className="aText" title={x.reason}><em>{suggestionText[x.kind]}</em>
    <b>{x.moves.map(s=>s.p.queue).join(', ')}</b> {x.from.label} → <b>{x.to.label}</b> <small>{x.reason.split(': ').slice(-1)[0]}</small></span>
    <button className="btn sm" disabled={!queue.canAct} onClick={()=>void apply(x)}>ย้าย</button>
    <button className="iconBtn xs" aria-label="ไม่ต้อง" title="ไม่ต้อง" onClick={()=>setDismissed(d=>new Set(d).add(x.key))}><X size={13}/></button></div>)}
   {[...assist.full].map(g=><div key={g} className="aLine warn"><span className="aText"><em>คิวเต็ม</em><b>{groupName(g)}</b> ทุกช่องเกินเพดาน</span><button className="linkBtn dark" onClick={()=>onOpenSettings(g)}>ปรับเพดาน</button></div>)}
   {stranded.map(([id,n])=>{ const st = stationById(id)!; return <div key={id} className="aLine warn"><span className="aText"><em>ไม่มีที่รับแทน</em><b>{st.label}</b> {assist.health.get(id)?.text} · {n} คิว <small>ติ๊กในตารางเพื่อส่งข้ามแผนก</small></span></div>; })}
   {problems.filter(st=>!assist.stranded.has(st.id)).map(st=>{ const h = assist.health.get(st.id)!; return <div key={st.id} className="aLine"><span className="aText"><em className={h.state}>{healthText[h.state]}</em><b>{st.label}</b> {h.text}</span></div>; })}
   {sys.slice(0,8).map(e=><div key={e.id} className="aLine done"><span className="aText" title={e.reason}><em>ระบบย้าย</em><b>{byId.get(e.patientId ?? '')?.queue}</b> {stationById(e.station)?.label} → {stationById(e.target)?.label} · {fmtMin(e.at)}</span></div>)}
  </div>}
 </div>;
}

function ErTab({patients,m,onOpen}:{patients:Patient[];m:number;onOpen:(id:string)=>void}) {
 const er = useMemo(()=>erBoard(patients,m),[patients,m]);
 return <>
  <div className="tileRow">
   {er.byLevel.map(l=><div key={l.level} className="tile" style={{borderTopColor:l.color}}>
    <small>ระดับ {l.level} · {l.name}</small><b>{l.count}<em> คน</em></b>
    <span className={l.over?'warnText':'muted'}>{l.over?`เกินเป้า ${l.over} คน`:`เป้าหมาย ≤ ${l.target} นาที`}</span>
   </div>)}
   <div className="tile" style={{borderTopColor:'#6366f1'}}><small>รอเตียงหอผู้ป่วย</small><b>{er.boarding.length}<em> คน</em></b><span className="muted">ค้างอยู่ในเตียง ER</span></div>
  </div>
  <section className="panel">
   <div className="panelHead"><h3>ผู้ป่วยในห้องฉุกเฉิน</h3><small className="panelMeta">เรียงตามระดับความเร่งด่วน · เป้าหมายเป็นค่าตัวอย่าง ให้ รพ. กำหนดเอง</small></div>
   <div className="tableWrap"><table className="dataTable">
    <thead><tr><th>ระดับ</th><th>คิว</th><th>HN</th><th>ขั้นตอน</th><th className="num">รอขั้นนี้ (นาที)</th><th className="num">อยู่ใน ER (นาที)</th><th/></tr></thead>
    <tbody>{er.rows.map(r=><tr key={r.s.p.id} className={r.overTarget?'rowAlert':''}>
     <td><span className="triage" style={{background:triageLevels[r.triage-1].color}}>{r.triage}</span> {triageLevels[r.triage-1].name}</td>
     <td><b>{r.s.p.queue}</b></td><td className="muted">{maskHN(r.s.p.hn)}</td>
     <td>{phaseText[r.phase]}{r.overTarget && <span className="tag critical">เกินเป้า</span>}</td>
     <td className="num">{m<r.s.step.called?fmtDur(r.s.stepWait,true):'—'}</td><td className="num">{fmtDur(r.los,true)}</td>
     <td><button className="linkBtn dark" onClick={()=>onOpen(r.s.p.id)}>ดูบนแผนที่</button></td>
    </tr>)}</tbody>
   </table></div>
   {!er.rows.length && <p className="note">ขณะนี้ไม่มีผู้ป่วยในห้องฉุกเฉิน</p>}
  </section>
 </>;
}
