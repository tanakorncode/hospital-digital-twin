'use client';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { CheckCircle2, MapPin } from 'lucide-react';
import { opdClinics, type LiveVisit } from '../lib/patients';

// What a booked patient gets at check-in (counter or kiosk): the queue number, where to wait, and the QR of their
// own queue page. No name, no HN — this is shown on a screen and may be printed.
export type CheckInResult = {ok:boolean; reason?:string; already?:boolean; late?:boolean; visit?:LiveVisit; ticket?:{token:string; expiresAt:string};
 booking?:{code:string; serviceName:string; startsAt:string; endsAt:string}};
export function CheckInCard({r,big=false}:{r:CheckInResult; big?:boolean}) {
 const [src,setSrc] = useState('');
 const url = typeof window!=='undefined' && r.ticket ? `${window.location.origin}/q/${r.ticket.token}` : '';
 useEffect(()=>{ if (url) QRCode.toDataURL(url,{margin:1,width:big?320:200}).then(setSrc).catch(()=>setSrc('')); },[url,big]);
 const c = opdClinics().find(x=>x.key===r.visit?.clinicKey);
 if (!r.visit) return null;
 return <div className={'checkInCard'+(big?' big':'')}>
  <span className="ciOk"><CheckCircle2 size={big?34:24}/> {r.already ? 'เช็กอินไว้แล้ว · เลขคิวเดิม' : 'เช็กอินเรียบร้อย'}</span>
  <small className="ciLabel">หมายเลขคิวของคุณ</small>
  <b className="ciQueue">{r.visit.queue}</b>
  <span className="ciWhere"><MapPin size={big?22:16}/> ไปรอที่ พื้นที่รอ{r.visit.dept}{c?` · OPD ชั้น ${c.level}`:''}</span>
  <small className="ciNext">ขั้นแรก: ซักประวัติ / วัดสัญญาณชีพ · จองไว้ {r.visit.bookedSlot ?? ''}</small>
  {src && <img className="ciQr" src={src} alt={`QR หน้าคิว ${r.visit.queue}`}/>}
  <small className="ciHint">สแกน QR เพื่อดูลำดับคิวและแผนที่นำทางบนมือถือ · ไม่ต้องนั่งรอหน้าห้อง</small>
  {r.late && <small className="ciLate">เช็กอินนอกช่วงเวลาที่จอง</small>}
 </div>;
}
