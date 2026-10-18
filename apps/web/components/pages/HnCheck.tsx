'use client';
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Search } from 'lucide-react';

// The first step of booking or giving an appointment: check the HN before picking a clinic and a time, so nobody
// fills in the rest for an HN that is wrong. This system keeps no patient register (HIS is the source of identity):
// the check says whether the HN has been used here before, what it already has coming (appointments, bookings), and
// whether LINE is linked. An HN new here is fine once staff confirm they checked it against the card / HIS.
type Api = <T extends {ok:boolean; reason?:string}>(event:string, body:unknown)=>Promise<T>;
export type HnInfo = {known:boolean; lineLinked:boolean; appointments:{code:string; clinicCode:string; clinicName:string; providerName:string; startsAt:string}[];
  bookings:{code:string; serviceName:string; startsAt:string}[]};
export const HN_OK = /^[0-9A-Za-z-]{3,20}$/; // as the API takes it (apps/api/src/booking.service.ts)
const when = (iso:string) => new Date(iso).toLocaleString('th-TH',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});

export function useHnCheck(api:Api) {
  const [hn,setHnRaw] = useState(''), [result,setResult] = useState<{hn:string; info:HnInfo}|null>(null);
  const [checking,setChecking] = useState(false), [error,setError] = useState(''), [sure,setSure] = useState(false);
  const value = hn.trim(), info = result && result.hn===value ? result.info : null, ready = !!info && (info.known || sure);
  const setHn = (v:string) => { setHnRaw(v); setError(''); setSure(false); };
  const check = async () => {
    if (!HN_OK.test(value) || checking) { if (!HN_OK.test(value)) setError('HN ใช้ตัวเลข ตัวอักษรอังกฤษ และ - ยาว 3–20 ตัว'); return; }
    setChecking(true); setError('');
    const r = await api<{ok:boolean; reason?:string; patient?:HnInfo}>('patient:hn',{hn:value});
    setChecking(false);
    if (r.ok && r.patient) setResult({hn:value,info:r.patient}); else setError(r.reason ?? 'ตรวจ HN ไม่สำเร็จ');
  };
  // What is missing before the rest of the form makes sense (for the hint next to the confirm button).
  const missing = !value ? 'ใส่ HN ของผู้ป่วย แล้วกด "ตรวจ HN"' : !HN_OK.test(value) ? 'HN ใช้ตัวเลข ตัวอักษรอังกฤษ และ - ยาว 3–20 ตัว'
    : checking ? 'กำลังตรวจ HN…' : !info ? 'กด "ตรวจ HN" ก่อน' : !ready ? 'ยืนยันว่าตรวจ HN กับบัตรหรือ HIS แล้ว' : '';
  const view = <div className="hnStep">
    <form className="hnRow" onSubmit={e=>{ e.preventDefault(); void check(); }}>
      <input className="bookHn" value={hn} maxLength={20} autoFocus inputMode="text" placeholder="เช่น 65-123456" aria-label="HN ของผู้ป่วย" onChange={e=>setHn(e.target.value)}/>
      <button className="btn" type="submit" disabled={checking || !value}>{checking ? <Loader2 size={15} className="spin"/> : <Search size={15}/>} {checking ? 'กำลังตรวจ…' : 'ตรวจ HN'}</button>
    </form>
    {error && <p className="loginError" role="alert">{error}</p>}
    {info && (info.known
      ? <div className="hnCard ok" role="status"><CheckCircle2 size={18}/><div><b>พบ HN นี้ในระบบ</b>
          <small>{info.lineLinked ? 'เชื่อม LINE แล้ว · ' : ''}{info.appointments.length || info.bookings.length ? 'มีรายการที่จะถึง:' : 'ไม่มีนัดหรือการจองที่จะถึง'}</small>
          {(info.appointments.length>0 || info.bookings.length>0) && <ul>{info.appointments.map(a=><li key={a.code}><b>{a.code}</b> นัด {a.clinicName} · {a.providerName} · {when(a.startsAt)}</li>)}
            {info.bookings.map(x=><li key={x.code}><b>{x.code}</b> จอง {x.serviceName} · {when(x.startsAt)}</li>)}</ul>}</div></div>
      : <div className="hnCard new" role="status"><AlertTriangle size={18}/><div><b>HN นี้ยังไม่เคยมีในระบบนี้</b>
          <small>ระบบนี้ไม่มีทะเบียนผู้ป่วย (ข้อมูลผู้ป่วยอยู่ที่ HIS) — ตรวจ HN กับบัตรผู้ป่วยหรือ HIS ให้ถูกต้องก่อน</small>
          <label className="hnSure"><input type="checkbox" checked={sure} onChange={e=>setSure(e.target.checked)}/> ตรวจกับบัตร/HIS แล้ว เป็นผู้ป่วยรายนี้จริง</label></div></div>)}
  </div>;
  return {hn:value, info, ready, missing, view};
}
