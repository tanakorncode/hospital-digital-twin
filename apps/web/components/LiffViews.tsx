'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { CalendarCheck, CheckCircle2, ChevronRight, Clock, MapPin, QrCode, Search, X } from 'lucide-react';
import { newKey, patientApi } from '../lib/patient-api';
import type { LiveVisit } from '../lib/patients';
import { deptDirectory } from '../lib/scene-data';
import { fetchDestinations, whereText, type Destination } from '../lib/wayfinding';

// The patient's own screens inside LINE (stage 2.6). Everything comes from the patient API, which only ever answers
// about the signed-in, linked patient. One task per screen, big text and buttons, plain Thai.
type Booking = {id:string; code:string; serviceName:string; startsAt:string; endsAt:string; status:string; cancellationReason?:string};
type Appt = {id:string; code:string; clinicCode:string; clinicName:string; providerName:string; startsAt:string; endsAt:string; status:string; cancellationReason?:string;
 pendingRequest?:{startsAt:string; providerName:string}};
type Slot = {id:string; startsAt:string; endsAt:string; remaining:number; providerName?:string};
const time = (iso:string) => new Date(iso).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'});
const day = (iso:string) => new Date(iso.length===10 ? `${iso}T12:00:00` : iso).toLocaleDateString('th-TH',{weekday:'long',day:'numeric',month:'long'});
const dayShort = (d:string) => new Date(`${d}T12:00:00`).toLocaleDateString('th-TH',{weekday:'short',day:'numeric',month:'short'});
const localDay = (iso:string) => new Date(iso).toLocaleDateString('sv-SE');
const plusDays = (n:number) => { const d = new Date(); d.setDate(d.getDate()+n); return d.toLocaleDateString('sv-SE'); };
const isToday = (iso:string) => localDay(iso)===plusDays(0);
const upcoming = (iso:string) => new Date(iso).getTime()>Date.now();

function Busy() { return <p className="liffWait">กำลังโหลด…</p>; }
function Problem({text,retry}:{text:string; retry?:()=>void}) {
 return <section className="liffCard"><p className="liffError" role="alert">{text}</p>{retry && <button className="liffBtn ghost" onClick={retry}>ลองใหม่</button>}</section>;
}
// The code for the kiosk, as text and as a QR its scanner can read.
function CodeQr({code}:{code:string}) {
 const [src,setSrc] = useState('');
 useEffect(()=>{ void QRCode.toDataURL(code,{margin:1,width:220}).then(setSrc); },[code]);
 return <div className="liffCodeQr">{src && <img src={src} alt={`QR รหัส ${code}`}/>}<b className="liffCode small">{code}</b><small className="liffNote">สแกนที่ตู้เช็กอิน หรือแจ้งรหัสนี้ที่เคาน์เตอร์</small></div>;
}

// ---- คิวของฉัน -------------------------------------------------------------------------------------------------------
export function MyQueue() {
 const [data,setData] = useState<{visits:(LiveVisit & {link:string})[]; bookings:Booking[]; appointments:Appt[]}|null>(null);
 const [error,setError] = useState('');
 const load = useCallback(async ()=>{ const r = await patientApi<{visits:(LiveVisit & {link:string})[]; bookings:Booking[]; appointments:Appt[]}>('GET','/queue');
  if (r.ok) { setData(r); setError(''); } else setError(r.reason); },[]);
 useEffect(()=>{ void load(); const t = setInterval(()=>void load(),30_000); return ()=>clearInterval(t); },[load]);
 if (error && !data) return <Problem text={error} retry={()=>void load()}/>;
 if (!data) return <Busy/>;
 const waiting = [...data.bookings.map(b=>({code:b.code,what:b.serviceName,at:b.startsAt,kind:'จองคิว'})),...data.appointments.map(a=>({code:a.code,what:`${a.clinicName} · ${a.providerName}`,at:a.startsAt,kind:'นัดแพทย์'}))];
 return <>
  {data.visits.map(v=><section key={v.id} className="liffCard center liffTicket">
   <small>หมายเลขคิวของคุณวันนี้</small><b className="liffQueue">{v.queue}</b><p>{v.dept}{v.bookedSlot ? ` · ${v.bookedSlot}` : ''}</p>
   <a className="liffBtn" href={`/q/${v.link}`}>ดูลำดับคิว เวลารอ และทางไป <ChevronRight size={20}/></a></section>)}
  {waiting.map(w=><section key={w.code} className="liffCard"><h2>{w.kind}วันนี้ {time(w.at)} น.</h2><p>{w.what}</p>
   <p className="liffNote">มาถึงแล้ว? เช็กอินเพื่อรับหมายเลขคิว</p><CodeQr code={w.code}/></section>)}
  {!data.visits.length && !waiting.length && <section className="liffCard"><h2>วันนี้ยังไม่มีคิว</h2>
   <p>ถ้ารับบัตรคิวที่เคาน์เตอร์ สแกน QR บนบัตรคิวเพื่อดูลำดับคิวได้เลย</p></section>}
 </>;
}

