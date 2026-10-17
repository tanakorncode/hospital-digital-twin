'use client';
import { useCallback, useEffect, useState, type MouseEvent as RMouseEvent, type ReactNode } from 'react';
import { Download, RefreshCw, Table2 } from 'lucide-react';
import { toCsv } from '../../lib/ops';
import { canDo, type AuthUser, type QueueSync } from '../../lib/queue';

// Statistics → บริการผู้ป่วย (real records, Phase 2 spec §15.1): bookings and appointments due in a range and how they
// ended, new ones by channel (how much LINE is used), check-ins, messages and LINE links. Supervisors see their own
// clinics; administrators also see the operation counters (refusals, replays, rate limits, response times).
type Api = QueueSync['api'];
type Outcome = {due:number; came:number; cancelled:number; missed:number; waiting:number};
type Report = {from:string; to:string; scoped:boolean;
 bookings:Outcome & {made:number; madeByLine:number};
 appointments:Outcome & {made:number; madeByLine:number; noShow:number; moved:number; movePending:number};
 checkIns:{total:number; kiosk:number; counter:number; outside:number};
 messages?:{sent:number; failed:number; skipped:number; waiting:number}; line?:{linked:number; ended:number; active:number};
 clinics:{clinic:string; name:string; booking:Outcome; appointment:Outcome}[]; days:{day:string; bookingsMade:number; appointmentsMade:number; checkIns:number}[]};
type Metrics = {since:string; counters:Record<string,number>; http:{total:number; serverErrors:number; p50:number; p95:number; sample:number}};
type Tip = (e:RMouseEvent, body:ReactNode)=>void;
const SERIES = {booking:'#2a78d6',appt:'#eb6834'};
const ranges:[number,string][] = [[7,'7 วัน'],[30,'30 วัน'],[90,'90 วัน']];
const iso = (d:Date) => d.toLocaleDateString('sv-SE');
const pct = (a:number, b:number) => b ? `${Math.round(a/b*100)}%` : '—';
const dayLabel = (d:string) => new Date(`${d}T00:00`).toLocaleDateString('th-TH',{day:'numeric',month:'short'});
const codeText:Record<string,string> = {VALIDATION_ERROR:'ข้อมูลไม่ถูกต้อง',AUTH_REQUIRED:'ยังไม่เข้าสู่ระบบ',FORBIDDEN:'ไม่มีสิทธิ์',RESOURCE_NOT_FOUND:'ไม่พบ',
 SLOT_FULL_OR_CLOSED:'ช่วงเวลาเต็ม/ปิด',IDEMPOTENCY_KEY_REUSED:'รหัสคำขอซ้ำกับรายการอื่น',INVALID_STATE_TRANSITION:'สถานะเปลี่ยนไปแล้ว',POLICY_REJECTED:'ขัดกติกา',
 FEATURE_DISABLED:'ฟีเจอร์ปิดอยู่',RATE_LIMITED:'ถี่เกินไป',QUEUE_ENGINE_UNAVAILABLE:'ระบบคิวไม่พร้อม',UPSTREAM_UNAVAILABLE:'ระบบภายนอกไม่พร้อม'};
const counterText = (k:string) => {
 const [kind,a,b] = k.split('.');
 if (kind==='refused') return `ปฏิเสธ · ${a==='socket'?'หน้าจอเจ้าหน้าที่':'หน้าผู้ป่วย/สาธารณะ'} · ${codeText[b] ?? b}`;
 if (kind==='replayed') return `กดซ้ำ/ส่งซ้ำ (ตอบผลเดิม) · ${a}`;
 if (kind==='rateLimited') return `ถูกจำกัดความถี่ · ${a==='command'?'คำสั่งเจ้าหน้าที่':a==='login'?'เข้าสู่ระบบ':'หน้าจอสาธารณะ'}`;
 if (k==='lineWebhook.badSignature') return 'webhook LINE ลายเซ็นไม่ถูกต้อง';
 return k;
};

