'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarPlus, Check, CheckCircle2, LogIn, MoveRight, RefreshCw, Search, X } from 'lucide-react';
import { opdClinics, type Clinic } from '../../lib/patients';
import { findRoom } from '../../lib/scene-data';
import { actionKey, canDo, covers, type AuthUser, type QueueSync } from '../../lib/queue';
import { CheckInCard, type CheckInResult } from '../CheckInCard';
import { NumPick, addDays, dayOf, timeOf, today, weekdayNames } from './Booking';
import { Select } from '../Select';
import { DatePicker } from '../DatePicker';
import { ModalPortal } from '../ModalPortal';

// Doctor appointments (Phase 2): administrators set each clinic's rules and the doctors' sessions; staff make, move
// and cancel appointments for patients and decide on requests to move; supervisors record a no-show (after the time,
// with a reason). The server checks everything; these screens show what it says.
type Api = QueueSync['api'];
type Policy = {clinicCode:string; displayName:string; enabled:boolean; advanceDays:number; cancelCutoffMinutes:number; rescheduleNeedsApproval:boolean; version:number};
type Session = {id:string; providerCode:string; providerName:string; startsAt:string; endsAt:string; status:'OPEN'|'CLOSED'|'CANCELLED'; capacity:number; reserved:number; roomId?:string};
// A doctor's exam room (opd-205 → "ห้องตรวจ 205"); appointment patients wait for that room.
const roomLabel = (id?:string) => id ? findRoom(id)?.name ?? id : '';
type Slot = {id:string; providerCode:string; providerName:string; startsAt:string; endsAt:string; remaining:number; status:string};
type Appt = {id:string; code:string; clinicCode:string; clinicName:string; providerName:string; roomId?:string; startsAt:string; endsAt:string; hn:string; channel:'STAFF'|'LINE';
 status:'CONFIRMED'|'CANCELLED'|'CHECKED_IN'|'COMPLETED'|'NO_SHOW'|'EXPIRED'; cancellationReason?:string; noShowReason?:string;
 pendingRequest?:{id:string; startsAt:string; endsAt:string; providerName:string; reason?:string}};
type Req = {id:string; reason?:string; createdAt:string; appointment:Appt; to:{startsAt:string; endsAt:string; providerName:string}};
const statusText:Record<Appt['status'],string> = {CONFIRMED:'นัดแล้ว',CANCELLED:'ยกเลิก',CHECKED_IN:'มาแล้ว',COMPLETED:'ตรวจแล้ว',NO_SHOW:'ไม่มาตามนัด',EXPIRED:'หมดอายุ'};
const clinicName = (c:Clinic) => `${c.letter} · ${c.dept}`;
type Say = (r:{ok:boolean; reason?:string}, ok:string) => void;

function usePolicies(api:Api, rev:number) {
 const [policies,setPolicies] = useState<Policy[]>([]);
 const load = useCallback(async ()=>{ const r = await api<{ok:boolean; policies?:Policy[]}>('appt:policies',{}); if (r.ok) setPolicies(r.policies ?? []); },[api]);
 useEffect(()=>{ void load(); },[load,rev]);
 return {policies,reload:load};
}

