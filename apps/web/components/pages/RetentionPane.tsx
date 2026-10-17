'use client';
import { useCallback, useEffect, useState } from 'react';
import { Eraser, RefreshCw } from 'lucide-react';
import type { QueueSync } from '../../lib/queue';

// Settings → การเก็บข้อมูล (administrators): how long finished records are kept (pilot decision D7). Each category is
// "keep for ever" until the hospital sets a period; before saving, the pane shows what the new periods would remove
// now. Records still in use (confirmed bookings/appointments, active LINE links, messages waiting, today's queue) are
// never removed. The server runs the clean-up every 6 hours (apps/api/src/retention.service.ts).
type Api = QueueSync['api'];
type Cat = 'bookings'|'appointments'|'queue'|'lineLinks'|'notifications'|'reception'|'audit';
type Retention = Record<Cat,number>;
type Run = {at:string; removed:Record<string,number>};
const cats:[Cat,string,string][] = [
 ['bookings','การจองล่วงหน้า','การจองที่ยกเลิก/หมดอายุ/เช็กอินแล้ว นับจากวันที่จอง'],
 ['appointments','นัดแพทย์','นัดที่ยกเลิก/ไม่มา/เช็กอินแล้ว และตารางแพทย์ที่ผ่านไปแล้ว'],
 ['queue','ประวัติคิวรายวัน','เลขคิว ขั้นตอน ลิงก์ QR บัตรคิว ของวันที่ผ่านมา'],
 ['lineLinks','การเชื่อม LINE ที่สิ้นสุดแล้ว','การเชื่อมที่ยกเลิกแล้ว (ที่ยังใช้อยู่ไม่ถูกลบ)'],
 ['notifications','ข้อความที่ส่งแล้ว','ส่งแล้ว/ไม่สำเร็จ/ยกเลิก (ที่รอส่งไม่ถูกลบ)'],
 ['reception','ยอดใช้งานตู้ต้อนรับ','จำนวนครั้งต่อวัน (ไม่มีข้อความที่ผู้ใช้พิมพ์)'],
 ['audit','บันทึกการใช้งาน (audit)','ต้องเก็บนานไม่น้อยกว่าหมวดอื่นที่ตั้งไว้'],
];
const presets = [0,90,180,365,730,1825];
const presetText = (d:number) => d===0 ? 'เก็บตลอด' : d%365===0 ? `${d/365} ปี` : `${d} วัน`;
// Names the server uses in its counts → Thai.
const removedText:Record<string,string> = {bookings:'การจอง','booking slots':'ช่วงเวลาจอง','check-ins':'บันทึกเช็กอิน',appointments:'นัด','appointment slots':'ช่วงเวลานัด',
 'doctor sessions':'ตารางแพทย์','requests to move':'คำขอเลื่อนนัด','queue log':'บันทึกคิว',visits:'ผู้ป่วยในคิว','queue numbers':'ตัวนับเลขคิว','walk-in check-ins':'เช็กอินหน้างาน',
 'queue-slip links':'ลิงก์บัตรคิว','ended LINE links':'การเชื่อม LINE ที่สิ้นสุด','message attempts':'ประวัติการส่ง',messages:'ข้อความ','audit entries':'บันทึกการใช้งาน',
 'patient records':'ระเบียนผู้ป่วย (HN) ที่ไม่มีรายการเหลือ','retry keys':'คีย์กันกดซ้ำ','staff sessions':'การเข้าระบบเจ้าหน้าที่ที่หมดอายุ','patient sessions':'การเข้าระบบผู้ป่วยที่หมดอายุ',
 'kiosk use counts':'ยอดใช้งานตู้ต้อนรับ','link codes':'รหัสเชื่อมบัญชีที่หมดอายุ','LINE codes':'รหัส LINE ที่หมดอายุ','LINE queue subscriptions':'การรับแจ้งเตือนคิวที่หมดอายุ'};
const list = (r:Record<string,number>) => Object.entries(r).map(([k,n])=>`${removedText[k] ?? k} ${n.toLocaleString('th-TH')}`).join(' · ');
const when = (iso:string) => new Date(iso).toLocaleString('th-TH',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});