// ---- จองคิว ---------------------------------------------------------------------------------------------------------
type Service = {serviceCode:string; displayName:string; advanceDays:number; cancelCutoffMinutes:number};
const bookingReasons = ['ไม่สะดวกมาตามเวลา','อาการดีขึ้นแล้ว','จองผิด'];
export function BookQueue() {
 const [mine,setMine] = useState<Booking[]|null>(null);
 const [error,setError] = useState('');
 const [step,setStep] = useState<'list'|'service'|'slot'|'confirm'|'done'>('list');
 const [services,setServices] = useState<Service[]>([]);
 const [svc,setSvc] = useState<Service|null>(null);
 const [date,setDate] = useState('');
 const [days,setDays] = useState<string[]|null>(null); // only days with a place left (no empty weekends / holidays)
 const [slots,setSlots] = useState<Slot[]|null>(null);
 const [slot,setSlot] = useState<Slot|null>(null);
 const [key,setKey] = useState('');
 const [busy,setBusy] = useState(false);
 const [made,setMade] = useState<Booking|null>(null);
 const [cancelFor,setCancelFor] = useState<string|null>(null);
 const load = useCallback(async ()=>{ const r = await patientApi<{bookings:Booking[]}>('GET','/bookings'); if (r.ok) setMine(r.bookings); else setError(r.reason); },[]);
 useEffect(()=>{ void load(); },[load]);
 useEffect(()=>{ if (step!=='slot' || !svc) return; setDays(null);
  void patientApi<{days:string[]}>('GET',`/booking/days?service=${encodeURIComponent(svc.serviceCode)}`).then(r=>{ const d = r.ok ? r.days.slice(0,14) : []; setDays(d); setDate(x=>d.includes(x) ? x : d[0] ?? ''); });
 },[step,svc]);
 useEffect(()=>{ if (step!=='slot' || !svc || !date) return; setSlots(null);
  void patientApi<{slots:Slot[]}>('GET',`/booking/slots?service=${encodeURIComponent(svc.serviceCode)}&date=${date}`).then(r=>setSlots(r.ok ? r.slots : []));
 },[step,svc,date]);
 const startNew = async () => { setError(''); const r = await patientApi<{services:Service[]}>('GET','/booking/services');
  if (!r.ok) { setError(r.reason); return; } setServices(r.services); setStep('service'); };
 const confirm = async () => {
  if (!slot || busy) return;
  setBusy(true); setError('');
  const r = await patientApi<{booking:Booking}>('POST','/bookings',{slotId:slot.id},{'idempotency-key':key});
  setBusy(false);
  if (r.ok) { setMade(r.booking); setStep('done'); void load(); } else setError(r.reason);
 };
 const cancel = async (b:Booking, reason:string) => {
  setCancelFor(null); setError('');
  const r = await patientApi<{booking:Booking}>('POST',`/bookings/${b.id}/cancel`,{reason});
  if (r.ok) void load(); else setError(r.reason);
 };
 if (step==='service') return <section className="liffCard"><h2>เลือกบริการ</h2>
  {services.length ? <div className="liffChoices">{services.map(s=><button key={s.serviceCode} className="liffChoice" onClick={()=>{ setSvc(s); setDate(''); setSlot(null); setStep('slot'); }}>
   <b>{s.displayName}</b><ChevronRight size={22}/></button>)}</div> : <p>ตอนนี้ยังไม่มีบริการที่เปิดให้จองทาง LINE</p>}
  <button className="liffBtn ghost" onClick={()=>setStep('list')}>ย้อนกลับ</button></section>;
 if (step==='slot' && svc) {
  return <section className="liffCard"><h2>{svc.displayName}</h2><p className="liffNote">เลือกวัน แล้วเลือกช่วงเวลาที่ยังว่าง</p>
   {days===null ? <Busy/> : !days.length ? <p>ตอนนี้ยังไม่มีวันที่เปิดให้จอง หรือเต็มแล้ว · สอบถามเคาน์เตอร์ได้</p> : <>
   <div className="liffDays">{days.map(d=><button key={d} className={d===date?'on':''} aria-pressed={d===date} onClick={()=>{ setDate(d); setSlot(null); }}>{dayShort(d)}</button>)}</div>
   {slots===null ? <Busy/> : slots.length ? <div className="liffSlots">{slots.map(s=><button key={s.id} className={slot?.id===s.id?'on':''} aria-pressed={slot?.id===s.id} onClick={()=>setSlot(s)}>
    <b>{time(s.startsAt)}–{time(s.endsAt)}</b><small>ว่าง {s.remaining}</small></button>)}</div> : <p>วันนี้ไม่มีช่วงที่ว่าง ลองเลือกวันอื่น</p>}</>}
   <div className="liffRow"><button className="liffBtn ghost" onClick={()=>setStep('service')}>ย้อนกลับ</button>
    <button className="liffBtn" disabled={!slot} onClick={()=>{ setKey(newKey()); setStep('confirm'); }}>ถัดไป</button></div></section>;
 }
 if (step==='confirm' && svc && slot) return <section className="liffCard"><h2>ตรวจสอบก่อนยืนยัน</h2>
  <dl className="liffSum"><dt>บริการ</dt><dd>{svc.displayName}</dd><dt>วัน</dt><dd>{day(slot.startsAt)}</dd><dt>เวลา</dt><dd>{time(slot.startsAt)}–{time(slot.endsAt)} น.</dd></dl>
  <p className="liffNote">การจองยังไม่ใช่หมายเลขคิว · วันนั้นให้เช็กอินที่ตู้หรือเคาน์เตอร์เพื่อรับคิว · ยกเลิกได้ถึง {svc.cancelCutoffMinutes>=60?`${svc.cancelCutoffMinutes/60} ชั่วโมง`:`${svc.cancelCutoffMinutes} นาที`}ก่อนเวลา</p>
  {error && <p className="liffError" role="alert">{error}</p>}
  <div className="liffRow"><button className="liffBtn ghost" onClick={()=>setStep('slot')}>แก้ไข</button><button className="liffBtn" disabled={busy} onClick={()=>void confirm()}>{busy?'กำลังจอง…':'ยืนยันจอง'}</button></div></section>;
 if (step==='done' && made) return <section className="liffCard center"><CheckCircle2 size={40} className="liffOk"/><h2>จองเรียบร้อย</h2>
  <p>{made.serviceName}<br/>{day(made.startsAt)} {time(made.startsAt)} น.</p><CodeQr code={made.code}/>
  <button className="liffBtn" onClick={()=>{ setStep('list'); setMade(null); }}>เสร็จ</button></section>;
 if (!mine) return error ? <Problem text={error} retry={()=>void load()}/> : <Busy/>;
 const active = mine.filter(b=>b.status==='CONFIRMED' && upcoming(b.endsAt)).sort((a,b)=>a.startsAt.localeCompare(b.startsAt));
 const past = mine.filter(b=>!active.includes(b));
 return <>
  {error && <Problem text={error}/>}
  <button className="liffBtn" onClick={()=>void startNew()}><CalendarCheck size={22}/> จองคิวใหม่</button>
  {active.map(b=><section key={b.id} className="liffCard"><h2>{b.serviceName}</h2><p><Clock size={18}/> {day(b.startsAt)} {time(b.startsAt)}–{time(b.endsAt)} น.</p>
   <CodeQr code={b.code}/>
   {cancelFor===b.id ? <><p>ยกเลิกเพราะ</p><div className="liffChoices">{bookingReasons.map(r=><button key={r} className="liffChoice small" onClick={()=>void cancel(b,r)}>{r}</button>)}</div>
     <button className="liffBtn ghost" onClick={()=>setCancelFor(null)}>ไม่ยกเลิก</button></>
    : <button className="liffLink" onClick={()=>setCancelFor(b.id)}>ยกเลิกการจองนี้</button>}</section>)}
  {!active.length && <section className="liffCard"><p>ยังไม่มีการจองที่รออยู่</p></section>}
  {past.length>0 && <details className="liffPast"><summary>การจองที่ผ่านมา ({past.length})</summary>
   {past.map(b=><p key={b.id}>{dayShort(localDay(b.startsAt))} · {b.serviceName} · {statusThai[b.status] ?? b.status}</p>)}</details>}
 </>;
}
const statusThai:Record<string,string> = {CONFIRMED:'จองแล้ว',CANCELLED:'ยกเลิก',EXPIRED:'หมดอายุ',CHECKED_IN:'มาแล้ว',CONVERTED_TO_QUEUE:'มาแล้ว',COMPLETED:'ตรวจแล้ว',NO_SHOW:'ไม่ได้มาตามนัด'};