export function Phase2Report({api,user,tip,hide}:{api:Api; user:AuthUser; tip:Tip; hide:()=>void}) {
 const [days,setDays] = useState(30);
 const [r,setR] = useState<Report|null>(null);
 const [m,setM] = useState<Metrics|null>(null);
 const [err,setErr] = useState('');
 const [asTable,setAsTable] = useState(false);
 const admin = canDo(user,'admin');
 const load = useCallback(async ()=>{
  const to = new Date(), from = new Date(); from.setDate(from.getDate()-days+1);
  const res = await api<{ok:boolean; reason?:string; report?:Report}>('report:phase2',{from:iso(from),to:iso(to)});
  if (res.ok) { setR(res.report!); setErr(''); } else setErr(res.reason ?? 'โหลดรายงานไม่สำเร็จ');
  if (admin) { const mm = await api<{ok:boolean; metrics?:Metrics}>('report:metrics',{}); if (mm.ok) setM(mm.metrics!); }
 },[api,days,admin]);
 useEffect(()=>{ void load(); },[load]);
 if (err) return <section className="panel"><p className="setToast bad">{err}</p></section>;
 if (!r) return <section className="panel"><p className="muted">กำลังโหลดรายงาน…</p></section>;
 const b = r.bookings, a = r.appointments, c = r.checkIns;
 const max = Math.max(1,...r.days.map(d=>d.bookingsMade+d.appointmentsMade));
 const exportCsv = () => {
  const rows:(string|number)[][] = [['หมวด','รายการ','ค่า'],
   ['การจอง','สร้างใหม่',b.made],['การจอง','สร้างผ่าน LINE',b.madeByLine],['การจอง','ถึงกำหนด',b.due],['การจอง','มา',b.came],['การจอง','ยกเลิก',b.cancelled],['การจอง','ไม่มา',b.missed],
   ['นัด','สร้างใหม่',a.made],['นัด','สร้างผ่าน LINE',a.madeByLine],['นัด','ถึงกำหนด',a.due],['นัด','มา',a.came],['นัด','ยกเลิก',a.cancelled],['นัด','ไม่มา',a.missed],['นัด','เลื่อนตามคำขอ',a.moved],
   ['เช็กอิน','ทั้งหมด',c.total],['เช็กอิน','ตู้',c.kiosk],['เช็กอิน','เคาน์เตอร์',c.counter],['เช็กอิน','นอกช่วงเวลา',c.outside],
   ...(r.messages ? [['ข้อความ','ส่งสำเร็จ',r.messages.sent],['ข้อความ','ไม่สำเร็จ',r.messages.failed],['ข้อความ','ข้าม (ไม่ได้เชื่อม/ไม่ได้ตั้ง LINE)',r.messages.skipped]] as (string|number)[][] : []),
   ...r.clinics.flatMap(x=>[[x.name,'จองถึงกำหนด/มา/ยกเลิก/ไม่มา',`${x.booking.due}/${x.booking.came}/${x.booking.cancelled}/${x.booking.missed}`],[x.name,'นัดถึงกำหนด/มา/ยกเลิก/ไม่มา',`${x.appointment.due}/${x.appointment.came}/${x.appointment.cancelled}/${x.appointment.missed}`]]),
   ...r.days.map(d=>['รายวัน',d.day,`จอง ${d.bookingsMade} · นัด ${d.appointmentsMade} · เช็กอิน ${d.checkIns}`])];
  const el = document.createElement('a');
  el.href = URL.createObjectURL(new Blob([toCsv(rows)],{type:'text/csv;charset=utf-8'})); el.download = `phase2-report-${r.from}-${r.to}.csv`; el.click(); URL.revokeObjectURL(el.href);
 };
 return <>
  <section className="panel">
   <div className="panelHead"><h3>บริการผู้ป่วย · จอง นัด เช็กอิน LINE <small className="panelMeta">ข้อมูลจริง {dayLabel(r.from)} – {dayLabel(r.to)}{r.scoped?' · เฉพาะแผนกของคุณ':''}</small></h3>
    <div className="segBtns">{ranges.map(([d,l])=><button key={d} className={days===d?'on':''} aria-pressed={days===d} onClick={()=>setDays(d)}>{l}</button>)}
     <button onClick={exportCsv}><Download size={13}/> CSV</button><button className="iconBtn" aria-label="โหลดใหม่" onClick={()=>void load()}><RefreshCw size={14}/></button></div></div>
   <div className="tileRow small">
    <div className="tile"><small>จองใหม่</small><b>{b.made}<em> รายการ</em></b><span className="muted">ผ่าน LINE {pct(b.madeByLine,b.made)}</span></div>
    <div className="tile"><small>จองที่ถึงกำหนด · มาจริง</small><b>{pct(b.came,b.due-b.waiting)}</b><span className="muted">มา {b.came} · ยกเลิก {b.cancelled} · ไม่มา {b.missed}{b.waiting?` · รอ ${b.waiting}`:''}</span></div>
    <div className="tile"><small>นัดใหม่</small><b>{a.made}<em> รายการ</em></b><span className="muted">ผ่าน LINE {pct(a.madeByLine,a.made)} · เลื่อน {a.moved}{a.movePending?` · รออนุมัติ ${a.movePending}`:''}</span></div>
    <div className="tile"><small>นัดที่ถึงกำหนด · มาตามนัด</small><b>{pct(a.came,a.due-a.waiting)}</b><span className="muted">มา {a.came} · ยกเลิก {a.cancelled} · ไม่มา {a.missed}{a.waiting?` · รอ ${a.waiting}`:''}</span></div>
    <div className="tile"><small>เช็กอิน</small><b>{c.total}<em> ครั้ง</em></b><span className="muted">ตู้ {pct(c.kiosk,c.total)} · นอกช่วงเวลา {c.outside}</span></div>
    {r.messages && <div className="tile"><small>ข้อความ LINE ส่งสำเร็จ</small><b>{pct(r.messages.sent,r.messages.sent+r.messages.failed)}</b><span className="muted">ส่ง {r.messages.sent} · ไม่สำเร็จ {r.messages.failed} · ข้าม {r.messages.skipped}</span></div>}
    {r.line && <div className="tile"><small>บัญชี LINE ที่เชื่อมอยู่</small><b>{r.line.active}<em> คน</em></b><span className="muted">ใหม่ {r.line.linked} · ยกเลิก {r.line.ended}</span></div>}
   </div>
  </section>
  <div className="pageCols">
   <section className="panel">
    <div className="panelHead"><h3>รายการใหม่ต่อวัน</h3><button className="linkBtn dark" onClick={()=>setAsTable(t=>!t)}><Table2 size={13}/> {asTable?'ดูเป็นแผนภาพ':'ดูเป็นตาราง'}</button></div>
    {asTable ? <div className="tableWrap tall"><table className="dataTable compact"><thead><tr><th>วัน</th><th className="num">จอง</th><th className="num">นัด</th><th className="num">เช็กอิน</th></tr></thead>
     <tbody>{r.days.map(d=><tr key={d.day}><td>{dayLabel(d.day)}</td><td className="num">{d.bookingsMade}</td><td className="num">{d.appointmentsMade}</td><td className="num">{d.checkIns}</td></tr>)}</tbody></table></div>
    : <><div className="vizLegend"><span><i style={{background:SERIES.booking}}/>จอง</span><span><i style={{background:SERIES.appt}}/>นัด</span><small className="muted">สูงสุด {max} รายการ/วัน</small></div>
     <div className="dayBars" role="img" aria-label="จำนวนการจองและนัดใหม่ต่อวัน">{r.days.map(d=><div key={d.day} className="dayBar" onMouseMove={e=>tip(e,<><b>{dayLabel(d.day)}</b><br/>จอง {d.bookingsMade} · นัด {d.appointmentsMade}<br/>เช็กอิน {d.checkIns}</>)} onMouseLeave={hide}>
      <span className="dayStack">{d.appointmentsMade>0 && <i style={{height:`${d.appointmentsMade/max*100}%`,background:SERIES.appt}}/>}{d.bookingsMade>0 && <i style={{height:`${d.bookingsMade/max*100}%`,background:SERIES.booking}}/>}</span>
     </div>)}</div>
     <div className="dayAxis"><span>{dayLabel(r.from)}</span><span>{dayLabel(r.to)}</span></div></>}
   </section>
   <section className="panel">
    <div className="panelHead"><h3>รายคลินิก · ที่ถึงกำหนดในช่วงนี้</h3></div>
    {r.clinics.length ? <div className="tableWrap tall"><table className="dataTable compact"><thead><tr><th>คลินิก</th><th className="num">จอง</th><th className="num">มา</th><th className="num">ยกเลิก</th><th className="num">ไม่มา</th><th className="num">นัด</th><th className="num">มา</th><th className="num">ยกเลิก</th><th className="num">ไม่มา</th></tr></thead>
     <tbody>{r.clinics.map(x=><tr key={x.clinic}><td>{x.name}</td><td className="num"><b>{x.booking.due}</b></td><td className="num">{x.booking.came}</td><td className="num">{x.booking.cancelled}</td><td className="num">{x.booking.missed}</td>
      <td className="num"><b>{x.appointment.due}</b></td><td className="num">{x.appointment.came}</td><td className="num">{x.appointment.cancelled}</td><td className="num">{x.appointment.missed}</td></tr>)}</tbody></table></div>
     : <p className="muted">ยังไม่มีการจองหรือนัดในช่วงนี้</p>}
    <p className="note">"ไม่มา" = เลยเวลาโดยไม่เช็กอิน หรือหัวหน้างานบันทึกไม่มาตามนัด · "มาจริง/มาตามนัด" ไม่นับรายการที่ยังรออยู่</p>
   </section>
  </div>
  {admin && m && <section className="panel">
   <div className="panelHead"><h3>การทำงานของระบบ <small className="panelMeta">ตั้งแต่เริ่ม API {new Date(m.since).toLocaleString('th-TH',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} · นับใหม่เมื่อรีสตาร์ต</small></h3></div>
   <div className="tileRow small">
    <div className="tile"><small>คำขอ HTTP (หน้าผู้ป่วย · LINE · HIS)</small><b>{m.http.total.toLocaleString()}</b><span className="muted">ผิดพลาดฝั่งเซิร์ฟเวอร์ {m.http.serverErrors}</span></div>
    <div className="tile"><small>เวลาตอบ (มัธยฐาน)</small><b>{m.http.p50}<em> ms</em></b><span className="muted">95% ภายใน {m.http.p95} ms</span></div>
   </div>
   {Object.keys(m.counters).length ? <div className="tableWrap"><table className="dataTable compact"><thead><tr><th>เหตุการณ์</th><th className="num">ครั้ง</th></tr></thead>
    <tbody>{Object.entries(m.counters).map(([k,v])=><tr key={k}><td>{counterText(k)}</td><td className="num">{v}</td></tr>)}</tbody></table></div> : <p className="muted">ยังไม่มีคำขอที่ถูกปฏิเสธหรือส่งซ้ำ</p>}
  </section>}
 </>;
}
