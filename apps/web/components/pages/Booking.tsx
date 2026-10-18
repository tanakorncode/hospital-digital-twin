'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarPlus, CheckCircle2, LogIn, RefreshCw, Search, X } from 'lucide-react';
import { CheckInCard, type CheckInResult } from '../CheckInCard';
import { opdClinics, type Clinic } from '../../lib/patients';
import { actionKey, covers, type AuthUser, type QueueSync } from '../../lib/queue';
import { Select } from '../Select';
import { DatePicker } from '../DatePicker';

// General booking (Phase 2): administrators set the rules and the time slots per clinic; staff book for patients at
// the counter or on the phone (the path for people without LINE) and cancel on request. The server checks
// everything — places, the booking window, one active booking per patient, the cancel cut-off — these screens only
// show what it says.
type Api = QueueSync['api'];
export type Policy = {serviceCode:string; displayName:string; enabled:boolean; advanceDays:number; cancelCutoffMinutes:number; maxActivePerPatient:number; version:number};
export type Slot = {id:string; serviceCode:string; startsAt:string; endsAt:string; capacity:number; reserved:number; remaining:number; status:'OPEN'|'CLOSED'|'CANCELLED'};
export type Booking = {id:string; code:string; serviceCode:string; serviceName:string; startsAt:string; endsAt:string; status:'CONFIRMED'|'CANCELLED'|'EXPIRED'|'CHECKED_IN'|'CONVERTED_TO_QUEUE';
 channel:'STAFF'|'LINE'; hn:string; cancellationReason?:string};
const statusText:Record<Booking['status'],string> = {CONFIRMED:'จองแล้ว',CANCELLED:'ยกเลิก',EXPIRED:'หมดอายุ',CHECKED_IN:'เช็กอินแล้ว',CONVERTED_TO_QUEUE:'เข้าคิวแล้ว'};
const slotText:Record<Slot['status'],string> = {OPEN:'เปิด',CLOSED:'ปิดรับ',CANCELLED:'ยกเลิก'};
export const today = () => new Date().toLocaleDateString('sv-SE');
export const addDays = (d:string, n:number) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate()+n); return x.toLocaleDateString('sv-SE'); };
export const timeOf = (iso:string) => new Date(iso).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'});
export const dayOf = (iso:string) => new Date(iso.length===10 ? `${iso}T12:00:00` : iso).toLocaleDateString('th-TH',{weekday:'short',day:'numeric',month:'short'});
export const weekdayNames = ['อา','จ','อ','พ','พฤ','ศ','ส'];
const clinicName = (c:Clinic) => `${c.letter} · ${c.dept}`;

function usePolicies(api:Api, rev:number) {
 const [policies,setPolicies] = useState<Policy[]>([]);
 const [on,setOn] = useState(false);
 const load = useCallback(async ()=>{ const r = await api<{ok:boolean; policies?:Policy[]; enabled?:boolean}>('booking:policies',{}); if (r.ok) { setPolicies(r.policies ?? []); setOn(!!r.enabled); } },[api]);
 useEffect(()=>{ void load(); },[load,rev]);
 return {policies,on,reload:load};
}