// ---- นัดหมาย --------------------------------------------------------------------------------------------------------
const apptReasons = ['ไม่สะดวกมาตามนัด','อาการดีขึ้นแล้ว','ไปรักษาที่อื่น'];
type Rules = Record<string,{cancelCutoffMinutes:number; rescheduleNeedsApproval:boolean; advanceDays:number}>;
export function Appointments() {
 const [list,setList] = useState<Appt[]|null>(null);
 const [rules,setRules] = useState<Rules>({});
 const [error,setError] = useState('');
 const [note,setNote] = useState('');
 const [moving,setMoving] = useState<Appt|null>(null);
 const [cancelFor,setCancelFor] = useState<string|null>(null);
 const load = useCallback(async ()=>{ const r = await patientApi<{appointments:Appt[]; rules:Rules}>('GET','/appointments');
  if (r.ok) { setList(r.appointments); setRules(r.rules); } else setError(r.reason); },[]);
 useEffect(()=>{ void load(); },[load]);
 const cancel = async (a:Appt, reason:string) => {
  setCancelFor(null); setError('');
  const r = await patientApi('POST',`/appointments/${a.id}/cancel`,{reason});
  if (r.ok) { setNote(`ยกเลิกนัด ${day(a.startsAt)} แล้ว`); void load(); } else setError(r.reason);
 };
 if (moving) return <MoveAppt a={moving} needsApproval={rules[moving.clinicCode]?.rescheduleNeedsApproval ?? true} advanceDays={rules[moving.clinicCode]?.advanceDays ?? 90}
  onClose={(text)=>{ setMoving(null); if (text) { setNote(text); void load(); } }}/>;
 if (!list) return error ? <Problem text={error} retry={()=>void load()}/> : <Busy/>;
 const active = list.filter(a=>a.status==='CONFIRMED' && upcoming(a.endsAt)).sort((a,b)=>a.startsAt.localeCompare(b.startsAt));
 const past = list.filter(a=>!active.includes(a));
 return <>
  {note && <section className="liffCard ok"><CheckCircle2 size={28}/><p>{note}</p></section>}
  {error && <Problem text={error}/>}
  {active.map(a=>{ const cutoff = rules[a.clinicCode]?.cancelCutoffMinutes ?? 0, late = Date.now() > new Date(a.startsAt).getTime()-cutoff*60_000;
   return <section key={a.id} className="liffCard"><h2>{day(a.startsAt)}</h2><p><Clock size={18}/> {time(a.startsAt)} น. · {a.clinicName}</p><p>{a.providerName}</p>
    {a.pendingRequest && <p className="liffPending">ขอเลื่อนเป็น {day(a.pendingRequest.startsAt)} {time(a.pendingRequest.startsAt)} น. · รอคลินิกยืนยัน (นัดเดิมยังใช้ได้)</p>}
    {isToday(a.startsAt) && <CodeQr code={a.code}/>}
    {late ? <p className="liffNote">ใกล้ถึงเวลานัดแล้ว หากต้องการเลื่อนหรือยกเลิก กรุณาโทรติดต่อคลินิก</p>
     : cancelFor===a.id ? <><p>ยกเลิกนัดเพราะ</p><div className="liffChoices">{apptReasons.map(r=><button key={r} className="liffChoice small" onClick={()=>void cancel(a,r)}>{r}</button>)}</div>
       <button className="liffBtn ghost" onClick={()=>setCancelFor(null)}>ไม่ยกเลิก</button></>
     : <div className="liffRow">{!a.pendingRequest && <button className="liffBtn ghost" onClick={()=>{ setNote(''); setMoving(a); }}>ขอเลื่อนนัด</button>}
        <button className="liffBtn ghost danger" onClick={()=>setCancelFor(a.id)}>ยกเลิกนัด</button></div>}
   </section>; })}
  {!active.length && <section className="liffCard"><p>ไม่มีนัดที่กำลังจะถึง</p><p className="liffNote">นัดพบแพทย์จะทำโดยแพทย์หรือเจ้าหน้าที่ แล้วแสดงที่นี่</p></section>}
  {past.length>0 && <details className="liffPast"><summary>นัดที่ผ่านมา ({past.length})</summary>
   {past.map(a=><p key={a.id}>{dayShort(localDay(a.startsAt))} · {a.clinicName} · {statusThai[a.status] ?? a.status}</p>)}</details>}
 </>;
}

