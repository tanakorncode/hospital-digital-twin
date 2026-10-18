'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Download, FileUp, Loader2, Wand2, X } from 'lucide-react';
import type { Clinic } from '../../lib/patients';
import { doctorName, roomShifts } from '../../lib/scene-data';
import type { QueueSync } from '../../lib/queue';
import { ModalPortal } from '../ModalPortal';
import { DatePicker } from '../DatePicker';
import { Select } from '../Select';
import { addDays, dayOf, today } from './Booking';

// Settings → รายชื่อแพทย์ → นำเข้า: doctors and their weekly hours from a spreadsheet — pasted (copy the cells in Excel /
// Google Sheets), a .csv file, or the demo duty roster the 3D map already shows (made-up names). One row: a doctor, a
// clinic, and optionally the days + from / to (+ room) they see patients every week. Each row is checked here; then the
// API works out exactly what it would make (dry run) before anything is kept; the import is all or nothing.
type Api = QueueSync['api'];
type Row = {line:number; code:string; name:string; clinic?:Clinic; days?:number[]; start?:string; end?:string; roomId?:string; error?:string};
type Result = {doctors:number; added:number; sessions:number; slots:number; skipped:number; conflicts:{code:string; name:string; day:string}[]};
const HEAD = ['รหัสแพทย์','ชื่อแพทย์','คลินิก','วัน','เวลาเริ่ม','เวลาเลิก','ห้องตรวจ'];
const DAY_WORDS:Record<string,number> = {อา:0,อาทิตย์:0,sun:0,sunday:0,จ:1,จันทร์:1,mon:1,monday:1,อ:2,อังคาร:2,tue:2,tuesday:2,พ:3,พุธ:3,wed:3,wednesday:3,
  พฤ:4,พฤหัส:4,พฤหัสบดี:4,thu:4,thursday:4,ศ:5,ศุกร์:5,fri:5,friday:5,ส:6,เสาร์:6,sat:6,saturday:6};