export function RetentionPane({api}:{api:Api}) {
 const [saved,setSaved] = useState<Retention|null>(null);
 const [draft,setDraft] = useState<Retention|null>(null);
 const [preview,setPreview] = useState<Record<string,number>|null>(null);
 const [last,setLast] = useState<Run|undefined>();
 const [msg,setMsg] = useState<{text:string; bad?:boolean}|null>(null);
 const [busy,setBusy] = useState(false);
 const changed = !!saved && !!draft && (Object.keys(draft) as Cat[]).some(k=>draft[k]!==saved[k]);
 const load = useCallback(async (proposed?:Retention)=>{
  const r = await api<{ok:boolean; reason?:string; settings?:Retention; last?:Run; preview?:Record<string,number>}>('retention:get',proposed ? {proposed} : {});
  if (!r.ok) { setMsg({text:r.reason ?? 'โหลดไม่สำเร็จ',bad:true}); setPreview(null); return; }
  setSaved(r.settings!); setLast(r.last); setPreview(r.preview ?? {}); if (!proposed) setDraft(r.settings!);
  setMsg(null);
 },[api]);
 useEffect(()=>{ void load(); },[load]);
 // A changed period: show what it would remove (no saving yet).
 useEffect(()=>{ if (draft && changed) { const t = setTimeout(()=>void load(draft),300); return ()=>clearTimeout(t); } },[draft,changed,load]);
 const save = async () => {
  if (!draft) return; setBusy(true);
  const r = await api<{ok:boolean; reason?:string}>('retention:set',{patch:draft});
  setBusy(false);
  if (r.ok) { setMsg({text:'บันทึกแล้ว · ระบบจะลบตามนี้ในรอบถัดไป (ทุก 6 ชั่วโมง) หรือกด "ล้างตอนนี้"'}); void load(); } else setMsg({text:r.reason ?? 'บันทึกไม่สำเร็จ',bad:true});
 };
 const runNow = async () => {
  setBusy(true);
  const r = await api<{ok:boolean; reason?:string; last?:Run}>('retention:run',{});
  setBusy(false);
  if (r.ok) { setMsg({text:Object.keys(r.last?.removed ?? {}).length ? `ลบแล้ว: ${list(r.last!.removed)}` : 'ไม่มีอะไรต้องลบ'}); void load(); } else setMsg({text:r.reason ?? 'ไม่สำเร็จ',bad:true});
 };
 if (!draft) return <section className="setCard">{msg ? <p className="setToast bad">{msg.text}</p> : <p className="muted">กำลังโหลด…</p>}</section>;
 const allKept = (Object.values(draft)).every(d=>d===0);
 return <section className="setCard">
  <h4 className="setSub">ระยะเวลาเก็บข้อมูล <small>รอโรงพยาบาลกำหนด (D7) · ค่าตั้งต้น = เก็บตลอด · ลบเฉพาะรายการที่จบแล้ว รายการที่ยังใช้อยู่ไม่ถูกลบไม่ว่าตั้งค่าอย่างไร</small></h4>
  {msg && <p className={'setToast'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}
  <div className="retList">{cats.map(([k,title,sub])=><div key={k} className="retRow">
   <div><b>{title}</b><small>{sub}</small></div>
   <div className="segBtns">{presets.map(d=><button key={d} className={draft[k]===d?'on':''} aria-pressed={draft[k]===d} onClick={()=>setDraft({...draft,[k]:d})}>{presetText(d)}</button>)}
    <label className="retDays">หรือ <input type="number" min={30} max={3650} value={presets.includes(draft[k]) ? '' : draft[k]} placeholder="วัน"
     onChange={e=>{ const v = Number(e.target.value); setDraft({...draft,[k]:Number.isFinite(v) ? Math.round(v) : 0}); }}/> วัน</label></div>
  </div>)}</div>
  <div className="retPreview">
   {changed ? <p><b>ถ้าบันทึก จะลบตอนนี้:</b> {preview && Object.keys(preview).length ? list(preview) : 'ไม่มี'}</p>
    : <p><b>ตามค่าที่บันทึกไว้ รอบถัดไปจะลบ:</b> {preview && Object.keys(preview).length ? list(preview) : allKept ? 'ไม่มี (เก็บตลอดทุกหมวด)' : 'ไม่มี'}</p>}
   <p className="muted">รอบล่าสุด: {last ? `${when(last.at)} · ${Object.keys(last.removed).length ? list(last.removed) : 'ไม่มีอะไรต้องลบ'}` : 'ยังไม่เคยรัน'}</p>
   <p className="muted">ทำทุกครั้งอยู่แล้ว (ไม่ต้องตั้ง): การเข้าระบบที่หมดอายุ · คีย์กันกดซ้ำเกิน 7 วัน · รหัสเชื่อมบัญชีเกิน 1 วัน · ลิงก์บัตรคิวที่หมดอายุเกิน 7 วัน</p>
  </div>
  <div className="segBtns">
   <button className="on" disabled={!changed || busy} onClick={()=>void save()}>บันทึก</button>
   {changed && <button onClick={()=>{ setDraft(saved); void load(); }}>ยกเลิกการแก้</button>}
   <button disabled={busy || changed} onClick={()=>void runNow()} title="ลบตามค่าที่บันทึกไว้ทันที"><Eraser size={14}/> ล้างตอนนี้</button>
   <button className="iconBtn" aria-label="โหลดใหม่" onClick={()=>void load()}><RefreshCw size={15}/></button>
  </div>
  <p className="muted"><small>การลบถาวร — ไฟล์สำรองข้อมูล (backup) ที่ทำไว้ก่อนหน้ายังมีข้อมูลเดิมจนกว่าจะหมุนเวียนออก (เก็บ 14 ชุด) · ทุกครั้งที่ลบบันทึกจำนวนไว้ใน "บันทึกการใช้งาน"</small></p>
 </section>;
}