function MoveAppt({a,needsApproval,advanceDays,onClose}:{a:Appt; needsApproval:boolean; advanceDays:number; onClose:(text?:string)=>void}) {
 const [days,setDays] = useState<string[]|null>(null); // days with a free time with this doctor
 const [date,setDate] = useState('');
 const [slots,setSlots] = useState<Slot[]|null>(null);
 useEffect(()=>{ void patientApi<{days:string[]}>('GET',`/appointments/${a.id}/days`).then(r=>{ const d = r.ok ? r.days.slice(0,Math.min(28,advanceDays)) : []; setDays(d); setDate(d[0] ?? ''); }); },[a.id,advanceDays]);
 const [slot,setSlot] = useState<Slot|null>(null);
 const [reason,setReason] = useState('');
 const [busy,setBusy] = useState(false);
 const [error,setError] = useState('');
 useEffect(()=>{ if (!date) return; setSlots(null); setSlot(null);
  void patientApi<{slots:Slot[]}>('GET',`/appointments/${a.id}/slots?date=${date}`).then(r=>setSlots(r.ok ? r.slots : [])); },[a.id,date]);
 const send = async () => {
  if (!slot || busy) return;
  setBusy(true); setError('');
  const r = await patientApi<{immediate:boolean}>('POST',`/appointments/${a.id}/reschedule`,{slotId:slot.id,reason});
  setBusy(false);
  if (r.ok) onClose(r.immediate ? `เลื่อนนัดเป็น ${day(slot.startsAt)} ${time(slot.startsAt)} น. แล้ว` : `ส่งคำขอเลื่อนเป็น ${day(slot.startsAt)} ${time(slot.startsAt)} น. แล้ว · ดูผลการพิจารณาได้ที่หน้านี้ (ระหว่างนี้นัดเดิมยังใช้ได้)`);
  else setError(r.reason);
 };
 return <section className="liffCard"><div className="liffHeadRow"><h2>ขอเลื่อนนัด</h2><button className="liffIcon" aria-label="ปิด" onClick={()=>onClose()}><X size={22}/></button></div>
  <p className="liffNote">นัดเดิม {day(a.startsAt)} {time(a.startsAt)} น. · {a.providerName}{needsApproval ? ' · คลินิกจะพิจารณาคำขอ' : ''}</p>
  {days===null ? <Busy/> : !days.length ? <p>ตอนนี้ไม่มีวันว่างที่เลื่อนไปได้ · ติดต่อเคาน์เตอร์หรือโทรหาคลินิก</p> : <>
  <div className="liffDays">{days.map(d=><button key={d} className={d===date?'on':''} aria-pressed={d===date} onClick={()=>setDate(d)}>{dayShort(d)}</button>)}</div>
  {slots===null ? <Busy/> : slots.length ? <div className="liffSlots">{slots.map(s=><button key={s.id} className={slot?.id===s.id?'on':''} aria-pressed={slot?.id===s.id} onClick={()=>setSlot(s)}>
   <b>{time(s.startsAt)}</b><small>{s.providerName}</small></button>)}</div> : <p>วันนี้ไม่มีเวลาว่าง ลองเลือกวันอื่น</p>}</>}
  <div className="liffChoices">{['ติดงาน','ติดธุระ','ไม่สบาย เดินทางไม่ได้'].map(r=><button key={r} className={'liffChoice small'+(reason===r?' on':'')} aria-pressed={reason===r} onClick={()=>setReason(r)}>{r}</button>)}</div>
  {error && <p className="liffError" role="alert">{error}</p>}
  <button className="liffBtn" disabled={!slot || busy} onClick={()=>void send()}>{busy?'กำลังส่ง…':needsApproval?'ส่งคำขอเลื่อนนัด':'ยืนยันเลื่อนนัด'}</button></section>;
}