const DAY_SHORT = ['อา','จ','อ','พ','พฤ','ศ','ส'];
// "จ-ศ", "จ อ พ", "จันทร์,พุธ", "ทุกวัน", "Mon-Fri" → weekday numbers (0 = Sunday)
function parseDays(text:string):number[]|undefined {
  const t = text.trim().toLowerCase().replace(/\./g,''); if (!t) return undefined;
  if (t==='ทุกวัน' || t==='everyday') return [0,1,2,3,4,5,6];
  const out = new Set<number>();
  for (const part of t.split(/[,\s/]+/).filter(Boolean)) {
    const range = part.split(/[-–]/);
    if (range.length===2) { const a = DAY_WORDS[range[0]], b = DAY_WORDS[range[1]]; if (a===undefined || b===undefined) return undefined; for (let d=a; ; d=(d+1)%7) { out.add(d); if (d===b) break; } }
    else { const d = DAY_WORDS[part]; if (d===undefined) return undefined; out.add(d); }
  }
  return [...out].sort();
}
// "9", "9.00", "09:00", "13.30" → "HH:MM"
function parseTime(text:string):string|undefined {
  const m = text.trim().match(/^(\d{1,2})(?:[:.](\d{2}))?(?:\s*น\.?)?$/); if (!m) return undefined;
  const h = Number(m[1]), mi = Number(m[2] ?? 0); if (h>23 || mi>59) return undefined;
  return `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}`;
}
// Split pasted cells (tab) or CSV (comma, with "quoted, values").
function splitLine(line:string):string[] {
  if (line.includes('\t')) return line.split('\t').map(x=>x.trim());
  const out:string[] = []; let cur = '', q = false;
  for (let i=0; i<line.length; i++) { const c = line[i];
    if (q) { if (c==='"' && line[i+1]==='"') { cur += '"'; i++; } else if (c==='"') q = false; else cur += c; }
    else if (c==='"') q = true; else if (c===',') { out.push(cur.trim()); cur = ''; } else cur += c; }
  out.push(cur.trim()); return out;
}
function parse(text:string, clinics:Clinic[]):Row[] {
  const lines = text.replace(/^﻿/,'').split(/\r?\n/);
  const rows:Row[] = [];
  lines.forEach((raw,i)=>{
    if (!raw.trim()) return;
    const [code='',name='',clinicText='',daysText='',startText='',endText='',roomText=''] = splitLine(raw);
    if (i===0 && /รหัส|code/i.test(code)) return; // header
    const row:Row = {line:i+1,code:code.trim(),name:name.trim()};
    const ct = clinicText.trim().toLowerCase();
    row.clinic = clinics.find(c=>c.letter.toLowerCase()===ct || c.key.toLowerCase()===ct || c.dept.toLowerCase()===ct) ?? (ct ? clinics.find(c=>c.dept.toLowerCase().includes(ct)) : undefined);
    const err = (e:string) => { if (!row.error) row.error = e; };
    if (!row.code) err('ไม่มีรหัสแพทย์'); else if (!/^[A-Za-z0-9ก-๙._-]{1,20}$/.test(row.code)) err('รหัสแพทย์ใช้ตัวอักษร ตัวเลข . _ - ไม่เกิน 20 ตัว');
    if (!row.name) err('ไม่มีชื่อแพทย์');
    if (!row.clinic) err(clinicText ? `ไม่พบคลินิก "${clinicText}" หรือยังไม่เปิดให้นัด` : 'ไม่มีคลินิก');
    if (daysText || startText || endText) {
      row.days = parseDays(daysText); row.start = parseTime(startText); row.end = parseTime(endText);
      if (!row.days?.length) err(`อ่านวันไม่ออก "${daysText}" (เช่น จ-ศ, จ อ พ, จันทร์)`);
      if (!row.start || !row.end) err('เวลาใช้รูปแบบ 09:00 หรือ 9.00'); else if (row.end<=row.start) err('เวลาเลิกต้องหลังเวลาเริ่ม');
      if (roomText && row.clinic) { const rt = roomText.trim().toLowerCase(), room = row.clinic.rooms.find(r=>String(r.number)===rt || r.id.toLowerCase()===rt || r.name.toLowerCase().includes(rt));
        if (room) row.roomId = room.id; else err(`ไม่พบห้อง "${roomText}" ใน${row.clinic.dept}`); }
    }
    rows.push(row);
  });
  return rows;
}
// The demo duty roster (what the 3D map shows, made-up names): each clinic exam room's sessions, Monday–Friday.
function rosterText(clinics:Clinic[]):string {
  const hh = (h:number) => h>=24 ? '23:59' : `${String(h).padStart(2,'0')}:00`;
  const lines = [HEAD.join('\t')];
  for (const c of clinics) for (const room of c.rooms) roomShifts(room).forEach((s,k)=>{
    lines.push([`DEMO-${room.number}-${k+1}`,doctorName(s.doctor,true),c.dept,'จ-ศ',hh(s.from),hh(s.to),String(room.number)].join('\t')); });
  return lines.join('\n');
}
const TEMPLATE = [HEAD,['ว.12345','นพ.สมชาย ใจดี','อายุรกรรมทั่วไป','จ-ศ','09:00','12:00','201'],['ว.12345','นพ.สมชาย ใจดี','อายุรกรรมทั่วไป','พ','13:00','16:00','201'],
  ['ว.67890','พญ.สมศรี รักษา','ตา','อ พฤ','09:00','12:00',''],['ว.24680','นพ.ยังไม่มีตาราง','ศัลยกรรม','','','','']];

