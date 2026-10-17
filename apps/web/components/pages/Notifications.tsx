'use client';
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
import type { QueueSync } from '../../lib/queue';

// Settings → การแจ้งเตือน (administrators): the LINE messages to patients — switch, whether LINE is set up, what was
// sent, what is waiting to retry, what failed (and send it again). Recipients are never shown.
type Api = QueueSync['api'];
type Job = {id:string; template:string; status:string; attempts:number; lastError?:string; scheduledAt:string; sentAt?:string; createdAt:string};
const templateText:Record<string,string> = {BOOKING_CONFIRMED:'ยืนยันการจอง',BOOKING_CANCELLED:'การจองถูกยกเลิก',APPT_CONFIRMED:'มีนัดใหม่',APPT_REMINDER:'เตือนนัด',
 APPT_RESCHEDULED:'นัดเปลี่ยนเวลา',APPT_RESCHEDULE_REJECTED:'ไม่อนุมัติเลื่อนนัด',APPT_CANCELLED:'นัดถูกยกเลิก',CHECKIN_DONE:'เช็กอินแล้ว',
 QUEUE_CALL:'ถึงคิว',QUEUE_RECALL:'เรียกคิวซ้ำ',QUEUE_TRANSFER:'ย้ายจุดบริการ',QUEUE_HELP:'รับเรื่องขอความช่วยเหลือ'};
const statusText:Record<string,string> = {PENDING:'รอส่ง',PROCESSING:'กำลังส่ง',SENT:'ส่งแล้ว',RETRY:'รอส่งใหม่',FAILED:'ส่งไม่สำเร็จ',CANCELLED:'ยกเลิก (ไม่ต้องส่ง)',SKIPPED:'ข้าม'};
const errorText:Record<string,string> = {LINE_NOT_CONFIGURED:'ยังไม่ได้ตั้งค่า LINE OA',NO_LINKED_LINE:'ผู้ป่วยไม่ได้เชื่อม LINE'};
const filters = ['','FAILED','RETRY','PENDING','SENT','SKIPPED'];
const when = (iso:string) => new Date(iso).toLocaleString('th-TH',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});

export function NotificationsPane({api,features,setFeature}:{api:Api; features:QueueSync['features']; setFeature:(on:boolean)=>Promise<void>}) {
 const [status,setStatus] = useState('');
 const [data,setData] = useState<{jobs:Job[]; counts:Record<string,number>; line:boolean}|null>(null);
 const [msg,setMsg] = useState<{text:string; bad?:boolean}|null>(null);
 const load = useCallback(async ()=>{ const r = await api<{ok:boolean; jobs?:Job[]; counts?:Record<string,number>; line?:boolean}>('notify:jobs',{status});
  if (r.ok) setData({jobs:r.jobs ?? [],counts:r.counts ?? {},line:!!r.line}); },[api,status]);
 useEffect(()=>{ void load(); const t = setInterval(()=>void load(),15_000); return ()=>clearInterval(t); },[load]);
 const retry = async (j:Job) => { const r = await api('notify:retry',{id:j.id}); setMsg(r.ok ? {text:'ส่งใหม่แล้ว'} : {text:r.reason ?? 'ส่งใหม่ไม่สำเร็จ',bad:true}); void load(); };
 const on = !!features.phase2.notifications;
 return <section className="setCard">
  <div className={'bookSwitch'+(on?' on':'')}><div><b>แจ้งเตือนผู้ป่วยทาง LINE {on?'เปิดอยู่':'ปิดอยู่'}</b>
   <small>ยืนยันการจอง · เตือนนัดก่อน 1 วัน (18:00) · ผลการขอเลื่อนนัด · นัด/การจองถูกยกเลิก · เช็กอินและเรียกคิว — ส่งเฉพาะผู้ป่วยที่เชื่อมบัญชี LINE · ข้อความไม่มีชื่อ HN คลินิก หรือชื่อแพทย์</small></div>
   <button className={on?'btn ghost':'btn'} onClick={()=>void setFeature(!on)}>{on?'ปิด':'เปิด'}</button></div>
  {data && !data.line && <p className="serviceNote">ยังไม่ได้ตั้งค่า LINE OA ของโรงพยาบาล (LINE_CHANNEL_ACCESS_TOKEN) · ข้อความจะถูกข้ามจนกว่าจะตั้งค่า — ดู docs/DEPLOY.md</p>}
  {msg && <p className={'setToast'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}
  {data && <div className="notifyCounts">{['SENT','RETRY','FAILED','SKIPPED','PENDING'].map(k=><span key={k} className={'nc-'+k}><b>{data.counts[k] ?? 0}</b>{statusText[k]}</span>)}<small className="muted">7 วันล่าสุด</small></div>}
  <div className="slotListHead"><select value={status} onChange={e=>setStatus(e.target.value)} aria-label="กรองตามสถานะ">{filters.map(f=><option key={f} value={f}>{f ? statusText[f] : 'ทุกสถานะ'}</option>)}</select>
   <button className="iconBtn" aria-label="โหลดใหม่" onClick={()=>void load()}><RefreshCw size={15}/></button></div>
  {data?.jobs.length ? <div className="tableWrap tall"><table className="dataTable compact"><thead><tr><th>เมื่อ</th><th>ข้อความ</th><th>สถานะ</th><th className="num">ครั้ง</th><th>หมายเหตุ</th><th/></tr></thead>
   <tbody>{data.jobs.map(j=><tr key={j.id}><td>{when(j.sentAt ?? j.scheduledAt)}</td><td>{templateText[j.template] ?? j.template}</td>
    <td><span className={'notifyState s-'+j.status}>{statusText[j.status] ?? j.status}</span></td><td className="num">{j.attempts}</td>
    <td><small className="muted">{j.lastError ? errorText[j.lastError] ?? j.lastError : j.status==='RETRY' ? `ลองใหม่ ${when(j.scheduledAt)}` : ''}</small></td>
    <td>{(j.status==='FAILED' || j.status==='SKIPPED') && <button className="btn ghost sm" onClick={()=>void retry(j)}><RotateCcw size={12}/> ส่งใหม่</button>}</td></tr>)}</tbody></table></div>
   : <p className="cmdNote">ยังไม่มีข้อความ</p>}
 </section>;
}