// ---- แผนที่ --------------------------------------------------------------------------------------------------------
// The hospital's wayfinding places (the same as the QR signs): tap one for directions. While the hospital has not
// switched wayfinding on, the department directory (building / floor / rooms) instead.
export function HospitalMap() {
 const [q,setQ] = useState('');
 const [places,setPlaces] = useState<Destination[]|null|undefined>(undefined); // null: wayfinding not available
 useEffect(()=>{ void fetchDestinations().then(r=>setPlaces(r.ok && r.destinations.length ? r.destinations : null)); },[]);
 const dir = useMemo(()=>deptDirectory().filter(d=>!d.off).map(d=>({key:`${d.place}|${d.name}`,name:d.name,place:d.place,note:d.rooms,code:undefined as string|undefined})),[]);
 const items = places ? places.map(d=>({key:d.code,name:d.nameTh,place:whereText(d),note:d.landmarkTh ?? '',code:d.code as string|undefined})) : dir;
 const shown = q.trim() ? items.filter(d=>d.name.includes(q.trim()) || d.place.includes(q.trim())) : items;
 const groups = useMemo(()=>{ const m = new Map<string,typeof shown>(); shown.forEach(d=>m.set(d.place,[...(m.get(d.place) ?? []),d])); return [...m.entries()]; },[shown]);
 if (places===undefined) return <Busy/>;
 return <>
  <label className="liffSearch"><Search size={20}/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="ค้นหาแผนก เช่น ห้องยา ตา" aria-label="ค้นหาแผนก"/></label>
  {groups.map(([place,ds])=><section key={place} className="liffCard"><h2><MapPin size={20}/> {place}</h2>
   {places ? <div className="liffChoices">{ds.map(d=><a key={d.key} className="liffChoice small" href={`/wayfinding?to=${encodeURIComponent(d.code!)}`}><span><b>{d.name}</b>{d.note && <><br/><small className="liffNote">{d.note}</small></>}</span><ChevronRight size={20}/></a>)}</div>
    : <ul className="liffDir">{ds.map(d=><li key={d.key}><b>{d.name}</b>{d.note && <small>{d.note}</small>}</li>)}</ul>}</section>)}
  {!groups.length && <section className="liffCard"><p>ไม่พบแผนกที่ค้นหา · สอบถามจุดประชาสัมพันธ์</p></section>}
  <p className="liffNote center"><QrCode size={16}/> ในโรงพยาบาล สแกนป้าย QR ตามจุดต่าง ๆ เพื่อดูทางจากจุดที่คุณยืนอยู่</p>
 </>;
}
