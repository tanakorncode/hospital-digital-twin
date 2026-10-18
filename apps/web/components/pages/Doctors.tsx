'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, FileUp, Loader2, Plus, Stethoscope, UserRound } from 'lucide-react';
import { SearchBox } from '../SearchBox';
import { ClinicPicker } from '../ClinicPicker';
import { DoctorImport } from './DoctorImport';
import { opdClinics, type Clinic } from '../../lib/patients';
import type { QueueSync } from '../../lib/queue';
import { SessionPlanner, usePolicies, type MadeSession, type Provider } from './Appointments';
import { dayOf, timeOf } from './Booking';
import { Switch } from '../Switch';

// Settings → รายชื่อแพทย์: the doctors who see patients by appointment. The list (search, what each has coming), a
// doctor's page (name, code, clinics, on / off; their sessions to come) and, from there, the doctor's schedule — the
// same form as before, already set to this doctor. A doctor switched off keeps the sessions made; no new ones.
type Api = QueueSync['api'];
type Session = MadeSession;
const clinicLabel = (all:Clinic[], key:string) => { const c = all.find(x=>x.key===key); return c ? `${c.letter} · ${c.dept}` : key; };

export function DoctorsPane({api,rev}:{api:Api; rev:number}) {
  const clinics = useMemo(()=>opdClinics(),[]);
  const {policies} = usePolicies(api,rev);
  const ready = clinics.filter(c=>policies.some(p=>p.clinicCode===c.key && p.enabled)); // clinics open for appointments
  const [list,setList] = useState<Provider[]|null>(null);
  const [q,setQ] = useState('');
  const [open,setOpen] = useState<string|null>(null); // a doctor's code, or '' for a new one
  const [msg,setMsg] = useState<{text:string; bad?:boolean}|null>(null);
  const [importing,setImporting] = useState(false);
  useEffect(()=>{ if (!msg) return; const t = setTimeout(()=>setMsg(null),8000); return ()=>clearTimeout(t); },[msg]);
  const load = useCallback(async ()=>{ const r = await api<{ok:boolean; providers?:Provider[]}>('appt:providers',{}); setList(r.ok ? r.providers ?? [] : []); },[api]);
  useEffect(()=>{ void load(); },[load,rev]);
  const needle = q.trim().toLowerCase();
  const shown = (list ?? []).filter(p=>!needle || p.name.toLowerCase().includes(needle) || p.code.toLowerCase().includes(needle) || p.clinics.some(c=>clinicLabel(clinics,c).toLowerCase().includes(needle)));
  const doc = open ? list?.find(p=>p.code===open) : undefined;
  if (open!==null && (open==='' || doc)) return <section className="setCard docPane">
    <button className="linkBtn dark docBack" onClick={()=>setOpen(null)}><ArrowLeft size={15}/> รายชื่อแพทย์</button>
    {msg && <p className={'setToast'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}
    <DoctorPage key={open} api={api} clinics={clinics} ready={ready} doc={doc} onSaved={(p,text)=>{ setMsg({text}); void load(); setOpen(p.code); }} onError={text=>setMsg({text,bad:true})} reload={load}/>
  </section>;
  return <section className="setCard docPane">
    <div className="docHead"><div><h3><Stethoscope size={18}/> รายชื่อแพทย์</h3><small className="muted">แพทย์ที่ออกตรวจแบบนัด · คลิกชื่อเพื่อแก้ข้อมูลและสร้างตารางออกตรวจ</small></div>
      <span className="docActs"><button className="btn ghost" onClick={()=>setImporting(true)} disabled={!ready.length} title={ready.length ? 'นำเข้าแพทย์และตารางจาก Excel / CSV' : 'เปิดคลินิกให้นัดที่ ตั้งค่า → นัดแพทย์ ก่อน'}><FileUp size={15}/> นำเข้า</button>
        <button className="btn" onClick={()=>setOpen('')}><Plus size={15}/> เพิ่มแพทย์</button></span></div>
    {importing && <DoctorImport api={api} clinics={ready} onClose={()=>setImporting(false)} onDone={text=>{ setImporting(false); setMsg({text}); void load(); }}/>}
    {msg && <p className={'setToast'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}
    <SearchBox value={q} onChange={setQ} placeholder="ค้นหาชื่อ รหัส หรือคลินิก" label="ค้นหาแพทย์"/>
    {list===null ? <p className="cmdNote"><Loader2 size={14} className="spin"/> กำลังโหลด…</p>
      : !list.length ? <div className="docEmpty"><UserRound size={28}/><b>ยังไม่มีรายชื่อแพทย์</b><span>กด "เพิ่มแพทย์" ทีละคน หรือ "นำเข้า" จาก Excel / CSV (มีตารางเวรตัวอย่างให้เริ่มได้ทันที)</span></div>
      : <div className="tableWrap"><table className="dataTable docTable"><thead><tr><th>แพทย์</th><th>คลินิก</th><th>ตารางที่จะถึง</th><th>สถานะ</th></tr></thead>
        <tbody>{shown.map(p=><tr key={p.code} className={p.active?'':'muted'} onClick={()=>setOpen(p.code)} tabIndex={0} onKeyDown={e=>{ if (e.key==='Enter') setOpen(p.code); }}>
          <td><b>{p.name}</b><small className="muted"> {p.code}</small></td>
          <td>{p.clinics.length ? p.clinics.map(c=>clinicLabel(clinics,c)).join(', ') : <span className="muted">—</span>}</td>
          <td>{p.upcoming ? <>{p.upcoming} ครั้ง <small className="muted">· ถัดไป {dayOf(p.nextAt!)} {timeOf(p.nextAt!)}</small></> : <span className="docNone">ยังไม่มีตาราง</span>}</td>
          <td>{p.active ? <span className="docOn">ใช้งาน</span> : <span className="muted">ปิดใช้งาน</span>}</td></tr>)}
          {!shown.length && <tr><td colSpan={4} className="muted">ไม่พบแพทย์ที่ตรงกับ "{q}"</td></tr>}</tbody></table></div>}
  </section>;
}

function DoctorPage({api,clinics,ready,doc,onSaved,onError,reload}:{api:Api; clinics:Clinic[]; ready:Clinic[]; doc?:Provider; onSaved:(p:Provider, text:string)=>void; onError:(t:string)=>void; reload:()=>Promise<void>}) {
  const [code,setCode] = useState(doc?.code ?? '');
  const [name,setName] = useState(doc?.name ?? '');
  const [mine,setMine] = useState<string[]>(doc?.clinics ?? []);
  const [note,setNote] = useState(doc?.note ?? '');
  const [active,setActive] = useState(doc?.active ?? true);
  const [busy,setBusy] = useState(false);
  const [sessions,setSessions] = useState<Session[]|null>(null);
  const loadSessions = useCallback(async ()=>{ if (!doc) return; const r = await api<{ok:boolean; sessions?:Session[]}>('appt:provider:sessions',{code:doc.code}); setSessions(r.ok ? r.sessions ?? [] : []); },[api,doc]);
  useEffect(()=>{ void loadSessions(); },[loadSessions]);
  const changed = !doc || name.trim()!==doc.name || code.trim()!==doc.code || note.trim()!==(doc.note ?? '') || active!==doc.active || [...mine].sort().join()!==[...doc.clinics].sort().join();
  const missing = !name.trim() ? 'กรอกชื่อแพทย์' : !code.trim() ? 'กรอกรหัสแพทย์' : !/^[A-Za-z0-9ก-๙._-]{1,20}$/.test(code.trim()) ? 'รหัสใช้ตัวอักษร ตัวเลข . _ - ไม่เกิน 20 ตัว (ไม่มีช่องว่าง)' : '';
  const save = async () => {
    setBusy(true);
    const r = await api<{ok:boolean; reason?:string; provider?:Provider}>('appt:provider:set',{code:code.trim(),name:name.trim(),clinics:mine,note:note.trim(),active});
    setBusy(false);
    if (r.ok && r.provider) onSaved(r.provider,doc ? `บันทึกข้อมูล ${r.provider.name} แล้ว` : `เพิ่ม ${r.provider.name} แล้ว · สร้างตารางออกตรวจได้ด้านล่าง`); else onError(r.reason ?? 'บันทึกไม่สำเร็จ');
  };
  return <>
    <div className="docHead"><div><h3><UserRound size={18}/> {doc ? doc.name : 'เพิ่มแพทย์'}</h3>{doc && <small className="muted">รหัส {doc.code}{doc.active ? '' : ' · ปิดใช้งาน'}</small>}</div>
      {doc && <Switch value={active} onChange={setActive} label="ใช้งานแพทย์ท่านนี้" text={['ใช้งาน','ปิดใช้งาน']}/>}</div>
    <div className="docForm">
      <label>ชื่อแพทย์<input value={name} maxLength={60} placeholder="เช่น นพ.สมชาย ใจดี" onChange={e=>setName(e.target.value)} autoFocus={!doc}/></label>
      <label><span>รหัสแพทย์ <em>{doc ? '(เปลี่ยนไม่ได้)' : '(เลข ว. หรือรหัสใน HIS)'}</em></span><input value={code} maxLength={20} disabled={!!doc} placeholder="เช่น ว.12345" onChange={e=>setCode(e.target.value)}/></label>
      <label className="wide">หมายเหตุ <input value={note} maxLength={200} placeholder="เช่น สาขาเฉพาะทาง วันลาประจำ" onChange={e=>setNote(e.target.value)}/></label>
      <div className="wide"><span className="docLabel">คลินิกที่ออกตรวจ</span><ClinicPicker clinics={clinics} value={mine} onChange={setMine}/></div>
    </div>
    <div className="docSave">{!active && doc && <small className="muted">ปิดใช้งาน: ตารางที่สร้างไว้ยังอยู่ แต่สร้างตารางใหม่ไม่ได้</small>}
      {missing && <span className="pickHint">{missing}</span>}
      <button className="btn" disabled={busy || !!missing || !changed} onClick={()=>void save()}>{busy && <Loader2 size={15} className="spin"/>}{busy ? 'กำลังบันทึก…' : doc ? 'บันทึกข้อมูลแพทย์' : 'เพิ่มแพทย์'}</button></div>
    {doc && <>
      {!doc.active ? <p className="serviceNote">แพทย์ท่านนี้ปิดใช้งานอยู่ — เปิดใช้งานแล้วบันทึก จึงจะสร้างตารางใหม่ได้</p>
        : !ready.length ? <p className="serviceNote">ยังไม่มีคลินิกที่เปิดให้นัด — เปิดคลินิกที่ ตั้งค่า → นัดแพทย์ ก่อน แล้วจึงสร้างตารางออกตรวจ</p>
        : <SessionPlanner api={api} clinics={ready} fixed={doc} existing={sessions ?? []} say={()=>{}} onMade={()=>{ void loadSessions(); void reload(); }}/>}
    </>}
  </>;
}
