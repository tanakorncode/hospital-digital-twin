'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarPlus, Check, CheckCircle2, Loader2, LogIn, MoveRight, Plus, RefreshCw, Search, X } from 'lucide-react';
import { useHnCheck } from './HnCheck';
import { InfoTip } from './FacilityHelp';
import { opdClinics, type Clinic } from '../../lib/patients';
import { findRoom, isOff, type Room } from '../../lib/scene-data';
import { buildingShort } from '../../lib/facility';
import { actionKey, canDo, covers, type AuthUser, type QueueSync } from '../../lib/queue';
import { CheckInCard, type CheckInResult } from '../CheckInCard';
import { NumPick, addDays, dayOf, timeOf, today, weekdayNames } from './Booking';
import { Select } from '../Select';
import { DatePicker } from '../DatePicker';
import { ModalPortal } from '../ModalPortal';

// A doctor's room as the facility has it: its name, floor, and switched-off rooms shown but not choosable (the API only
// takes the clinic's open exam rooms).
const roomOption = (r:Room) => { const off = isOff(`room:${r.id}`) || isOff(r.pointId);
  return {value:r.id,label:r.name,sub:`${buildingShort(r.buildingId)} ชั้น ${r.level}${off ? ' · ปิดอยู่' : ''}`,disabled:off}; };

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

export function usePolicies(api:Api, rev:number) {
 const [policies,setPolicies] = useState<Policy[]>([]);
 const load = useCallback(async ()=>{ const r = await api<{ok:boolean; policies?:Policy[]}>('appt:policies',{}); if (r.ok) setPolicies(r.policies ?? []); },[api]);
 useEffect(()=>{ void load(); },[load,rev]);
 return {policies,reload:load};
}

// ---- Settings → นัดแพทย์ (administrators) ----------------------------------------------------------------------
export function ApptAdminPane({api,rev,features,setFeature,onDoctors}:{api:Api; rev:number; features:QueueSync['features']; setFeature:(on:boolean)=>Promise<void>; onDoctors?:()=>void}) {
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
  {ready.length ? <><div className="docPointer"><div><b>ตารางออกตรวจของแพทย์</b><small>เพิ่มแพทย์และสร้างตารางออกตรวจได้ที่หน้า รายชื่อแพทย์ — เลือกแพทย์ แล้วสร้างตารางของคนนั้น</small></div>
    {onDoctors && <button className="btn" onClick={onDoctors}>ไปที่รายชื่อแพทย์</button>}</div>
   <SessionList api={api} rev={rev} clinics={ready} say={say}/></>
   : <p className="cmdNote">ตั้งกติกาของคลินิกอย่างน้อย 1 แห่งก่อน แล้วจึงสร้างตารางออกตรวจของแพทย์</p>}
 </section>;
}