// ---- Settings → นัดแพทย์ (administrators) ----------------------------------------------------------------------
export function ApptAdminPane({api,rev,features,setFeature}:{api:Api; rev:number; features:QueueSync['features']; setFeature:(on:boolean)=>Promise<void>}) {
 const clinics = useMemo(()=>opdClinics(),[]);
 const {policies,reload} = usePolicies(api,rev);
 const [msg,setMsg] = useState<{text:string; bad?:boolean}|null>(null);
 useEffect(()=>{ if (!msg) return; const t = setTimeout(()=>setMsg(null),6000); return ()=>clearTimeout(t); },[msg]);
 const say:Say = (r, ok) => setMsg(r.ok ? {text:ok} : {text:r.reason ?? 'บันทึกไม่สำเร็จ',bad:true});
 const save = async (c:Clinic, patch:Record<string,unknown>) => { const r = await api('appt:policy:set',{clinicCode:c.key,displayName:c.dept,queuePrefix:c.letter,...patch}); say(r,`บันทึกกติกานัด ${c.dept} แล้ว`); if (r.ok) void reload(); };
 const on = !!features.phase2.appointments, ready = clinics.filter(c=>policies.some(p=>p.clinicCode===c.key));
 return <section className="setCard bookAdmin">
  <div className={'bookSwitch'+(on?' on':'')}><div><b>ระบบนัดแพทย์ {on?'เปิดใช้งาน':'ปิดอยู่'}</b>
   <small>ถ้า HIS ของโรงพยาบาลเป็นเจ้าของตารางนัดอยู่แล้ว ให้ปิดไว้ เพื่อไม่ให้มีตารางนัดสองชุด · ตั้งตารางแพทย์ไว้ก่อนเปิดได้</small></div>
   <button className={on?'btn ghost':'btn'} onClick={()=>void setFeature(!on)}>{on?'ปิดระบบนัด':'เปิดระบบนัด'}</button></div>
  {msg && <p className={'setToast'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}
  <h4 className="setSub">กติกาต่อคลินิก <small>นัดล่วงหน้าได้กี่วัน · ยกเลิก/ขอเลื่อนได้ถึงก่อนนัดกี่ชั่วโมง · การเลื่อนนัดต้องให้เจ้าหน้าที่อนุมัติหรือไม่</small></h4>
  <div className="tableWrap"><table className="dataTable bookRules"><thead><tr><th>คลินิก</th><th>เปิดนัด</th><th>ล่วงหน้า</th><th>ยกเลิกก่อน</th><th>เลื่อนนัด</th></tr></thead>
   <tbody>{clinics.map(c=>{ const p = policies.find(x=>x.clinicCode===c.key);
    return <tr key={c.key}><td><b>{clinicName(c)}</b>{p && <small className="muted"> · v{p.version}</small>}</td>
     <td><button className={'chip'+(p?.enabled?' on':'')} aria-pressed={!!p?.enabled} onClick={()=>void save(c,{enabled:!p?.enabled})}>{p?.enabled?'เปิด':'ปิด'}</button></td>
     <td><NumPick value={p?.advanceDays ?? 90} options={[14,30,60,90,180,365]} unit="วัน" onPick={v=>void save(c,{advanceDays:v})}/></td>
     <td><NumPick value={(p?.cancelCutoffMinutes ?? 1440)/60} options={[0,2,24,48,72]} unit="ชม." onPick={v=>void save(c,{cancelCutoffMinutes:v*60})}/></td>
     <td><button className={'chip'+((p?.rescheduleNeedsApproval ?? true)?' on':'')} onClick={()=>void save(c,{rescheduleNeedsApproval:!(p?.rescheduleNeedsApproval ?? true)})}>
      {(p?.rescheduleNeedsApproval ?? true)?'ต้องอนุมัติ':'ผู้ป่วยเลื่อนเองได้'}</button></td></tr>; })}</tbody></table></div>
  {ready.length ? <><SessionPlanner api={api} clinics={ready} say={say}/><SessionList api={api} rev={rev} clinics={ready} say={say}/></>
   : <p className="cmdNote">ตั้งกติกาของคลินิกอย่างน้อย 1 แห่งก่อน แล้วจึงสร้างตารางออกตรวจของแพทย์</p>}
 </section>;
}

function SessionPlanner({api,clinics,say}:{api:Api; clinics:Clinic[]; say:Say}) {
 const [clinic,setClinic] = useState(clinics[0].key);
 const [code,setCode] = useState('');
 const [name,setName] = useState('');
 const [from,setFrom] = useState(()=>addDays(today(),1));
 const [to,setTo] = useState(()=>addDays(today(),28));
 const [days,setDays] = useState<number[]>([1]);
 const [start,setStart] = useState('09:00');
 const [end,setEnd] = useState('12:00');
 const [minutes,setMinutes] = useState(15);
 const [capacity,setCapacity] = useState(2);
 const [room,setRoom] = useState('');
 const [busy,setBusy] = useState(false);
 const rooms = clinics.find(c=>c.key===clinic)?.rooms ?? [];
 useEffect(()=>setRoom(''),[clinic]);
 const make = async () => {
  setBusy(true);
  const r = await api<{ok:boolean; reason?:string; sessions?:number; slots?:number; skipped?:number; conflicts?:string[]}>('appt:sessions:create',
   {clinicCode:clinic,providerCode:code.trim(),providerName:name.trim(),from,to,weekdays:days,start,end,minutes,capacity,...(room?{roomId:room}:{})});
  setBusy(false);
  say(r,`สร้างตารางออกตรวจ ${r.sessions ?? 0} วัน (${r.slots ?? 0} ช่วงนัด)${r.skipped?` · มีอยู่แล้ว ${r.skipped} วัน`:''}${r.conflicts?.length?` · ข้าม ${r.conflicts.length} วันที่แพทย์มีตารางซ้อน: ${r.conflicts.map(d=>dayOf(d)).join(', ')}`:''}`);
 };
 return <div className="slotPlan">
  <h4 className="setSub">ตารางออกตรวจของแพทย์ <small>แบ่งเป็นช่วงนัด · แพทย์คนเดียวกันจะไม่ถูกลงตารางซ้อนเวลา</small></h4>
  <div className="slotPlanGrid">
   <label>คลินิก<Select value={clinic} onChange={setClinic} options={clinics.map(c=>({value:c.key,label:clinicName(c),sub:`ชั้น ${c.level}`}))}/></label>
   <label>รหัสแพทย์<input value={code} maxLength={20} placeholder="รหัสใน HIS / เลข ว." onChange={e=>setCode(e.target.value)}/></label>
   <label className="wide">ชื่อแพทย์<input value={name} maxLength={60} placeholder="เช่น นพ.สมชาย ใจดี" onChange={e=>setName(e.target.value)}/></label>
   <label>ตั้งแต่<DatePicker value={from} onChange={setFrom}/></label>
   <label>ถึง<DatePicker value={to} min={from} onChange={setTo}/></label>
   <label className="wide">เวลา<span className="timeRange"><input type="time" value={start} onChange={e=>setStart(e.target.value)}/>–<input type="time" value={end} onChange={e=>setEnd(e.target.value)}/></span></label>
   <label>ช่วงละ<Select value={minutes} onChange={setMinutes} options={[10,15,20,30,60].map(m=>({value:m,label:`${m} นาที`}))}/></label>
   <label>นัดต่อช่วง<input type="number" min={1} max={100} value={capacity} onChange={e=>setCapacity(Math.max(1,Math.min(100,Number(e.target.value)||1)))}/></label>
   <label className="wide">ห้องตรวจ<Select value={room} onChange={setRoom} options={[{value:'',label:'ไม่ระบุ (ห้องที่ว่างของคลินิก)'},...rooms.map(r=>({value:r.id,label:r.name}))]}/></label>
  </div>
  <div className="segBtns">{weekdayNames.map((d,i)=><button key={i} className={days.includes(i)?'on':''} aria-pressed={days.includes(i)} onClick={()=>setDays(x=>x.includes(i)?x.filter(y=>y!==i):[...x,i].sort())}>{d}</button>)}
   <button className="btn" disabled={busy || !days.length || !code.trim() || !name.trim()} onClick={()=>void make()}><CalendarPlus size={15}/> {busy?'กำลังสร้าง…':'สร้างตาราง'}</button></div>
 </div>;
}

// roomOnly: the supervisors' view on the queue page — today's doctors and their rooms, nothing else to change.
function SessionList({api,rev,clinics,say,roomOnly=false}:{api:Api; rev:number; clinics:Clinic[]; say:Say; roomOnly?:boolean}) {
 const [clinic,setClinic] = useState(clinics[0].key);
 const [date,setDate] = useState(()=>roomOnly ? today() : addDays(today(),1));
 const rooms = clinics.find(c=>c.key===clinic)?.rooms ?? [];
 const [list,setList] = useState<Session[]>([]);
 const [cancelFor,setCancelFor] = useState<string|null>(null);
 const [reason,setReason] = useState('');
 const load = useCallback(async ()=>{ const r = await api<{ok:boolean; sessions?:Session[]}>('appt:sessions',{clinicCode:clinic,date}); setList(r.ok ? r.sessions ?? [] : []); },[api,clinic,date]);
 useEffect(()=>{ void load(); },[load,rev]);
 const set = async (s:Session, change:Record<string,unknown>, ok:string) => { const r = await api('appt:session:set',{sessionId:s.id,...change}); say(r,ok); setCancelFor(null); setReason(''); void load(); };
 return <div className="slotList">
  {roomOnly ? <h4 className="setSub">ห้องตรวจของแพทย์ <small>ผู้ป่วยนัดรอที่ห้องของแพทย์ · แพทย์ย้ายห้อง: เปลี่ยนที่นี่ ผู้ป่วยที่รออยู่ย้ายตามไปด้วย</small></h4>
   : <h4 className="setSub">ตารางแพทย์ของวัน <small>ปิดรับ = ไม่รับนัดเพิ่ม · ยกเลิก = แพทย์ไม่ออกตรวจ นัดทั้งหมดในตารางถูกยกเลิกพร้อมเหตุผล · ห้องตรวจ: ผู้ป่วยนัดรอที่ห้องนี้</small></h4>}
  <div className="slotListHead"><Select value={clinic} onChange={setClinic} aria-label="คลินิก" className="selFilter" options={clinics.map(c=>({value:c.key,label:clinicName(c),sub:`ชั้น ${c.level}`}))}/>
   <DatePicker value={date} onChange={setDate} aria-label="วันที่" className="dpFilter"/></div>
  {list.length ? <div className="tableWrap"><table className="dataTable compact"><thead><tr><th>แพทย์</th><th>เวลา</th><th>ห้องตรวจ</th><th className="num">นัดแล้ว</th>{!roomOnly && <th className="num">รับได้</th>}<th>สถานะ</th>{!roomOnly && <th/>}</tr></thead>
   <tbody>{list.map(s=><tr key={s.id} className={s.status!=='OPEN'?'muted':''}><td><b>{s.providerName}</b> <small className="muted">{s.providerCode}</small></td>
    <td>{timeOf(s.startsAt)}–{timeOf(s.endsAt)}</td>
    <td>{s.status==='CANCELLED' ? roomLabel(s.roomId) || '—' : <Select size="sm" className="roomPick" aria-label={`ห้องตรวจของ ${s.providerName}`} value={s.roomId ?? ''}
     onChange={v=>void set(s,{roomId:v},v?`${s.providerName} ตรวจที่${roomLabel(v)}`:`${s.providerName} ไม่ระบุห้อง`)}
     options={[{value:'',label:'ไม่ระบุ'},...rooms.map(r=>({value:r.id,label:r.name}))]}/>}</td>
    <td className="num">{s.reserved}</td>{!roomOnly && <td className="num">{s.capacity}</td>}<td>{s.status==='OPEN'?'เปิด':s.status==='CLOSED'?'ปิดรับ':'ยกเลิก'}</td>
    {!roomOnly && <td className="slotActs">{s.status==='OPEN' && <button className="btn ghost sm" onClick={()=>void set(s,{status:'CLOSED'},`ปิดรับนัด ${s.providerName} แล้ว`)}>ปิดรับ</button>}
     {s.status==='CLOSED' && <button className="btn ghost sm" onClick={()=>void set(s,{status:'OPEN'},`เปิดรับนัด ${s.providerName} แล้ว`)}>เปิดรับ</button>}
     {s.status!=='CANCELLED' && (cancelFor===s.id
      ? <span className="slotCancel"><input value={reason} maxLength={100} placeholder="เหตุผล เช่น แพทย์ลาประชุม" onChange={e=>setReason(e.target.value)}/>
         <button className="btn sm" disabled={!reason.trim()} onClick={()=>void set(s,{status:'CANCELLED',reason},`ยกเลิกตาราง ${s.providerName} แล้ว`)}>ยืนยัน</button>
         <button className="iconBtn" aria-label="ไม่ยกเลิก" onClick={()=>setCancelFor(null)}><X size={14}/></button></span>
      : <button className="linkBtn danger" onClick={()=>{ setCancelFor(s.id); setReason(''); }}>ยกเลิกตาราง{s.reserved?` (${s.reserved} นัด)`:''}</button>)}</td>}</tr>)}</tbody></table></div>
   : <p className="cmdNote">ยังไม่มีตารางแพทย์ของวันนี้</p>}
 </div>;
}

// ---- Queue page → นัดหมาย (staff) ------------------------------------------------------------------------------------
const cancelReasons = ['ผู้ป่วยขอยกเลิก','แพทย์สั่งเลื่อน/ยกเลิก','นัดผิด'];
const noShowReasons = ['โทรติดต่อแล้วไม่มา','ติดต่อไม่ได้'];
export function ApptTab({api,rev,user,features}:{api:Api; rev:number; user?:AuthUser|null; features:QueueSync['features']}) {
 const clinics = useMemo(()=>opdClinics().filter(c=>covers(user,c.key)),[user]);
 const {policies} = usePolicies(api,rev);
 const open = clinics.filter(c=>policies.some(p=>p.clinicCode===c.key && p.enabled));
 const [date,setDate] = useState(today);
 const [clinic,setClinic] = useState('');
 const [find,setFind] = useState('');
 const [list,setList] = useState<Appt[]>([]);
 const [found,setFound] = useState<Appt[]|null>(null);
 const [requests,setRequests] = useState<Req[]>([]);
 const [msg,setMsg] = useState<{text:string; bad?:boolean}|null>(null);
 const [menu,setMenu] = useState<{id:string; kind:'cancel'|'noshow'}|null>(null);
 const [picker,setPicker] = useState<{mode:'new'}|{mode:'move'; appt:Appt}|null>(null);
 const [checked,setChecked] = useState<CheckInResult|null>(null);
 const [rejectFor,setRejectFor] = useState<string|null>(null);
 const [note,setNote] = useState('');
 useEffect(()=>{ if (!msg) return; const t = setTimeout(()=>setMsg(null),6000); return ()=>clearTimeout(t); },[msg]);
 const load = useCallback(async ()=>{
  const [a,r] = await Promise.all([api<{ok:boolean; appointments?:Appt[]}>('appt:list',{date,clinicCode:clinic||undefined}),api<{ok:boolean; requests?:Req[]}>('appt:requests',{})]);
  setList(a.ok ? a.appointments ?? [] : []); setRequests(r.ok ? r.requests ?? [] : []);
 },[api,date,clinic]);
 useEffect(()=>{ void load(); },[load,rev]);
 const say = (r:{ok:boolean; reason?:string}, ok:string) => { setMsg(r.ok ? {text:ok} : {text:r.reason ?? 'ไม่สำเร็จ',bad:true}); if (r.ok) { void load(); if (found) setFound(null); } };
 const search = async () => {
  const q = find.trim(); if (!q) { setFound(null); return; }
  const r = await api<{ok:boolean; appointments?:Appt[]; reason?:string}>('appt:list',/^ap/i.test(q) ? {code:q} : {hn:q});
  if (r.ok) setFound(r.appointments ?? []); else setMsg({text:r.reason ?? 'ค้นหาไม่สำเร็จ',bad:true});
 };
 const act = async (a:Appt, kind:'cancel'|'noshow', reason:string) => {
  setMenu(null);
  const r = await api(kind==='cancel'?'appt:cancel':'appt:noshow',{appointmentId:a.id,reason});
  say(r,kind==='cancel'?`ยกเลิกนัด ${a.code} แล้ว`:`บันทึก ${a.code} ไม่มาตามนัด`);
 };
 const checkIn = async (a:Appt) => {
  const now = new Date();
  const r = await api<CheckInResult>('checkin:code',{code:a.code,channel:'COUNTER',at:now.getHours()*60+now.getMinutes(),prefix:clinics.find(c=>c.key===a.clinicCode)?.letter});
  if (r.ok) { setChecked(r); void load(); } else setMsg({text:r.reason ?? 'เช็กอินไม่สำเร็จ',bad:true});
 };
 const decide = async (q:Req, approve:boolean) => {
  const r = await api('appt:decide',{requestId:q.id,approve,note:approve?undefined:note});
  setRejectFor(null); setNote('');
  say(r,approve?`อนุมัติเลื่อน ${q.appointment.code} เป็น ${dayOf(q.to.startsAt)} ${timeOf(q.to.startsAt)} แล้ว`:`ไม่อนุมัติคำขอของ ${q.appointment.code}`);
 };
 const on = !!features.phase2.appointments, rows = found ?? list, supervisor = canDo(user,'supervisor'), now = new Date();
 return <div className="bookTab">
  {!on && <p className="serviceNote">ระบบนัดแพทย์ยังปิดอยู่ · ผู้ดูแลระบบเปิดได้ที่ ตั้งค่า → นัดแพทย์ (ดูรายการเดิมได้ตามปกติ)</p>}
  <div className="bookBar">
   <button className="btn" disabled={!on || !open.length} onClick={()=>setPicker({mode:'new'})}><CalendarPlus size={15}/> นัดผู้ป่วย</button>
   <DatePicker value={date} onChange={d=>{ setDate(d); setFound(null); }} aria-label="วันที่" className="dpFilter"/>
   <Select value={clinic} onChange={setClinic} aria-label="คลินิก" className="selFilter" options={[{value:'',label:'ทุกคลินิก'},...clinics.filter(c=>policies.some(p=>p.clinicCode===c.key)).map(c=>({value:c.key,label:clinicName(c),sub:`ชั้น ${c.level}`}))]}/>
   <form className="bookFind" onSubmit={e=>{ e.preventDefault(); void search(); }}><Search size={14}/><input value={find} onChange={e=>setFind(e.target.value)} placeholder="รหัสนัด (AP…) หรือ HN"/>
    {found && <button type="button" className="iconBtn" aria-label="ล้างการค้นหา" onClick={()=>{ setFind(''); setFound(null); }}><X size={14}/></button>}</form>
   <button className="iconBtn" aria-label="โหลดใหม่" onClick={()=>void load()}><RefreshCw size={15}/></button>
  </div>
  {msg && <p className={'consoleMsg'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}
  {requests.length>0 && <div className="apptReqs"><h4>คำขอเลื่อนนัดรอพิจารณา <em>{requests.length}</em></h4>
   {requests.map(q=><div key={q.id} className="apptReq">
    <span><b className="bookCode">{q.appointment.code}</b> {q.appointment.hn} · {q.appointment.clinicName}</span>
    <span className="apptMove">{dayOf(q.appointment.startsAt)} {timeOf(q.appointment.startsAt)} <MoveRight size={14}/> <b>{dayOf(q.to.startsAt)} {timeOf(q.to.startsAt)}</b> · {q.to.providerName}</span>
    {q.reason && <small className="muted">เหตุผล: {q.reason}</small>}
    {rejectFor===q.id ? <span className="slotCancel"><input value={note} maxLength={100} placeholder="เหตุผลที่ไม่อนุมัติ / เสนอวันอื่น" onChange={e=>setNote(e.target.value)}/>
      <button className="btn sm" disabled={!note.trim()} onClick={()=>void decide(q,false)}>ไม่อนุมัติ</button><button className="iconBtn" aria-label="กลับ" onClick={()=>setRejectFor(null)}><X size={14}/></button></span>
     : <span className="slotActs"><button className="btn sm" onClick={()=>void decide(q,true)}><Check size={13}/> อนุมัติ</button><button className="linkBtn danger" onClick={()=>{ setRejectFor(q.id); setNote(''); }}>ไม่อนุมัติ</button></span>}
   </div>)}</div>}
  {supervisor && open.length>0 && <details className="roomDetails"><summary>ห้องตรวจของแพทย์วันนี้ (หัวหน้างาน)</summary>
   <SessionList api={api} rev={rev} clinics={clinics.filter(c=>policies.some(p=>p.clinicCode===c.key))} say={say} roomOnly/></details>}
  <p className="cmdNote">{found ? `ผลค้นหา ${found.length} รายการ` : `${dayOf(date)} · นัด ${list.filter(a=>a.status!=='CANCELLED').length} คน`} · HN แสดง 4 ตัวท้าย · ผู้ป่วยเช็กอินที่ตู้หรือเคาน์เตอร์ด้วยรหัส AP</p>
  {rows.length ? <div className="tableWrap"><table className="dataTable bookList"><thead><tr><th>เวลา</th><th>รหัสนัด</th><th>แพทย์</th><th>คลินิก</th><th>HN</th><th>สถานะ</th><th/></tr></thead>
   <tbody>{rows.map(a=>{ const isToday = new Date(a.startsAt).toLocaleDateString('sv-SE')===today(), over = new Date(a.endsAt)<now;
    return <tr key={a.id} className={['CANCELLED','EXPIRED','NO_SHOW'].includes(a.status)?'muted':''}>
    <td>{found?`${dayOf(a.startsAt)} `:''}{timeOf(a.startsAt)}</td><td><b className="bookCode">{a.code}</b></td><td>{a.providerName}{a.roomId && <small className="muted"> · {roomLabel(a.roomId)}</small>}</td><td>{a.clinicName}</td><td>{a.hn}</td>
    <td><span className={'bookState s-'+(a.status==='CHECKED_IN'?'CHECKED_IN':a.status)}>{statusText[a.status]}</span>
     {a.pendingRequest && <small className="apptPending"> · ขอเลื่อนเป็น {dayOf(a.pendingRequest.startsAt)} {timeOf(a.pendingRequest.startsAt)}</small>}
     {(a.cancellationReason || a.noShowReason) && <small className="muted"> · {a.cancellationReason ?? a.noShowReason}</small>}</td>
    <td className="slotActs">{a.status==='CONFIRMED' && (menu?.id===a.id
     ? <span className="slotCancel">{(menu.kind==='cancel'?cancelReasons:noShowReasons).map(r=><button key={r} className="btn ghost sm" onClick={()=>void act(a,menu.kind,r)}>{r}</button>)}
        <button className="iconBtn" aria-label="กลับ" onClick={()=>setMenu(null)}><X size={14}/></button></span>
     : <>{isToday && !over && <button className="btn sm" onClick={()=>void checkIn(a)}><LogIn size={13}/> เช็กอิน</button>}
        {!over && <button className="btn ghost sm" disabled={!on} onClick={()=>setPicker({mode:'move',appt:a})}>เลื่อน</button>}
        {!over && <button className="linkBtn danger" onClick={()=>setMenu({id:a.id,kind:'cancel'})}>ยกเลิก</button>}
        {over && supervisor && <button className="linkBtn danger" onClick={()=>setMenu({id:a.id,kind:'noshow'})}>ไม่มาตามนัด</button>}
        {over && !supervisor && <small className="muted">เลยเวลานัด · หัวหน้างานบันทึกไม่มาตามนัดได้</small>}</>)}</td></tr>; })}</tbody></table></div>
   : <p className="ncEmpty">{found ? 'ไม่พบนัด' : 'ยังไม่มีนัดในวันนี้'}</p>}
  {picker && <ApptPicker api={api} clinics={picker.mode==='move' ? clinics.filter(c=>c.key===picker.appt.clinicCode) : open} policies={policies}
   move={picker.mode==='move' ? picker.appt : undefined} onClose={()=>setPicker(null)}
   onDone={(text,day)=>{ setMsg({text}); if (day) setDate(day); setFound(null); void load(); }}/>}
  {checked && <ModalPortal><div className="modalBack" onClick={()=>setChecked(null)}><div className="moveDialog visitDialog" role="dialog" aria-modal="true" aria-label="ผลการเช็กอิน" onClick={e=>e.stopPropagation()}>
   <header><div><b>เช็กอิน {checked.source?.code}</b><small className="muted">ให้ผู้ป่วยสแกน QR หรือพิมพ์บัตรคิว</small></div><button className="iconBtn" aria-label="ปิด" onClick={()=>setChecked(null)}><X size={18}/></button></header>
   <CheckInCard r={checked}/><footer><button className="btn ghost" onClick={()=>window.print()}>พิมพ์บัตรคิว</button><button className="btn" onClick={()=>setChecked(null)}>เสร็จ</button></footer></div></div></ModalPortal>}
 </div>;
}

// Make an appointment (HN, clinic, day, doctor's slot) — or move one (same clinic).
function ApptPicker({api,clinics,policies,move,onClose,onDone}:{api:Api; clinics:Clinic[]; policies:Policy[]; move?:Appt; onClose:()=>void; onDone:(text:string, day?:string)=>void}) {
 const [hn,setHn] = useState('');
 const [clinic,setClinic] = useState(move?.clinicCode ?? clinics[0]?.key ?? '');
 const [date,setDate] = useState(()=>move ? new Date(move.startsAt).toLocaleDateString('sv-SE') : addDays(today(),7));
 const [slots,setSlots] = useState<Slot[]|null>(null);
 const [slotId,setSlotId] = useState('');
 const [busy,setBusy] = useState(false);
 const [error,setError] = useState('');
 const [made,setMade] = useState<Appt|null>(null);
 const [k,setK] = useState({sig:'',key:''});
 const sig = `${move?.id ?? hn.trim()}|${slotId}`, key = k.sig===sig ? k.key : '';
 useEffect(()=>{ if (k.sig!==sig) setK({sig,key:actionKey()}); },[sig,k.sig]);
 const p = policies.find(x=>x.clinicCode===clinic);
 // Days with a free time in this clinic: ‹ › jump between them, so empty weekends and full days are skipped.
 const [days,setDays] = useState<string[]>([]);
 useEffect(()=>{ let live = true;
  void api<{ok:boolean; days?:string[]}>('appt:days',{clinicCode:clinic,except:move?.id}).then(r=>{ if (!live) return; const d = r.ok ? r.days ?? [] : []; setDays(d);
   if (!move) setDate(x=>d.includes(x) ? x : d[0] ?? x); });
  return ()=>{ live = false; }; },[api,clinic,move]);
 const prevDay = [...days].reverse().find(d=>d<date), nextDay = days.find(d=>d>date);
 useEffect(()=>{ let live = true; setSlots(null); setSlotId('');
  void api<{ok:boolean; slots?:Slot[]}>('appt:slots',{clinicCode:clinic,date,bookable:true}).then(r=>{ if (live) setSlots(r.ok ? r.slots ?? [] : []); });
  return ()=>{ live = false; }; },[api,clinic,date]);
 useEffect(()=>{ const f = (e:KeyboardEvent)=>{ if (e.key==='Escape') onClose(); }; window.addEventListener('keydown',f); return ()=>window.removeEventListener('keydown',f); },[onClose]);
 const byDoctor = useMemo(()=>{ const m = new Map<string,Slot[]>(); (slots ?? []).forEach(s=>m.set(s.providerName,[...(m.get(s.providerName) ?? []),s])); return [...m.entries()]; },[slots]);
 const slot = slots?.find(s=>s.id===slotId);
 const submit = async () => {
  if (busy || !key || !slot) return;
  setBusy(true); setError('');
  const r = move ? await api<{ok:boolean; reason?:string; appointment?:Appt}>('appt:reschedule',{appointmentId:move.id,slotId,key})
   : await api<{ok:boolean; reason?:string; appointment?:Appt}>('appt:create',{hn:hn.trim(),slotId,key});
  setBusy(false);
  if (!r.ok || !r.appointment) { setError(r.reason ?? 'ไม่สำเร็จ'); return; }
  const a = r.appointment, when = `${dayOf(a.startsAt)} ${timeOf(a.startsAt)} · ${a.providerName}`;
  if (move) { onDone(`เลื่อนนัด ${a.code} เป็น ${when} แล้ว`,new Date(a.startsAt).toLocaleDateString('sv-SE')); onClose(); }
  else { setMade(a); onDone(`นัดแล้ว ${a.code} · ${when}`,new Date(a.startsAt).toLocaleDateString('sv-SE')); }
 };
 return <ModalPortal><div className="modalBack" onClick={onClose}>
  <div className="moveDialog visitDialog" role="dialog" aria-modal="true" aria-labelledby="apptTitle" onClick={e=>e.stopPropagation()}>
   <header><div><b id="apptTitle">{move ? `เลื่อนนัด ${move.code}` : 'นัดผู้ป่วยพบแพทย์'}</b>
    <small className="muted">{move ? `เดิม ${dayOf(move.startsAt)} ${timeOf(move.startsAt)} · ${move.providerName} — ที่เดิมจะคืนเมื่อได้ที่ใหม่แล้วเท่านั้น` : 'ตรวจบัตรประชาชนตามขั้นตอนเดิมก่อน · ระบบเก็บเฉพาะ HN'}</small></div>
    <button className="iconBtn" aria-label="ปิด" onClick={onClose}><X size={18}/></button></header>
   {made ? <div className="visitMade"><CheckCircle2 size={28}/><span>นัดแล้ว</span><b className="mvQueue big">{made.code}</b>
    <small className="muted">{made.clinicName} · {made.providerName} · {dayOf(made.startsAt)} {timeOf(made.startsAt)}</small>
    <p className="cmdNote">แจ้งรหัสนี้ให้ผู้ป่วย · วันนัดเช็กอินที่ตู้ด้วยรหัส AP หรือที่เคาน์เตอร์</p>
    <div className="qrActs"><button className="btn" onClick={onClose}>เสร็จ</button></div></div> : <>
    {!move && <div className="visitRow"><span>HN ของผู้ป่วย</span><input className="bookHn" value={hn} maxLength={20} autoFocus placeholder="เช่น 65-123456" onChange={e=>setHn(e.target.value)}/></div>}
    {!move && <div className="visitRow"><span>คลินิก</span><div className="visitClinics">{clinics.map(c=><button key={c.key} className={c.key===clinic?'on':''} aria-pressed={c.key===clinic} onClick={()=>setClinic(c.key)}>
     <b>{c.letter}</b><span>{c.dept}</span><small>ชั้น {c.level}</small></button>)}</div></div>}
    <div className="visitRow"><span>วันที่ <small className="muted">(นัดล่วงหน้าได้ {p?.advanceDays ?? 90} วัน)</small></span>
     <span className="apptDate"><DatePicker value={date} min={today()} max={addDays(today(),p?.advanceDays ?? 90)} onChange={setDate} aria-label="วันนัด" className="dpFilter"/>
      <button className="btn ghost sm" disabled={!prevDay} onClick={()=>prevDay && setDate(prevDay)}>‹ วันว่างก่อนหน้า</button><button className="btn ghost sm" disabled={!nextDay} onClick={()=>nextDay && setDate(nextDay)}>วันว่างถัดไป ›</button></span></div>
    <div className="visitRow"><span>แพทย์และเวลา</span>
     {slots===null ? <p className="cmdNote">กำลังโหลด…</p> : byDoctor.length ? byDoctor.map(([doc,list])=><div key={doc} className="apptDoc"><b>{doc}</b>
      <div className="segBtns">{list.map(s=>{ const current = !!move && s.startsAt===move.startsAt && s.providerName===move.providerName;
       return <button key={s.id} className={s.id===slotId?'on':''} aria-pressed={s.id===slotId} disabled={current} onClick={()=>setSlotId(s.id)}>{timeOf(s.startsAt)} <small>{current?'(เดิม)':`ว่าง ${s.remaining}`}</small></button>; })}</div></div>)
      : <p className="cmdNote">ไม่มีช่วงนัดที่ยังว่างในวันนี้ · ลองวันอื่น</p>}</div>
    {error && <p className="loginError" role="alert">{error}</p>}
    <footer><button className="btn ghost" onClick={onClose}>ยกเลิก</button>
     <button className="btn" disabled={busy || (!move && !hn.trim()) || !slot} onClick={()=>void submit()}>{busy?'กำลังบันทึก…':slot?`${move?'ยืนยันเลื่อนเป็น':'ยืนยันนัด'} ${timeOf(slot.startsAt)}`:'เลือกแพทย์และเวลา'}</button></footer>
   </>}
  </div>
 </div></ModalPortal>;
}
