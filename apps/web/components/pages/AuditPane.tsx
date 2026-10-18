'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AuthUser, QueueSync } from '../../lib/queue';
import { Select } from '../Select';

// Settings → บันทึกการใช้งาน (administrators): who did what, to which record, and why — accounts, settings, switches,
// bookings, appointments, check-ins, LINE links, look-ups by HN. Staff appear by name (from their account); patients only
// as "ผู้ป่วย (LINE)"; records by opaque ids. Nothing here shows an HN or a LINE id.
type Api = QueueSync['api'];
type Entry = {id:number; createdAt:string; actorType:string; actorId?:string; action:string; targetType?:string; targetId?:string; outcome:string; reason?:string; meta?:Record<string,unknown>};
const actionText:Record<string,string> = {
 'user.create':'สร้างบัญชีผู้ใช้','user.update':'แก้บัญชีผู้ใช้','settings.update':'แก้การตั้งค่า','ticket.renew':'ออก QR บัตรคิวใหม่','feature.enable':'เปิดฟีเจอร์','feature.disable':'ปิดฟีเจอร์',
 'visit.enter':'รับผู้ป่วยเข้าคิว','visit.cancel':'ยกเลิกคิว','booking.policy':'แก้กติกาการจอง','booking.slots.create':'สร้างช่วงเวลาจอง','booking.slot.update':'แก้ช่วงเวลาจอง',
 'booking.create':'จองคิว','booking.cancel':'ยกเลิกการจอง','booking.search.hn':'ค้นการจองด้วย HN','checkin.booking':'เช็กอิน (จอง)','checkin.appointment':'เช็กอิน (นัด)',
 'appointment.policy':'แก้กติกาการนัด','appointment.sessions.create':'สร้างตารางแพทย์','appointment.session.update':'แก้ตารางแพทย์','appointment.create':'นัดแพทย์',
 'appointment.cancel':'ยกเลิกนัด','appointment.reschedule':'เลื่อนนัด','appointment.reschedule.request':'ขอเลื่อนนัด','appointment.reschedule.approve':'อนุมัติเลื่อนนัด',
 'appointment.reschedule.reject':'ไม่อนุมัติเลื่อนนัด','appointment.noshow':'บันทึกไม่มาตามนัด','appointment.search.hn':'ค้นนัดด้วย HN','line.link':'เชื่อมบัญชี LINE',
 'line.unlink':'ยกเลิกเชื่อม LINE (ผู้ป่วย)','line.revoke':'ยกเลิกเชื่อม LINE (เจ้าหน้าที่)','line.status':'ตรวจสถานะเชื่อม LINE','notify.retry':'ส่งข้อความใหม่',
 'wayfinding.save':'แก้จุดนำทาง','wayfinding.import':'นำเข้าจุดนำทาง','wayfinding.retire':'เลิกใช้จุดนำทาง',
 'retention.update':'แก้ระยะเวลาเก็บข้อมูล','retention.run':'สั่งล้างข้อมูลเก่า','retention.purge':'ลบข้อมูลเก่าตามระยะเวลาเก็บ',
 'reception.kiosk.create':'ลงทะเบียนตู้ต้อนรับ','reception.kiosk.update':'แก้ตู้ต้อนรับ','reception.kiosk.rotate':'ออกรหัสตู้ใหม่','reception.kiosk.revoke':'ยกเลิกตู้ต้อนรับ',
 'reception.answer.save':'แก้คำตอบของตู้ (ร่าง)','reception.answer.approve':'อนุมัติคำตอบของตู้','reception.answer.retire':'เลิกใช้คำตอบของตู้','reception.help.ack':'รับเรื่องจากตู้ต้อนรับ','reception.settings':'ตั้งค่าข้อมูลคิวบนตู้'};
const groups:[string,string][] = [['','ทั้งหมด'],['user','บัญชีผู้ใช้'],['settings','การตั้งค่า'],['feature','ฟีเจอร์'],['booking','การจอง'],['appointment','นัดหมาย'],['visit','คิว'],
 ['line-link','บัญชี LINE'],['patient-search','การค้นข้อมูลผู้ป่วย'],['destination','จุดนำทาง']];
const when = (iso:string) => new Date(iso).toLocaleString('th-TH',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'});

export function AuditPane({api,listUsers}:{api:Api; listUsers:QueueSync['listUsers']}) {
 const [entries,setEntries] = useState<Entry[]>([]);
 const [group,setGroup] = useState('');
 const [users,setUsers] = useState<AuthUser[]>([]);
 const load = useCallback(async ()=>{ const r = await api<{ok:boolean; entries?:Entry[]}>('audit:list',{targetType:group || undefined,limit:300}); if (r.ok) setEntries(r.entries ?? []); },[api,group]);
 useEffect(()=>{ void load(); },[load]);
 useEffect(()=>{ void listUsers().then(r=>{ if (r.ok) setUsers(r.users ?? []); }); },[listUsers]);
 const names = useMemo(()=>new Map(users.map(u=>[`user:${u.id}`,u.name])),[users]);
 const who = (e:Entry) => e.actorType==='staff' ? names.get(e.actorId ?? '') ?? e.actorId : e.actorType==='patient' ? 'ผู้ป่วย (LINE)' : e.actorType==='his' ? 'HIS' : 'ระบบ';
 return <section className="setCard">
  <div className="slotListHead"><Select value={group} onChange={setGroup} aria-label="ประเภท" className="selFilter" options={groups.map(([k,l])=>({value:k,label:l}))}/>
   <button className="iconBtn" aria-label="โหลดใหม่" onClick={()=>void load()}><RefreshCw size={15}/></button>
   <small className="muted">300 รายการล่าสุด · ผู้ป่วยแสดงเป็นรหัสอ้างอิง ไม่แสดง HN หรือบัญชี LINE</small></div>
  {entries.length ? <div className="tableWrap tall"><table className="dataTable compact"><thead><tr><th>เวลา</th><th>ผู้ทำ</th><th>การกระทำ</th><th>รายการ</th><th>เหตุผล / รายละเอียด</th></tr></thead>
   <tbody>{entries.map(e=><tr key={e.id}><td>{when(e.createdAt)}</td><td>{who(e)}</td><td>{actionText[e.action] ?? e.action}</td>
    <td><small className="muted">{e.targetType ?? ''}{e.targetId ? ` · ${e.targetId}` : ''}</small></td>
    <td><small>{e.reason ?? ''}{e.meta ? `${e.reason ? ' · ' : ''}${Object.entries(e.meta).map(([k,v])=>`${k}: ${typeof v==='object' ? JSON.stringify(v) : String(v)}`).join(', ')}` : ''}</small></td></tr>)}</tbody></table></div>
   : <p className="cmdNote">ยังไม่มีรายการ</p>}
 </section>;
}