// Settings → นัดแพทย์: a doctor's schedule — who and where; the weekly hours (rows: these weekdays, from … to — mornings
// on some days, afternoons on others, both on one day), cut into appointment times of N minutes, M patients each; and
// the dates it runs. The summary at the bottom (always in view) says what will be made, or what is still missing.
const WEEKDAY_FULL = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
const WEEK_ORDER = [1,2,3,4,5,6,0]; // Monday first, as clinics plan their week
const NEW_DOCTOR = '__new';
export type Provider = {code:string; name:string; clinics:string[]; note?:string; active:boolean; upcoming:number; nextAt?:string};
type Block = {id:number; days:number[]; start:string; end:string};
const toMin = (t:string) => Number(t.slice(0,2))*60+Number(t.slice(3,5)), hhmm = (m:number) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
let blockSeq = 0;
// fixed: the doctor's own page (Settings → รายชื่อแพทย์) — the schedule is for this doctor, their clinics first.
export function SessionPlanner({api,clinics,say,fixed,onMade}:{api:Api; clinics:Clinic[]; say:Say; fixed?:Provider; onMade?:()=>void}) {
 const [clinic,setClinic] = useState(()=>(fixed && clinics.find(c=>fixed.clinics.includes(c.key)))?.key ?? clinics[0].key);
 const [providers,setProviders] = useState<Provider[]>([]);
 const [doctor,setDoctor] = useState(fixed?.code ?? NEW_DOCTOR);
 useEffect(()=>{ if (fixed) setDoctor(fixed.code); },[fixed]);
 const [code,setCode] = useState('');
 const [name,setName] = useState('');
 const [room,setRoom] = useState('');
 const [blocks,setBlocks] = useState<Block[]>(()=>[{id:++blockSeq,days:[1],start:'09:00',end:'12:00'}]);
 const [minutes,setMinutes] = useState(15);
 const [capacity,setCapacity] = useState(2);
 const [from,setFrom] = useState(()=>addDays(today(),1));
 const [to,setTo] = useState(()=>addDays(today(),27));
 const [busy,setBusy] = useState(false);
 const [done,setDone] = useState<{text:string; bad?:boolean}|null>(null);
 const rooms = clinics.find(c=>c.key===clinic)?.rooms ?? [];
 useEffect(()=>setRoom(''),[clinic]);
 const loadProviders = useCallback(async ()=>{ const r = await api<{ok:boolean; providers?:Provider[]}>('appt:providers',{}); if (r.ok) setProviders(r.providers ?? []); },[api]);
 useEffect(()=>{ void loadProviders(); },[loadProviders]);
 // Doctors seen before (this clinic's first); a new one is typed in.
 const known = fixed ?? providers.find(x=>x.code===doctor), isNew = !known;
 const doctorOptions = providers.filter(x=>x.active).sort((a,b)=>Number(b.clinics.includes(clinic))-Number(a.clinics.includes(clinic)))
  .map(x=>({value:x.code,label:x.name,sub:`รหัส ${x.code}${x.clinics.includes(clinic) ? '' : ' · คลินิกอื่น'}`}));
 const pCode = isNew ? code.trim() : known.code, pName = isNew ? name.trim() : known.name;
 const setBlock = (id:number, patch:Partial<Block>) => setBlocks(bs=>bs.map(b=>b.id===id ? {...b,...patch} : b));
 const toggleDay = (id:number, d:number) => setBlocks(bs=>bs.map(b=>b.id!==id ? b : {...b,days:b.days.includes(d) ? b.days.filter(x=>x!==d) : [...b.days,d]}));
 // What it will make
 const dates = useMemo(()=>{ const out:{day:string; wd:number}[] = []; if (!from || !to || to<from) return out;
  for (let d = new Date(`${from}T12:00:00`); d.toLocaleDateString('sv-SE')<=to && out.length<=200; d.setDate(d.getDate()+1)) out.push({day:d.toLocaleDateString('sv-SE'),wd:d.getDay()});
  return out; },[from,to]);
 const plan = blocks.map(b=>{ const span = toMin(b.end)-toMin(b.start), slots = span>0 ? Math.floor(span/minutes) : 0;
  return {...b,slots,sessions:dates.filter(d=>b.days.includes(d.wd)).length}; });
 const workDays = new Set(dates.filter(d=>blocks.some(b=>b.days.includes(d.wd))).map(d=>d.day)).size;
 const perWeek = plan.reduce((n,b)=>n+b.days.length*b.slots*capacity,0), total = plan.reduce((n,b)=>n+b.sessions*b.slots*capacity,0);
 const overlap = (()=>{ for (let x=0; x<plan.length; x++) for (let y=x+1; y<plan.length; y++) { const a = plan[x], b = plan[y], d = a.days.find(v=>b.days.includes(v));
  if (d!==undefined && toMin(a.start)<toMin(b.end) && toMin(b.start)<toMin(a.end)) return `ช่วงที่ ${x+1} กับช่วงที่ ${y+1} ซ้อนเวลากันในวัน${WEEKDAY_FULL[d]}`; } return ''; })();
 const badBlock = plan.findIndex(b=>!b.days.length || toMin(b.end)<=toMin(b.start) || !b.slots);
 const missing = !pName ? 'กรอกชื่อแพทย์' : !pCode ? 'กรอกรหัสแพทย์' : !/^[A-Za-z0-9ก-๙._-]{1,20}$/.test(pCode) ? 'รหัสแพทย์ใช้ตัวอักษร ตัวเลข . _ - ไม่เกิน 20 ตัว (ไม่มีช่องว่าง)'
  : badBlock>=0 ? `ช่วงที่ ${badBlock+1}: ${!plan[badBlock].days.length ? 'เลือกวัน' : toMin(plan[badBlock].end)<=toMin(plan[badBlock].start) ? 'เวลาเลิกต้องหลังเวลาเริ่ม' : 'สั้นกว่าหนึ่งช่วงนัด'}`
  : overlap || (to<from ? 'วันที่สิ้นสุดต้องไม่ก่อนวันเริ่ม' : dates.length>184 ? 'สร้างได้ครั้งละไม่เกิน 6 เดือน' : !workDays ? 'ช่วงวันที่นี้ไม่มีวันที่ตรงกับวันออกตรวจ' : '');
 const make = async () => {
  setBusy(true); setDone(null);
  const r = await api<{ok:boolean; reason?:string; sessions?:number; slots?:number; skipped?:number; conflicts?:string[]}>('appt:sessions:create',
   {clinicCode:clinic,providerCode:pCode,providerName:pName,from,to,minutes,capacity,blocks:blocks.map(b=>({weekdays:b.days,start:b.start,end:b.end})),...(room?{roomId:room}:{})});
  setBusy(false);
  const text = r.ok ? `สร้างตารางแล้ว ${r.sessions ?? 0} ครั้งออกตรวจ (${r.slots ?? 0} ช่วงนัด)${r.skipped?` · มีอยู่แล้ว ${r.skipped} ครั้ง (ข้าม)`:''}${r.conflicts?.length?` · ข้าม ${r.conflicts.length} วันที่แพทย์มีตารางซ้อนเวลา: ${r.conflicts.map(d=>dayOf(d)).join(', ')}`:''}` : r.reason ?? 'สร้างไม่สำเร็จ';
  setDone({text,bad:!r.ok}); say(r,text);
  if (r.ok) { void loadProviders(); if (isNew) setDoctor(pCode); onMade?.(); }
 };
 const ranges:[string,number][] = [['4 สัปดาห์',27],['3 เดือน',90],['6 เดือน',181]];
 return <div className="schedForm">
  <h4 className="setSub">{fixed ? `สร้างตารางออกตรวจของ ${fixed.name}` : 'สร้างตารางออกตรวจของแพทย์'} <small>สร้างครั้งเดียวได้ทั้งช่วงวันที่ · ระบบแบ่งเวลาออกตรวจเป็นช่วงนัดให้ผู้ป่วยเลือก</small></h4>
  <section className="schedStep"><h5><b className="schedNum">1</b>{fixed ? 'คลินิกและห้อง' : 'แพทย์และคลินิก'}</h5>
   <div className="schedRow">
    <label>คลินิก<Select value={clinic} onChange={setClinic} options={[...clinics].sort((a,b)=>Number(!!fixed?.clinics.includes(b.key))-Number(!!fixed?.clinics.includes(a.key)))
     .map(c=>({value:c.key,label:clinicName(c),sub:`ชั้น ${c.level}${fixed && !fixed.clinics.includes(c.key) ? ' · ยังไม่เคยออกตรวจที่นี่' : ''}`}))}/></label>
    {!fixed && providers.length>0 && <label>แพทย์<Select value={doctor} onChange={setDoctor} options={[...doctorOptions,{value:NEW_DOCTOR,label:'+ แพทย์ใหม่'}]}/></label>}
    {isNew && <label>ชื่อแพทย์<input value={name} maxLength={60} placeholder="เช่น นพ.สมชาย ใจดี" onChange={e=>setName(e.target.value)}/></label>}
    {isNew && <label title="ใช้รหัสเดิมทุกครั้งสำหรับแพทย์คนเดิม — ระบบใช้รหัสนี้กันไม่ให้แพทย์คนเดียวมีตารางซ้อนเวลา"><span>รหัสแพทย์ <em>(ใช้รหัสเดิมทุกครั้ง)</em></span>
     <input value={code} maxLength={20} placeholder="เช่น ว.12345 หรือรหัสใน HIS" onChange={e=>setCode(e.target.value)}/></label>}
    <label><span>ห้องตรวจ <em>(ไม่บังคับ)</em></span><Select value={room} onChange={setRoom} options={[{value:'',label:'ห้องที่ว่างของคลินิก'},...rooms.map(roomOption)]}/></label>
   </div></section>
  <section className="schedStep"><h5><b className="schedNum">2</b>วันและเวลาออกตรวจ <small>ทุกสัปดาห์ · เพิ่มได้หลายช่วง เช่น บางวันเช้า บางวันบ่าย</small></h5>
   <div className="schedBlocks">{plan.map((b,n)=><div key={b.id} className="schedBlock">
    <span className="schedBlockNo">ช่วงที่ {n+1}</span>
    <span className="schedDays" role="group" aria-label={`วันของช่วงที่ ${n+1}`}>{WEEK_ORDER.map(d=><button key={d} type="button" className={b.days.includes(d)?'on':''} aria-pressed={b.days.includes(d)}
     title={WEEKDAY_FULL[d]} onClick={()=>toggleDay(b.id,d)}>{weekdayNames[d]}</button>)}</span>
    <span className="timeRange"><input type="time" value={b.start} aria-label={`เวลาเริ่มช่วงที่ ${n+1}`} onChange={e=>setBlock(b.id,{start:e.target.value})}/>ถึง
     <input type="time" value={b.end} aria-label={`เวลาเลิกช่วงที่ ${n+1}`} onChange={e=>setBlock(b.id,{end:e.target.value})}/></span>
    <small className="muted">{b.slots ? `${b.slots} ช่วงนัด` : ''}</small>
    {blocks.length>1 && <button type="button" className="iconBtn" aria-label={`ลบช่วงที่ ${n+1}`} title="ลบช่วงนี้" onClick={()=>setBlocks(bs=>bs.filter(x=>x.id!==b.id))}><X size={15}/></button>}
   </div>)}
    {blocks.length<14 && <button type="button" className="linkBtn schedAdd" onClick={()=>setBlocks(bs=>[...bs,{id:++blockSeq,days:[],start:'13:00',end:'16:00'}])}><Plus size={14}/> เพิ่มช่วงเวลาออกตรวจ</button>}</div>
   <div className="schedRow slim">
    <label><span>แบ่งเป็นช่วงนัด ช่วงละ <InfoTip title="ช่วงนัด คืออะไร">เวลาออกตรวจจะถูกแบ่งเป็นช่วงสั้นๆ ให้ผู้ป่วยเลือกเวลานัด
     เช่น 09:00–12:00 ช่วงละ {minutes} นาที → ผู้ป่วยเลือกได้ {Array.from({length:Math.min(3,Math.floor(180/minutes))},(_,k)=>hhmm(540+k*minutes)).join(', ')} … ({Math.floor(180/minutes)} ช่วง) ·
     ช่วงสั้นลง = มีเวลาให้เลือกมากขึ้นและผู้ป่วยรอน้อยลง แต่ต้องตรวจให้ทันในช่วงนั้น · ตั้งให้ใกล้เวลาตรวจผู้ป่วยหนึ่งคนโดยเฉลี่ย</InfoTip></span>
     <Select value={minutes} onChange={setMinutes} options={[10,15,20,30,60].map(m=>({value:m,label:`${m} นาที`}))}/></label>
    <label><span>รับนัดช่วงละ <InfoTip title="รับนัดช่วงละกี่คน">จำนวนผู้ป่วยที่นัดในช่วงเวลาเดียวกันได้ เช่น ช่วงละ {capacity} คน →
     เวลา 09:00 รับได้ {capacity} คน · ถ้าแพทย์ตรวจคนละ {minutes} นาทีพอดีให้ตั้ง 1 · ตั้งมากกว่า 1 เมื่อมีผู้ป่วยมาสาย/ไม่มา หรือตรวจเร็วกว่าความยาวช่วง</InfoTip></span><span className="schedUnit"><input type="number" min={1} max={100} value={capacity} onChange={e=>setCapacity(Math.max(1,Math.min(100,Number(e.target.value)||1)))}/>คน</span></label>
   </div></section>
  <section className="schedStep"><h5><b className="schedNum">3</b>ใช้ตารางนี้ช่วงวันที่</h5>
   <div className="schedDates">
    <DatePicker value={from} min={today()} onChange={setFrom} aria-label="ตั้งแต่วันที่"/><span>ถึง</span><DatePicker value={to} min={from} onChange={setTo} aria-label="ถึงวันที่"/>
    <span className="facViews sm schedRange" role="group" aria-label="ระยะเวลา">{ranges.map(([t,n])=><button key={t} type="button" className={to===addDays(from,n)?'on':''} onClick={()=>setTo(addDays(from,n))}>{t}</button>)}</span>
   </div></section>
  <div className={'schedSum'+(missing?' wait':'')}>
   {missing ? <span className="pickHint">{missing}</span> : <div>
    <b>{pName} · {clinicName(clinics.find(c=>c.key===clinic)!)} · {plan.map(b=>`${WEEK_ORDER.filter(d=>b.days.includes(d)).map(d=>weekdayNames[d]).join(' ')} ${b.start}–${b.end}`).join(' / ')}</b>
    <span>{workDays} วันออกตรวจ ({dayOf(from)} – {dayOf(to)}) · รับนัดได้ {perWeek} คน/สัปดาห์ · รวมทั้งหมด <b>{total} คน</b></span></div>}
   <button className="btn" disabled={busy || !!missing} onClick={()=>void make()}>{busy ? <Loader2 size={15} className="spin"/> : <CalendarPlus size={15}/>} {busy?'กำลังสร้าง…':'สร้างตาราง'}</button>
  </div>
  {done && <p className={'setToast'+(done.bad?' bad':'')} role="status">{done.text}</p>}
 </div>;
}

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
   : <h4 className="setSub">ตารางที่สร้างแล้ว (ดูทีละวัน) <small>ปิดรับ = ไม่รับนัดเพิ่ม · ยกเลิก = แพทย์ไม่ออกตรวจ นัดทั้งหมดในตารางถูกยกเลิกพร้อมเหตุผล · ห้องตรวจ: ผู้ป่วยนัดรอที่ห้องนี้</small></h4>}
  <div className="slotListHead"><Select value={clinic} onChange={setClinic} aria-label="คลินิก" className="selFilter" options={clinics.map(c=>({value:c.key,label:clinicName(c),sub:`ชั้น ${c.level}`}))}/>
   <DatePicker value={date} onChange={setDate} aria-label="วันที่" className="dpFilter"/></div>
  {list.length ? <div className="tableWrap"><table className="dataTable compact"><thead><tr><th>แพทย์</th><th>เวลา</th><th>ห้องตรวจ</th><th className="num">นัดแล้ว</th>{!roomOnly && <th className="num">รับได้</th>}<th>สถานะ</th>{!roomOnly && <th/>}</tr></thead>
   <tbody>{list.map(s=><tr key={s.id} className={s.status!=='OPEN'?'muted':''}><td><b>{s.providerName}</b> <small className="muted">{s.providerCode}</small></td>
    <td>{timeOf(s.startsAt)}–{timeOf(s.endsAt)}</td>
    <td>{s.status==='CANCELLED' ? roomLabel(s.roomId) || '—' : <Select size="sm" className="roomPick" aria-label={`ห้องตรวจของ ${s.providerName}`} value={s.roomId ?? ''}
     onChange={v=>void set(s,{roomId:v},v?`${s.providerName} ตรวจที่${roomLabel(v)}`:`${s.providerName} ไม่ระบุห้อง`)}
     options={[{value:'',label:'ไม่ระบุ'},...rooms.map(roomOption)]}/>}</td>
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
 // Open clinics without a single free appointment time (no doctor's schedule yet): said up front, not only in the picker.
 const openKey = open.map(c=>c.key).join(',');
 const [unscheduled,setUnscheduled] = useState<string[]>([]);
 useEffect(()=>{ let live = true; const keys = openKey ? openKey.split(',') : [];
  void Promise.all(keys.map(k=>api<{ok:boolean; days?:string[]}>('appt:days',{clinicCode:k}).then(r=>r.ok && !(r.days ?? []).length ? k : ''))).then(x=>{ if (live) setUnscheduled(x.filter(Boolean)); });
  return ()=>{ live = false; }; },[api,openKey,rev]);
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
  {/* Switched on, but no clinic takes appointments yet: say why "นัดผู้ป่วย" cannot be pressed, and what to do. */}
  {on && open.length>0 && unscheduled.length===open.length && <p className="serviceNote">คลินิกที่เปิดนัด ({open.length} แห่ง) ยังไม่มีตารางออกตรวจของแพทย์ จึงยังไม่มีเวลาให้นัด · ผู้ดูแลระบบสร้างได้ที่ ตั้งค่า → นัดแพทย์ → ตารางออกตรวจของแพทย์</p>}
  {on && open.length>0 && unscheduled.length>0 && unscheduled.length<open.length && <p className="cmdNote">ยังไม่มีเวลาให้นัด: {open.filter(c=>unscheduled.includes(c.key)).map(clinicName).join(', ')} (ยังไม่มีตารางแพทย์ หรือเต็ม)</p>}
  {on && !open.length && <p className="serviceNote">ยังไม่มีคลินิกที่เปิดให้นัด จึงนัดผู้ป่วยไม่ได้ · ผู้ดูแลระบบตั้งได้ที่ ตั้งค่า → นัดแพทย์: (1) กด "เปิด" ที่คลินิก (2) สร้างตารางออกตรวจของแพทย์</p>}
  <div className="bookBar">
   <button className="btn" disabled={!on || !open.length} title={!on ? 'ระบบนัดแพทย์ยังปิดอยู่' : !open.length ? 'ยังไม่มีคลินิกที่เปิดให้นัด' : undefined} onClick={()=>setPicker({mode:'new'})}><CalendarPlus size={15}/> นัดผู้ป่วย</button>
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
 // First the HN (checked), then clinic, day and time; moving an appointment keeps its patient.
 const hnc = useHnCheck(api), hn = hnc.hn, hnReady = !!move || hnc.ready;
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
    {!move && <div className="visitRow"><span>HN ของผู้ป่วย</span>{hnc.view}</div>}
    {!hnReady ? <p className="hnFirst">ตรวจ HN ก่อน แล้วจึงเลือกคลินิก วันที่ และเวลา</p> : <>
    {!move && <div className="visitRow"><span>คลินิก</span><div className="visitClinics">{clinics.map(c=><button key={c.key} className={c.key===clinic?'on':''} aria-pressed={c.key===clinic} onClick={()=>setClinic(c.key)}>
     <b>{c.letter}</b><span>{c.dept}</span><small>ชั้น {c.level}</small></button>)}</div></div>}
    <div className="visitRow"><span>วันที่ <small className="muted">(นัดล่วงหน้าได้ {p?.advanceDays ?? 90} วัน)</small></span>
     <span className="apptDate"><DatePicker value={date} min={today()} max={addDays(today(),p?.advanceDays ?? 90)} onChange={setDate} aria-label="วันนัด" className="dpFilter"/>
      <button className="btn ghost sm" disabled={!prevDay} onClick={()=>prevDay && setDate(prevDay)}>‹ วันว่างก่อนหน้า</button><button className="btn ghost sm" disabled={!nextDay} onClick={()=>nextDay && setDate(nextDay)}>วันว่างถัดไป ›</button></span></div>
    <div className="visitRow"><span>แพทย์และเวลา</span>
     {slots===null ? <p className="cmdNote"><Loader2 size={14} className="spin"/> กำลังโหลดเวลาที่ว่าง…</p> : byDoctor.length ? byDoctor.map(([doc,list])=><div key={doc} className="apptDoc"><b>{doc}</b>
      <div className="segBtns">{list.map(s=>{ const current = !!move && s.startsAt===move.startsAt && s.providerName===move.providerName;
       return <button key={s.id} className={s.id===slotId?'on':''} aria-pressed={s.id===slotId} disabled={current} onClick={()=>setSlotId(s.id)}>{timeOf(s.startsAt)} <small>{current?'(เดิม)':`ว่าง ${s.remaining}`}</small></button>; })}</div></div>)
      : days.length ? <p className="cmdNote">ไม่มีช่วงนัดที่ยังว่างในวันนี้ · ลองวันอื่น</p>
      : <p className="serviceNote">คลินิกนี้ยังไม่มีช่วงนัดที่ว่างเลย — ยังไม่มีตารางออกตรวจของแพทย์ หรือเต็มหมดแล้ว · ผู้ดูแลระบบสร้างตารางได้ที่ ตั้งค่า → นัดแพทย์ → ตารางออกตรวจของแพทย์</p>}</div>
    </>}
    {error && <p className="loginError" role="alert">{error}</p>}
    <footer>{/* What is still missing, so the button never just stays grey without a reason */}
     {!busy && <small className="pickHint">{!move && hnc.missing ? hnc.missing
       : !days.length ? 'คลินิกนี้ยังไม่มีเวลาให้นัด' : !slot ? 'เลือกเวลาจาก "แพทย์และเวลา" ด้านบน' : ''}</small>}
     <button className="btn ghost" onClick={onClose}>ยกเลิก</button>
     <button className="btn" disabled={busy || !hnReady || !slot} onClick={()=>void submit()}>{busy && <Loader2 size={15} className="spin"/>}{busy?'กำลังบันทึก…':slot?`${move?'ยืนยันเลื่อนเป็น':'ยืนยันนัด'} ${timeOf(slot.startsAt)}`:move?'ยืนยันเลื่อน':'ยืนยันนัด'}</button></footer>
   </>}
  </div>
 </div></ModalPortal>;
}