export function DoctorImport({api,clinics,onClose,onDone}:{api:Api; clinics:Clinic[]; onClose:()=>void; onDone:(text:string)=>void}) {
  const [text,setText] = useState('');
  const [from,setFrom] = useState(()=>addDays(today(),1));
  const [to,setTo] = useState(()=>addDays(today(),27));
  const [minutes,setMinutes] = useState(15);
  const [capacity,setCapacity] = useState(2);
  const [busy,setBusy] = useState<''|'check'|'import'>('');
  const [checked,setChecked] = useState<{sig:string; result:Result}|null>(null);
  const [error,setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  useEffect(()=>{ const k = (e:KeyboardEvent)=>{ if (e.key==='Escape' && !busy) onClose(); }; window.addEventListener('keydown',k); return ()=>window.removeEventListener('keydown',k); },[onClose,busy]);
  const rows = useMemo(()=>parse(text,clinics),[text,clinics]);
  const bad = rows.filter(r=>r.error), doctors = new Set(rows.map(r=>r.code)).size;
  const payload = {rows:rows.map(r=>({code:r.code,name:r.name,clinic:r.clinic?.key,...(r.days ? {weekdays:r.days,start:r.start,end:r.end} : {}),...(r.roomId ? {roomId:r.roomId} : {})})),from,to,minutes,capacity};
  const sig = JSON.stringify(payload), ready = checked?.sig===sig;
  const run = async (dryRun:boolean) => {
    setBusy(dryRun ? 'check' : 'import'); setError('');
    const r = await api<{ok:boolean; reason?:string; result?:Result}>('appt:import',{...payload,dryRun});
    setBusy('');
    if (!r.ok || !r.result) { setError(r.reason ?? 'ไม่สำเร็จ'); setChecked(null); return; }
    if (dryRun) setChecked({sig,result:r.result});
    else onDone(`นำเข้าแล้ว: แพทย์ ${r.result.doctors} คน (ใหม่ ${r.result.added}) · ตาราง ${r.result.sessions} ครั้งออกตรวจ (${r.result.slots} ช่วงนัด)${r.result.conflicts.length ? ` · ข้าม ${r.result.conflicts.length} วันที่ซ้อนเวลา` : ''}`);
  };
  const download = () => { const csv = '﻿'+TEMPLATE.map(r=>r.map(c=>/[",]/.test(c) ? `"${c.replace(/"/g,'""')}"` : c).join(',')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})); a.download = 'doctor-schedule-template.csv'; a.click(); URL.revokeObjectURL(a.href); };
  const res = checked?.result;
  return <ModalPortal><div className="modalBack" onClick={()=>{ if (!busy) onClose(); }}><div className="moveDialog facDialog wide docImport" role="dialog" aria-modal="true" aria-label="นำเข้าแพทย์และตารางออกตรวจ" onClick={e=>e.stopPropagation()}>
    <header><div><h3>นำเข้าแพทย์และตารางออกตรวจ</h3><small className="muted">วางจาก Excel / Google Sheets หรือเลือกไฟล์ .csv · หนึ่งแถว = แพทย์ + คลินิก + วันและเวลาออกตรวจทุกสัปดาห์ (ไม่ใส่วัน = เพิ่มแค่รายชื่อ)</small></div>
      <button className="iconBtn" aria-label="ปิด" onClick={onClose} disabled={!!busy}><X size={18}/></button></header>
    <div className="facDialogBody">
      <div className="impTools">
        <button className="btn ghost sm" onClick={download}><Download size={14}/> ไฟล์ตัวอย่าง (.csv)</button>
        <input ref={file} type="file" accept=".csv,text/csv,text/plain" hidden onChange={async e=>{ const f = e.target.files?.[0]; if (f) setText(await f.text()); if (file.current) file.current.value = ''; }}/>
        <button className="btn ghost sm" onClick={()=>file.current?.click()}><FileUp size={14}/> เลือกไฟล์ .csv</button>
        <button className="btn ghost sm" onClick={()=>setText(rosterText(clinics))} title="ตารางเวรที่แผนที่ 3D ใช้อยู่ — ชื่อแพทย์สมมติ แก้หรือลบได้ก่อนนำเข้า"><Wand2 size={14}/> ใช้ตารางเวรตัวอย่าง (ชื่อสมมติ)</button>
      </div>
      <textarea className="impText" value={text} onChange={e=>setText(e.target.value)} spellCheck={false}
        placeholder={`วางข้อมูลที่นี่ — คอลัมน์ตามลำดับ:\n${HEAD.join(' | ')}\n\nตัวอย่าง: ว.12345 | นพ.สมชาย ใจดี | อายุรกรรมทั่วไป | จ-ศ | 09:00 | 12:00 | 201`}/>
      {rows.length>0 && <div className="impPreview">
        <div className="impCount"><b>{rows.length} แถว · แพทย์ {doctors} คน</b>{bad.length ? <span className="facErr"> · ต้องแก้ {bad.length} แถว</span> : <span className="docOn"> · ข้อมูลอ่านได้ครบ</span>}</div>
        <div className="tableWrap"><table className="dataTable impTable"><thead><tr><th>แถว</th><th>แพทย์</th><th>คลินิก</th><th>วันและเวลา</th><th>ห้อง</th><th></th></tr></thead>
          <tbody>{[...bad,...rows.filter(r=>!r.error)].slice(0,80).map(r=><tr key={r.line} className={r.error?'bad':''}><td>{r.line}</td><td><b>{r.name || '—'}</b> <small className="muted">{r.code}</small></td>
            <td>{r.clinic ? `${r.clinic.letter} · ${r.clinic.dept}` : '—'}</td><td>{r.days ? `${r.days.map(d=>DAY_SHORT[d]).join(' ')} ${r.start ?? '?'}–${r.end ?? '?'}` : <span className="muted">เพิ่มแค่รายชื่อ</span>}</td>
            <td>{r.roomId ? clinics.flatMap(c=>c.rooms).find(x=>x.id===r.roomId)?.name : <span className="muted">—</span>}</td><td>{r.error && <span className="facErr">{r.error}</span>}</td></tr>)}</tbody></table></div>
        {rows.length>80 && <small className="muted">แสดง 80 แถวแรก (แถวที่ต้องแก้ขึ้นก่อน)</small>}
      </div>}
      <div className="impOpts">
        <span>สร้างตารางตั้งแต่</span><DatePicker value={from} min={today()} onChange={setFrom} aria-label="ตั้งแต่วันที่"/><span>ถึง</span><DatePicker value={to} min={from} onChange={setTo} aria-label="ถึงวันที่"/>
        <span>ช่วงนัดละ</span><span className="impSel"><Select value={minutes} onChange={setMinutes} options={[10,15,20,30,60].map(m=>({value:m,label:`${m} นาที`}))} aria-label="ความยาวช่วงนัด"/></span>
        <span>รับช่วงละ</span><input type="number" min={1} max={100} value={capacity} onChange={e=>setCapacity(Math.max(1,Math.min(100,Number(e.target.value)||1)))} aria-label="จำนวนคนต่อช่วง"/><span>คน</span>
      </div>
      {error && <p className="loginError" role="alert">{error}</p>}
      {res && ready && <div className="impResult"><CheckCircle2 size={18}/><div><b>ตรวจกับระบบแล้ว — ถ้านำเข้าจะได้:</b>
        <span>แพทย์ {res.doctors} คน (ใหม่ {res.added} · มีอยู่แล้ว {res.doctors-res.added}) · ตาราง {res.sessions} ครั้งออกตรวจ ({dayOf(from)} – {dayOf(to)}) · {res.slots} ช่วงนัด{res.skipped ? ` · มีอยู่แล้ว ${res.skipped} ครั้ง (ข้าม)` : ''}</span>
        {res.conflicts.length>0 && <span className="facErr">ข้าม {res.conflicts.length} วันที่แพทย์มีตารางซ้อนเวลา: {res.conflicts.slice(0,6).map(c=>`${c.name} ${dayOf(c.day)}`).join(', ')}{res.conflicts.length>6 ? ' …' : ''}</span>}</div></div>}
    </div>
    <footer>
      {!busy && <small className="pickHint">{!rows.length ? 'วางข้อมูล เลือกไฟล์ หรือใช้ตารางเวรตัวอย่าง' : bad.length ? `แก้ ${bad.length} แถวที่มีปัญหาก่อน` : !ready ? 'กด "ตรวจสอบ" เพื่อดูว่าจะได้อะไร' : ''}</small>}
      <button className="btn ghost" onClick={onClose} disabled={!!busy}>ยกเลิก</button>
      <button className="btn ghost" disabled={!!busy || !rows.length || bad.length>0 || ready} onClick={()=>void run(true)}>{busy==='check' && <Loader2 size={15} className="spin"/>}{busy==='check' ? 'กำลังตรวจ…' : 'ตรวจสอบ'}</button>
      <button className="btn" disabled={!!busy || !ready} onClick={()=>void run(false)}>{busy==='import' && <Loader2 size={15} className="spin"/>}{busy==='import' ? 'กำลังนำเข้า…' : 'นำเข้า'}</button>
    </footer>
  </div></div></ModalPortal>;
}