// ---- Settings → การจองล่วงหน้า (administrators) -----------------------------------------------------------------
export function BookingAdminPane({api,rev,features,setFeature}:{api:Api; rev:number; features:QueueSync['features']; setFeature:(on:boolean)=>Promise<void>}) {
 const clinics = useMemo(()=>opdClinics(),[]);
 const {policies,reload} = usePolicies(api,rev);
 const [msg,setMsg] = useState<{text:string; bad?:boolean}|null>(null);
 useEffect(()=>{ if (!msg) return; const t = setTimeout(()=>setMsg(null),5000); return ()=>clearTimeout(t); },[msg]);
 const say = (r:{ok:boolean; reason?:string}, ok:string) => setMsg(r.ok ? {text:ok} : {text:r.reason ?? 'บันทึกไม่สำเร็จ',bad:true});
 const savePolicy = async (c:Clinic, patch:Partial<Policy>) => {
  const r = await api('booking:policy:set',{serviceCode:c.key,displayName:c.dept,queuePrefix:c.letter,...patch});
  say(r,`บันทึกกติกา ${c.dept} แล้ว`); if (r.ok) void reload();
 };
 const on = !!features.phase2.generalBooking;
 return <section className="setCard bookAdmin">
  <div className={'bookSwitch'+(on?' on':'')}><div><b>ระบบจองคิวล่วงหน้า {on?'เปิดใช้งาน':'ปิดอยู่'}</b>
   <small>{on ? 'เจ้าหน้าที่จองให้ผู้ป่วยได้ (และผู้ป่วยจองเองทาง LINE เมื่อเปิดส่วนนั้น) เฉพาะคลินิกที่เปิดด้านล่าง' : 'ตั้งกติกาและสร้างช่วงเวลาไว้ก่อนได้ ผู้ป่วยยังจองไม่ได้จนกว่าจะเปิด'}</small></div>
   <button className={on?'btn ghost':'btn'} onClick={()=>void setFeature(!on)}>{on?'ปิดระบบจอง':'เปิดระบบจอง'}</button></div>
  {msg && <p className={'setToast'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}
  <h4 className="setSub">กติกาต่อคลินิก <small>จองล่วงหน้าได้กี่วัน · ยกเลิกได้ถึงก่อนเวลานัดกี่ชั่วโมง · จองค้างได้กี่ครั้งต่อคน</small></h4>
  <div className="tableWrap"><table className="dataTable bookRules"><thead><tr><th>คลินิก</th><th>เปิดจอง</th><th>ล่วงหน้า</th><th>ยกเลิกก่อน</th><th>ต่อคน</th></tr></thead>
   <tbody>{clinics.map(c=>{ const p = policies.find(x=>x.serviceCode===c.key);
    return <tr key={c.key}><td><b>{clinicName(c)}</b>{p && <small className="muted"> · v{p.version}</small>}</td>
     <td><button className={'chip'+(p?.enabled?' on':'')} aria-pressed={!!p?.enabled} onClick={()=>void savePolicy(c,{enabled:!p?.enabled})}>{p?.enabled?'เปิด':'ปิด'}</button></td>
     <td><NumPick value={p?.advanceDays ?? 14} options={[1,3,7,14,30,60]} unit="วัน" onPick={v=>void savePolicy(c,{advanceDays:v})}/></td>
     <td><NumPick value={(p?.cancelCutoffMinutes ?? 60)/60} options={[0,1,2,4,24,48]} unit="ชม." onPick={v=>void savePolicy(c,{cancelCutoffMinutes:v*60})}/></td>
     <td><NumPick value={p?.maxActivePerPatient ?? 1} options={[1,2,3]} unit="ครั้ง" onPick={v=>void savePolicy(c,{maxActivePerPatient:v})}/></td></tr>; })}</tbody></table></div>
  <SlotPlanner api={api} clinics={clinics.filter(c=>policies.some(p=>p.serviceCode===c.key))} onDone={say}/>
  <SlotList api={api} rev={rev} clinics={clinics.filter(c=>policies.some(p=>p.serviceCode===c.key))} onDone={say}/>
 </section>;
}
export function NumPick({value,options,unit,onPick}:{value:number; options:number[]; unit:string; onPick:(v:number)=>void}) {
 const list = options.includes(value) ? options : [...options,value].sort((a,b)=>a-b);
 return <Select size="sm" className="numPick" value={value} onChange={onPick} options={list.map(v=>({value:v,label:`${v} ${unit}`}))}/>;
}

function SlotPlanner({api,clinics,onDone}:{api:Api; clinics:Clinic[]; onDone:(r:{ok:boolean; reason?:string}, ok:string)=>void}) {
 const [svc,setSvc] = useState('');
 const [from,setFrom] = useState(()=>addDays(today(),1));
 const [to,setTo] = useState(()=>addDays(today(),14));
 const [days,setDays] = useState<number[]>([1,2,3,4,5]);
 const [start,setStart] = useState('08:00');
 const [end,setEnd] = useState('12:00');
 const [minutes,setMinutes] = useState(60);
 const [capacity,setCapacity] = useState(10);
 const [busy,setBusy] = useState(false);
 useEffect(()=>{ if (!svc && clinics[0]) setSvc(clinics[0].key); },[clinics,svc]);
 if (!clinics.length) return <p className="cmdNote">ตั้งกติกาของคลินิกอย่างน้อย 1 แห่งก่อน แล้วจึงสร้างช่วงเวลาให้จอง</p>;
 const make = async () => {
  setBusy(true);
  const r = await api<{ok:boolean; reason?:string; created?:number; skipped?:number}>('booking:slots:create',{serviceCode:svc,from,to,weekdays:days,start,end,minutes,capacity});
  setBusy(false);
  onDone(r,`สร้างช่วงเวลาใหม่ ${r.created ?? 0} ช่วง${r.skipped?` · มีอยู่แล้ว ${r.skipped} ช่วง (คงไว้ตามเดิม)`:''}`);
 };
 return <div className="slotPlan">
  <h4 className="setSub">สร้างช่วงเวลาให้จอง <small>สร้างซ้ำได้ ช่วงที่มีอยู่แล้วจะไม่ถูกแก้</small></h4>
  <div className="slotPlanGrid">
   <label>คลินิก<Select value={svc} onChange={setSvc} options={clinics.map(c=>({value:c.key,label:clinicName(c),sub:`ชั้น ${c.level}`}))}/></label>
   <label>ตั้งแต่<DatePicker value={from} onChange={setFrom}/></label>
   <label>ถึง<DatePicker value={to} min={from} onChange={setTo}/></label>
   <label className="wide">เวลา<span className="timeRange"><input type="time" value={start} onChange={e=>setStart(e.target.value)}/>–<input type="time" value={end} onChange={e=>setEnd(e.target.value)}/></span></label>
   <label>ช่วงละ<Select value={minutes} onChange={setMinutes} options={[15,30,60,120,240].map(m=>({value:m,label:`${m} นาที`}))}/></label>
   <label>รับต่อช่วง<input type="number" min={1} max={500} value={capacity} onChange={e=>setCapacity(Math.max(1,Math.min(500,Number(e.target.value)||1)))}/></label>
  </div>
  <div className="segBtns">{weekdayNames.map((d,i)=><button key={i} className={days.includes(i)?'on':''} aria-pressed={days.includes(i)} onClick={()=>setDays(x=>x.includes(i)?x.filter(y=>y!==i):[...x,i].sort())}>{d}</button>)}
   <button className="btn" disabled={busy || !days.length || !svc} onClick={()=>void make()}><CalendarPlus size={15}/> {busy?'กำลังสร้าง…':'สร้างช่วงเวลา'}</button></div>
 </div>;
}

function SlotList({api,rev,clinics,onDone}:{api:Api; rev:number; clinics:Clinic[]; onDone:(r:{ok:boolean; reason?:string}, ok:string)=>void}) {
 const [svc,setSvc] = useState('');
 const [date,setDate] = useState(()=>addDays(today(),1));
 const [slots,setSlots] = useState<Slot[]>([]);
 const [cancelFor,setCancelFor] = useState<string|null>(null);
 const [reason,setReason] = useState('');
 useEffect(()=>{ if (!svc && clinics[0]) setSvc(clinics[0].key); },[clinics,svc]);
 const load = useCallback(async ()=>{ if (!svc) return; const r = await api<{ok:boolean; slots?:Slot[]}>('booking:slots',{serviceCode:svc,date}); setSlots(r.ok ? r.slots ?? [] : []); },[api,svc,date]);
 useEffect(()=>{ void load(); },[load,rev]);
 if (!clinics.length) return null;
 const set = async (s:Slot, change:Record<string,unknown>, ok:string) => { const r = await api('booking:slot:set',{slotId:s.id,...change}); onDone(r,ok); setCancelFor(null); setReason(''); void load(); };
 return <div className="slotList">
  <h4 className="setSub">ช่วงเวลาของวัน <small>ปิดรับ = ไม่รับจองเพิ่ม (คนที่จองแล้วยังอยู่) · ยกเลิก = ยกเลิกการจองทั้งช่วงพร้อมเหตุผล</small></h4>
  <div className="slotListHead"><Select value={svc} onChange={setSvc} aria-label="คลินิก" className="selFilter" options={clinics.map(c=>({value:c.key,label:clinicName(c),sub:`ชั้น ${c.level}`}))}/>
   <DatePicker value={date} onChange={setDate} aria-label="วันที่" className="dpFilter"/></div>
  {slots.length ? <div className="tableWrap"><table className="dataTable compact"><thead><tr><th>เวลา</th><th className="num">จองแล้ว</th><th className="num">รับได้</th><th>สถานะ</th><th/></tr></thead>
   <tbody>{slots.map(s=><tr key={s.id} className={s.status!=='OPEN'?'muted':''}><td>{timeOf(s.startsAt)}–{timeOf(s.endsAt)}</td><td className="num">{s.reserved}</td>
    <td className="num">{s.capacity}</td><td>{slotText[s.status]}</td>
    <td className="slotActs">{s.status==='OPEN' && <button className="btn ghost sm" onClick={()=>void set(s,{status:'CLOSED'},`ปิดรับช่วง ${timeOf(s.startsAt)} แล้ว`)}>ปิดรับ</button>}
     {s.status==='CLOSED' && <button className="btn ghost sm" onClick={()=>void set(s,{status:'OPEN'},`เปิดรับช่วง ${timeOf(s.startsAt)} แล้ว`)}>เปิดรับ</button>}
     {s.status!=='CANCELLED' && (cancelFor===s.id
      ? <span className="slotCancel"><input value={reason} maxLength={100} placeholder="เหตุผล เช่น แพทย์ติดประชุม" onChange={e=>setReason(e.target.value)}/>
         <button className="btn sm" disabled={!reason.trim()} onClick={()=>void set(s,{status:'CANCELLED',reason},`ยกเลิกช่วง ${timeOf(s.startsAt)} แล้ว`)}>ยืนยัน</button>
         <button className="iconBtn" aria-label="ไม่ยกเลิก" onClick={()=>setCancelFor(null)}><X size={14}/></button></span>
      : <button className="linkBtn danger" onClick={()=>{ setCancelFor(s.id); setReason(''); }}>ยกเลิกช่วง{s.reserved?` (${s.reserved} คน)`:''}</button>)}</td></tr>)}</tbody></table></div>
   : <p className="cmdNote">ยังไม่มีช่วงเวลาของวันนี้ · สร้างได้จากส่วนด้านบน</p>}
 </div>;
}

// ---- Queue page → การจอง (staff) ------------------------------------------------------------------------------------
const cancelReasons = ['ผู้ป่วยขอยกเลิก','ผู้ป่วยขอเปลี่ยนวัน','จองผิด'];
export function BookingTab({api,rev,user,features}:{api:Api; rev:number; user?:AuthUser|null; features:QueueSync['features']}) {
 const clinics = useMemo(()=>opdClinics().filter(c=>covers(user,c.key)),[user]);
 const {policies} = usePolicies(api,rev);
 const open = clinics.filter(c=>policies.some(p=>p.serviceCode===c.key && p.enabled));
 const [date,setDate] = useState(today);
 const [svc,setSvc] = useState('');
 const [find,setFind] = useState('');
 const [list,setList] = useState<Booking[]>([]);
 const [found,setFound] = useState<Booking[]|null>(null);
 const [msg,setMsg] = useState<{text:string; bad?:boolean}|null>(null);
 const [cancelFor,setCancelFor] = useState<string|null>(null);
 const [newOpen,setNewOpen] = useState(false);
 const [checked,setChecked] = useState<CheckInResult|null>(null);
 useEffect(()=>{ if (!msg) return; const t = setTimeout(()=>setMsg(null),5000); return ()=>clearTimeout(t); },[msg]);
 const load = useCallback(async ()=>{ const r = await api<{ok:boolean; bookings?:Booking[]; reason?:string}>('booking:list',{date,serviceCode:svc||undefined}); setList(r.ok ? r.bookings ?? [] : []); },[api,date,svc]);
 useEffect(()=>{ void load(); },[load,rev]);
 const search = async () => {
  const q = find.trim(); if (!q) { setFound(null); return; }
  const r = await api<{ok:boolean; bookings?:Booking[]; reason?:string}>('booking:list',/^bk/i.test(q) ? {code:q} : {hn:q});
  if (r.ok) setFound(r.bookings ?? []); else setMsg({text:r.reason ?? 'ค้นหาไม่สำเร็จ',bad:true});
 };
 const cancel = async (b:Booking, reason:string) => {
  setCancelFor(null);
  const r = await api<{ok:boolean; reason?:string; booking?:Booking}>('booking:cancel',{bookingId:b.id,reason});
  setMsg(r.ok ? {text:`ยกเลิก ${b.code} แล้ว · ช่วง ${timeOf(b.startsAt)} ว่างให้คนอื่นจองได้`} : {text:r.reason ?? 'ยกเลิกไม่สำเร็จ',bad:true});
  if (r.ok && found) setFound(found.map(x=>x.id===b.id && r.booking ? r.booking : x));
 };
 // At the counter: the patient has arrived — into today's queue (same number again if already done).
 const checkIn = async (b:Booking) => {
  const now = new Date(), letter = clinics.find(c=>c.key===b.serviceCode)?.letter;
  const r = await api<CheckInResult>('checkin:code',{code:b.code,channel:'COUNTER',at:now.getHours()*60+now.getMinutes(),prefix:letter});
  if (r.ok) { setChecked(r); void load(); if (found) setFound(found.map(x=>x.id===b.id ? {...x,status:'CONVERTED_TO_QUEUE'} : x)); }
  else setMsg({text:r.reason ?? 'เช็กอินไม่สำเร็จ',bad:true});
 };
 const on = !!features.phase2.generalBooking;
 const rows = found ?? list;
 const counts = {all:list.filter(b=>b.status!=='CANCELLED').length,cancelled:list.filter(b=>b.status==='CANCELLED').length};
 return <div className="bookTab">
  {!on && <p className="serviceNote">ระบบจองยังปิดอยู่ · ผู้ดูแลระบบเปิดได้ที่ ตั้งค่า → การจองล่วงหน้า (ดูรายการเดิมได้ตามปกติ)</p>}
  <div className="bookBar">
   <button className="btn" disabled={!on || !open.length} onClick={()=>setNewOpen(true)}><CalendarPlus size={15}/> จองให้ผู้ป่วย</button>
   <DatePicker value={date} onChange={d=>{ setDate(d); setFound(null); }} aria-label="วันที่" className="dpFilter"/>
   <Select value={svc} onChange={setSvc} aria-label="คลินิก" className="selFilter" options={[{value:'',label:'ทุกคลินิก'},...clinics.filter(c=>policies.some(p=>p.serviceCode===c.key)).map(c=>({value:c.key,label:clinicName(c),sub:`ชั้น ${c.level}`}))]}/>
   <form className="bookFind" onSubmit={e=>{ e.preventDefault(); void search(); }}><Search size={14}/><input value={find} onChange={e=>setFind(e.target.value)} placeholder="รหัสจอง (BK…) หรือ HN"/>
    {found && <button type="button" className="iconBtn" aria-label="ล้างการค้นหา" onClick={()=>{ setFind(''); setFound(null); }}><X size={14}/></button>}</form>
   <button className="iconBtn" aria-label="โหลดใหม่" onClick={()=>void load()}><RefreshCw size={15}/></button>
  </div>
  {msg && <p className={'consoleMsg'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}
  <p className="cmdNote">{found ? `ผลค้นหา ${found.length} รายการ` : `${dayOf(date)} · จอง ${counts.all} คน${counts.cancelled?` · ยกเลิก ${counts.cancelled}`:''}`} · HN แสดง 4 ตัวท้าย · ผู้ป่วยเข้าคิวเมื่อเช็กอินในวันนั้น</p>
  {rows.length ? <div className="tableWrap"><table className="dataTable bookList"><thead><tr><th>เวลา</th><th>รหัสจอง</th><th>คลินิก</th><th>HN</th><th>ช่องทาง</th><th>สถานะ</th><th/></tr></thead>
   <tbody>{rows.map(b=><tr key={b.id} className={b.status==='CANCELLED'||b.status==='EXPIRED'?'muted':''}>
    <td>{found?`${dayOf(b.startsAt)} `:''}{timeOf(b.startsAt)}–{timeOf(b.endsAt)}</td><td><b className="bookCode">{b.code}</b></td><td>{b.serviceName}</td><td>{b.hn}</td>
    <td>{b.channel==='LINE'?'LINE':'เจ้าหน้าที่'}</td><td><span className={'bookState s-'+b.status}>{statusText[b.status]}</span>{b.cancellationReason && <small className="muted"> · {b.cancellationReason}</small>}</td>
    <td className="slotActs">{b.status==='CONFIRMED' && new Date(b.startsAt).toLocaleDateString('sv-SE')===today() && cancelFor!==b.id &&
     <button className="btn sm" onClick={()=>void checkIn(b)}><LogIn size={13}/> เช็กอิน</button>}
     {b.status==='CONFIRMED' && (cancelFor===b.id
     ? <span className="slotCancel">{cancelReasons.map(r=><button key={r} className="btn ghost sm" onClick={()=>void cancel(b,r)}>{r}</button>)}<button className="iconBtn" aria-label="ไม่ยกเลิก" onClick={()=>setCancelFor(null)}><X size={14}/></button></span>
     : <button className="linkBtn danger" onClick={()=>setCancelFor(b.id)}>ยกเลิก</button>)}</td></tr>)}</tbody></table></div>
   : <p className="ncEmpty">{found ? 'ไม่พบการจอง' : 'ยังไม่มีการจองในวันนี้'}</p>}
  {checked && <div className="modalBack" onClick={()=>setChecked(null)}><div className="moveDialog visitDialog" role="dialog" aria-modal="true" aria-label="ผลการเช็กอิน" onClick={e=>e.stopPropagation()}>
   <header><div><b>เช็กอิน {checked.source?.code}</b><small className="muted">ให้ผู้ป่วยสแกน QR หรือพิมพ์บัตรคิว</small></div><button className="iconBtn" aria-label="ปิด" onClick={()=>setChecked(null)}><X size={18}/></button></header>
   <CheckInCard r={checked}/><footer><button className="btn ghost" onClick={()=>window.print()}>พิมพ์บัตรคิว</button><button className="btn" onClick={()=>setChecked(null)}>เสร็จ</button></footer></div></div>}
  {newOpen && <NewBooking api={api} clinics={open} policies={policies} onClose={()=>setNewOpen(false)}
   onMade={b=>{ setMsg({text:`จองแล้ว ${b.code} · ${b.serviceName} ${dayOf(b.startsAt)} ${timeOf(b.startsAt)}`}); setDate(new Date(b.startsAt).toLocaleDateString('sv-SE')); setFound(null); }}/>}
 </div>;
}

function NewBooking({api,clinics,policies,onClose,onMade}:{api:Api; clinics:Clinic[]; policies:Policy[]; onClose:()=>void; onMade:(b:Booking)=>void}) {
 const [hn,setHn] = useState('');
 const [svc,setSvc] = useState(clinics[0]?.key ?? '');
 const [date,setDate] = useState('');
 const [days,setDays] = useState<string[]|null>(null); // only days with a place left — no empty weekends / holidays
 const [slots,setSlots] = useState<Slot[]|null>(null);
 const [slotId,setSlotId] = useState('');
 const [busy,setBusy] = useState(false);
 const [error,setError] = useState('');
 const [made,setMade] = useState<Booking|null>(null);
 // One key per intended booking (patient + slot): a tap after "no reply" returns the same booking.
 const [k,setK] = useState({sig:'',key:''});
 const sig = `${hn.trim()}|${slotId}`;
 const key = k.sig===sig ? k.key : '';
 useEffect(()=>{ if (k.sig!==sig) setK({sig,key:actionKey()}); },[sig,k.sig]);
 const p = policies.find(x=>x.serviceCode===svc);
 useEffect(()=>{ let live = true; setDays(null);
  void api<{ok:boolean; days?:string[]}>('booking:days',{serviceCode:svc}).then(r=>{ if (!live) return; const d = (r.ok ? r.days ?? [] : []).slice(0,14); setDays(d); setDate(x=>d.includes(x) ? x : d[0] ?? ''); });
  return ()=>{ live = false; }; },[api,svc]);
 useEffect(()=>{ if (!date) { setSlots([]); return; } let live = true; setSlots(null); setSlotId('');
  void api<{ok:boolean; slots?:Slot[]}>('booking:slots',{serviceCode:svc,date,bookable:true}).then(r=>{ if (live) setSlots(r.ok ? r.slots ?? [] : []); });
  return ()=>{ live = false; }; },[api,svc,date]);
 useEffect(()=>{ const f = (e:KeyboardEvent)=>{ if (e.key==='Escape') onClose(); }; window.addEventListener('keydown',f); return ()=>window.removeEventListener('keydown',f); },[onClose]);
 const submit = async () => {
  if (busy || !key) return;
  setBusy(true); setError('');
  const r = await api<{ok:boolean; reason?:string; booking?:Booking}>('booking:create',{hn:hn.trim(),slotId,key});
  setBusy(false);
  if (r.ok && r.booking) { setMade(r.booking); onMade(r.booking); } else setError(r.reason ?? 'จองไม่สำเร็จ');
 };
 const slot = slots?.find(s=>s.id===slotId);
 return <div className="modalBack" onClick={onClose}>
  <div className="moveDialog visitDialog" role="dialog" aria-modal="true" aria-labelledby="bookTitle" onClick={e=>e.stopPropagation()}>
   <header><div><b id="bookTitle">จองคิวล่วงหน้าให้ผู้ป่วย</b><small className="muted">ตรวจบัตรประชาชนตามขั้นตอนเดิมก่อน · ระบบเก็บเฉพาะ HN</small></div>
    <button className="iconBtn" aria-label="ปิด" onClick={onClose}><X size={18}/></button></header>
   {made ? <div className="visitMade"><CheckCircle2 size={28}/><span>จองแล้ว</span><b className="mvQueue big">{made.code}</b>
    <small className="muted">{made.serviceName} · {dayOf(made.startsAt)} {timeOf(made.startsAt)}–{timeOf(made.endsAt)}</small>
    <p className="cmdNote">แจ้งรหัสนี้ให้ผู้ป่วย · วันนัดให้มาเช็กอินที่ตู้หรือเคาน์เตอร์ก่อนเวลา</p>
    <div className="qrActs"><button className="btn" onClick={onClose}>เสร็จ</button></div></div> : <>
    <div className="visitRow"><span>HN ของผู้ป่วย</span><input className="bookHn" value={hn} maxLength={20} autoFocus inputMode="text" placeholder="เช่น 65-123456" onChange={e=>setHn(e.target.value)}/></div>
    <div className="visitRow"><span>คลินิก</span><div className="visitClinics">{clinics.map(c=><button key={c.key} className={c.key===svc?'on':''} aria-pressed={c.key===svc} onClick={()=>setSvc(c.key)}>
     <b>{c.letter}</b><span>{c.dept}</span><small>ชั้น {c.level}</small></button>)}</div></div>
    <div className="visitRow"><span>วันที่ <small className="muted">(จองล่วงหน้าได้ {p?.advanceDays ?? 14} วัน)</small></span>
     {days===null ? <p className="cmdNote">กำลังโหลด…</p> : days.length ? <div className="segBtns">{days.map(d=><button key={d} className={d===date?'on':''} aria-pressed={d===date} onClick={()=>setDate(d)}>{dayOf(d)}</button>)}</div>
      : <p className="cmdNote">คลินิกนี้ยังไม่มีวันที่เปิดให้จอง หรือเต็มทุกวัน · ผู้ดูแลระบบสร้างช่วงเวลาได้ที่ ตั้งค่า → การจองล่วงหน้า</p>}</div>
    <div className="visitRow"><span>ช่วงเวลา</span>
     {slots===null ? <p className="cmdNote">กำลังโหลด…</p> : slots.length ? <div className="segBtns">{slots.map(s=><button key={s.id} className={s.id===slotId?'on':''} aria-pressed={s.id===slotId} onClick={()=>setSlotId(s.id)}>
      {timeOf(s.startsAt)}–{timeOf(s.endsAt)} <small>ว่าง {s.remaining}</small></button>)}</div> : <p className="cmdNote">ไม่มีช่วงที่ยังว่างในวันนี้ · ลองวันอื่น</p>}</div>
    {error && <p className="loginError" role="alert">{error}</p>}
    <footer><button className="btn ghost" onClick={onClose}>ยกเลิก</button>
     <button className="btn" disabled={busy || !hn.trim() || !slot} onClick={()=>void submit()}>{busy?'กำลังจอง…':slot?`ยืนยันจอง ${timeOf(slot.startsAt)}`:'เลือกช่วงเวลา'}</button></footer>
   </>}
  </div>
 </div>;
}
