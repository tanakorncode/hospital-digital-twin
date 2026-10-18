'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, Check, Copy, Download, KeyRound, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { ConfirmDialog, type Confirm } from './ConfirmDialog';
import { directoryPlaces } from '../../lib/wayfinding';
import type { QueueSync } from '../../lib/queue';
import { Select } from '../Select';
import { DatePicker } from '../DatePicker';

// Settings → ตู้ต้อนรับ (administrators): the Digital Reception kiosks (/reception), what they may say, and how they are
// used. Release A — no LLM: a kiosk answers only with what is approved here, places from QR นำทาง, and the OPD hours.
type Api = QueueSync['api'];
type Kiosk = {id:string; name:string; atCode?:string; status:'ACTIVE'|'REVOKED'; createdAt:string; rotatedAt?:string; lastSeenAt?:string};
type Topic = 'faq'|'steps'|'hours'|'emergency';
type Answer = {id:string; topic:Topic; questionTh:string; keywords:string[]; answerTh:string; destinationCode?:string; owner:string; status:'DRAFT'|'APPROVED'|'RETIRED';
 version:number; effectiveFrom?:string; effectiveUntil?:string; approvedAt?:string};
type Place = {code:string; nameTh:string; status:string};
type Usage = {kioskId:string; event:string; intent:string; count:number};
const topicText:Record<Topic,string> = {faq:'คำถามทั่วไป',steps:'ขั้นตอนรับบริการ',hours:'เวลาทำการ',emergency:'ข้อความกรณีฉุกเฉิน'};
const intentText:Record<string,string> = {wayfinding:'ถามทาง',answer:'ตอบจากคำตอบที่อนุมัติ',choose:'ให้เลือกเรื่อง',hours:'เวลาทำการ',directory:'เปิดรายชื่อจุดบริการ',staff:'ขอติดต่อเจ้าหน้าที่',
 clinical:'คำถามทางการแพทย์ (ส่งต่อ)',personal:'ขอข้อมูลส่วนตัว (ส่งต่อ)',emergency:'เหตุฉุกเฉิน',queue_info:'ข้อมูลคิว (ยังไม่เปิด)',unknown:'ตอบไม่ได้ (ให้เลือกเมนู)'};
const when = (iso?:string) => iso ? new Date(iso).toLocaleString('th-TH',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
const blank = {topic:'faq' as Topic,questionTh:'',keywords:'',answerTh:'',owner:'',destinationCode:'',effectiveFrom:'',effectiveUntil:''};

export function ReceptionAdminPane({api,on,setFeature}:{api:Api; on:boolean; setFeature:(on:boolean)=>Promise<void>}) {
 const [kiosks,setKiosks] = useState<Kiosk[]>([]);
 const [answers,setAnswers] = useState<Answer[]>([]);
 const [places,setPlaces] = useState<Place[]>([]);
 const [usage,setUsage] = useState<Usage[]>([]);
 const [queue,setQueue] = useState<{queueInfo:boolean; myQueue:boolean}>({queueInfo:false,myQueue:false});
 const [msg,setMsg] = useState<{text:string; bad?:boolean}|null>(null);
 const [secret,setSecret] = useState<{name:string; credential:string}|null>(null);
 const [newKiosk,setNewKiosk] = useState({name:'',atCode:''});
 const [edit,setEdit] = useState<(typeof blank & {id?:string})|null>(null);
 const [confirm,setConfirm] = useState<Confirm|null>(null);
 const say = (r:{ok:boolean; reason?:string}, ok:string) => setMsg(r.ok ? {text:ok} : {text:r.reason ?? 'บันทึกไม่สำเร็จ',bad:true});
 const load = useCallback(async ()=>{
  const [k,a,p,u] = await Promise.all([api<{ok:boolean; kiosks?:Kiosk[]; settings?:{queueInfo:boolean; myQueue:boolean}}>('reception:kiosks',{}),api<{ok:boolean; answers?:Answer[]}>('reception:answers',{}),
   api<{ok:boolean; destinations?:Place[]}>('wayfinding:list',{}),api<{ok:boolean; rows?:Usage[]}>('reception:usage',{days:30})]);
  if (k.ok) { setKiosks(k.kiosks ?? []); if (k.settings) setQueue(k.settings); } if (a.ok) setAnswers(a.answers ?? []); if (p.ok) setPlaces((p.destinations ?? []).filter(x=>x.status==='ACTIVE')); if (u.ok) setUsage(u.rows ?? []);
 },[api]);
 useEffect(()=>{ void load(); },[load]);
 const placeName = (code?:string) => places.find(p=>p.code===code)?.nameTh ?? code ?? '—';

 const addKiosk = async () => {
  const r = await api<{ok:boolean; reason?:string; credential?:string}>('reception:kiosk:save',{name:newKiosk.name,atCode:newKiosk.atCode || undefined});
  say(r,`ลงทะเบียน ${newKiosk.name} แล้ว`);
  if (r.ok && r.credential) { setSecret({name:newKiosk.name,credential:r.credential}); setNewKiosk({name:'',atCode:''}); void load(); }
 };
 // The same import as Settings → QR นำทาง: every department / service point on the layout becomes a public place.
 const importPlaces = async () => { const r = await api<{ok:boolean; reason?:string; added?:number}>('wayfinding:import',{list:directoryPlaces()});
  say(r,`นำเข้าจุดหมาย ${r.added ?? 0} จุดแล้ว · แก้ชื่อ/จุดสังเกต/พิมพ์ป้าย QR ได้ที่ ตั้งค่า → QR นำทาง`); void load(); };
 const rotate = async (k:Kiosk) => { const r = await api<{ok:boolean; reason?:string; credential?:string}>('reception:kiosk:rotate',{id:k.id}); say(r,`ออกรหัสใหม่ให้ ${k.name} แล้ว — รหัสเดิมใช้ไม่ได้ทันที`); if (r.ok && r.credential) setSecret({name:k.name,credential:r.credential}); void load(); };
 const revoke = async (k:Kiosk) => { const r = await api('reception:kiosk:revoke',{id:k.id}); say(r,`ยกเลิก ${k.name} แล้ว — ตู้หยุดใช้งานทันที`); void load(); };
 const saveAnswer = async () => {
  if (!edit) return;
  const r = await api('reception:answer:save',{...edit,keywords:edit.keywords,destinationCode:edit.destinationCode || undefined,effectiveFrom:edit.effectiveFrom || undefined,effectiveUntil:edit.effectiveUntil || undefined});
  say(r,'บันทึกเป็นร่างแล้ว — กด "อนุมัติ" เพื่อให้ตู้ใช้คำตอบนี้'); if (r.ok) { setEdit(null); void load(); }
 };
 const approve = async (a:Answer) => { const r = await api('reception:answer:approve',{id:a.id}); say(r,`อนุมัติ "${a.questionTh}" แล้ว — ตู้เริ่มใช้ทันที`); void load(); };
 const retire = async (a:Answer) => { const r = await api('reception:answer:retire',{id:a.id}); say(r,`เลิกใช้ "${a.questionTh}" แล้ว`); void load(); };
 const setQueueOpt = async (patch:Partial<typeof queue>) => {
  const r = await api<{ok:boolean; reason?:string; settings?:typeof queue}>('reception:settings:set',{patch});
  say(r,'บันทึกแล้ว · ตู้ที่เปิดอยู่เห็นผลเมื่อเริ่มใช้งานครั้งถัดไป'); if (r.ok && r.settings) setQueue(r.settings);
 };
 const totals = useMemo(()=>{
  const sum = (event:string, intent?:string) => usage.filter(u=>u.event===event && (intent===undefined || u.intent===intent)).reduce((a,u)=>a+u.count,0);
  const byIntent = [...new Set(usage.filter(u=>u.event==='turn').map(u=>u.intent))].map(i=>[i,sum('turn',i)] as [string,number]).sort((a,b)=>b[1]-a[1]);
  return {sessions:sum('session_started'),turns:sum('turn'),help:sum('help_requested'),unknown:sum('turn','unknown'),byIntent};
 },[usage]);

 return <section className="setCard bookAdmin">
  <div className={'bookSwitch'+(on?' on':'')}><div><b>ตู้ต้อนรับดิจิทัล {on?'เปิดใช้งาน':'ปิดอยู่'}</b>
   <small>เปิดที่เครื่องตู้: <code>/reception</code> · แตะเมนู ค้นหาจุดบริการ พิมพ์คำถาม เรียกเจ้าหน้าที่ · ไม่ใช้ AI ไม่ใช้กล้อง ไม่บันทึกข้อความที่พิมพ์ · ตอบได้เฉพาะคำตอบที่อนุมัติด้านล่าง</small></div>
   <button className={on?'btn ghost':'btn'} onClick={()=>void setFeature(!on)}>{on?'ปิดตู้ทั้งหมด':'เปิดใช้งาน'}</button></div>
  {msg && <p className={'setToast'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}

  <h4 className="setSub">ข้อมูลคิวบนตู้ <small>ไม่แสดงชื่อ HN หรือข้อมูลการรักษาในทุกกรณี</small></h4>
  <div className="rcpQueueOpts">
   <label className="switch"><input type="checkbox" checked={queue.queueInfo} onChange={e=>void setQueueOpt({queueInfo:e.target.checked})}/><span/>
    <div><b>ภาพรวมคิว</b><small>จำนวนคนรอและหมายเลขที่กำลังเรียก ของทุกแผนก/จุดบริการ — ข้อมูลเดียวกับจอเรียกคิว</small></div></label>
   <label className="switch"><input type="checkbox" checked={queue.myQueue} onChange={e=>void setQueueOpt({myQueue:e.target.checked})}/><span/>
    <div><b>คิวของฉัน</b><small>ผู้ป่วยสแกน QR บนบัตรคิวที่เครื่องอ่านของตู้ → เลขคิว สิ่งที่ต้องทำ คิวก่อนหน้า เวลารอ · แสดงบนจอ 30 วินาที ไม่อ่านออกเสียง · พิมพ์เลขคิวเองไม่ได้ (กันดูคิวคนอื่น)</small></div></label>
  </div>

  <h4 className="setSub">ตู้ <small>ง่ายที่สุด: เปิด <code>/reception</code> ที่ตัวตู้ → เข้าสู่ระบบผู้ดูแล → เลือกตู้จากรายชื่อ (หรือเพิ่มตู้ใหม่) ไม่ต้องคัดลอกรหัส · ตู้ใช้รหัสประจำเครื่อง ไม่จำบัญชีเจ้าหน้าที่ · ตู้หาย/ย้ายเครื่อง: ออกรหัสใหม่หรือยกเลิก</small></h4>
  {secret && <div className="rcpSecret"><b>รหัสของ {secret.name}</b><code>{secret.credential}</code>
   <small>นำไปวางที่หน้าตั้งค่าของตู้ (<code>/reception</code> → "มีรหัสตู้อยู่แล้ว") · หรือไม่ต้องใช้รหัสนี้: ที่ตัวตู้เข้าสู่ระบบผู้ดูแลแล้วเลือกตู้นี้ · จะไม่แสดงอีก — ถ้าหาย ให้กด "ออกรหัสใหม่"</small>
   <span className="segBtns"><button onClick={()=>void navigator.clipboard?.writeText(secret.credential)}><Copy size={14}/> คัดลอก</button><button onClick={()=>setSecret(null)}><Check size={14}/> เก็บแล้ว</button></span></div>}
  {kiosks.length>0 && <div className="tableWrap"><table className="dataTable compact"><thead><tr><th>ตู้</th><th>ตั้งอยู่ที่</th><th>ใช้งานล่าสุด</th><th>สถานะ</th><th/></tr></thead>
   <tbody>{kiosks.map(k=><tr key={k.id} className={k.status==='REVOKED'?'muted':''}><td><b>{k.name}</b> <small className="muted">{k.id}</small></td><td>{placeName(k.atCode)}</td><td>{when(k.lastSeenAt)}</td>
    <td>{k.status==='ACTIVE'?'ใช้งาน':'ยกเลิกแล้ว'}</td>
    <td>{k.status==='ACTIVE' && <span className="rowActs">
     <button className="iconBtn" title="ออกรหัสใหม่" aria-label={`ออกรหัสใหม่ให้ ${k.name}`} onClick={()=>setConfirm({title:`ออกรหัสใหม่ให้ "${k.name}"?`,detail:k.id,action:'ออกรหัสใหม่',
      facts:['รหัสเดิมใช้ไม่ได้ทันที — ตู้ที่เปิดอยู่จะกลับไปหน้าตั้งค่ารหัส','รหัสใหม่แสดงครั้งเดียว ให้คัดลอกไปวางที่ตู้'],run:()=>rotate(k)})}><KeyRound size={14}/></button>
     <button className="iconBtn danger" title="ยกเลิกตู้" aria-label={`ยกเลิก ${k.name}`} onClick={()=>setConfirm({title:`ยกเลิก "${k.name}"?`,detail:k.id,action:'ยกเลิกตู้',danger:true,
      facts:['ตู้หยุดใช้งานทันที ผู้ใช้ที่ตู้จะเห็นว่ายังไม่ได้ลงทะเบียน','ใช้กับตู้ที่หาย ย้ายเครื่อง หรือเลิกใช้ — กลับมาใช้รหัสเดิมไม่ได้ ต้องลงทะเบียนใหม่'],run:()=>revoke(k)})}><Ban size={14}/></button></span>}</td></tr>)}
   </tbody></table></div>}
  <form className="rcpEdit rcpNewKiosk" onSubmit={e=>{ e.preventDefault(); if (newKiosk.name.trim()) void addKiosk(); }}>
   <label className="wide">ชื่อตู้<input value={newKiosk.name} maxLength={60} placeholder="เช่น ตู้ล็อบบี้ OPD ชั้น 1" onChange={e=>setNewKiosk({...newKiosk,name:e.target.value})}/></label>
   <label>ตั้งอยู่ที่ (เส้นทางเริ่มจากจุดนี้)<Select value={newKiosk.atCode} onChange={v=>setNewKiosk({...newKiosk,atCode:v})} options={[{value:'',label:'ไม่ระบุ — เริ่มจากทางเข้าหลัก'},...places.map(p=>({value:p.code,label:p.nameTh,sub:p.code}))]}/></label>
   <button className="btn" disabled={!newKiosk.name.trim()}><Plus size={16}/> ลงทะเบียนตู้</button>
  </form>
  {!places.length && <div className="rcpHint"><span>ยังไม่มีจุดหมายนำทาง — ตู้จะตอบ "…อยู่ไหน" และบอกเส้นทางได้เมื่อมีจุดหมาย</span>
   <button className="btn ghost" onClick={()=>void importPlaces()}><Download size={15}/> นำเข้าจุดหมายจากผังแผนก</button></div>}

  <h4 className="setSub">คำตอบที่ตู้ใช้ได้ <small>ร่าง → อนุมัติ ตู้จึงใช้ · แก้คำตอบที่อนุมัติแล้ว = เป็นร่างใหม่ ต้องอนุมัติอีกครั้ง · คำถามทางการแพทย์และข้อมูลส่วนตัว ตู้ส่งต่อเจ้าหน้าที่เสมอ</small></h4>
  <div className="segBtns"><button onClick={()=>setEdit({...blank})}><Plus size={14}/> เพิ่มคำตอบ</button><button className="iconBtn" aria-label="โหลดใหม่" onClick={()=>void load()}><RefreshCw size={14}/></button></div>
  {edit && <div className="rcpEdit">
   <label>หมวด<Select value={edit.topic as string} onChange={v=>setEdit({...edit,topic:v as Topic})} options={(Object.keys(topicText) as Topic[]).map(t=>({value:t as string,label:topicText[t]}))}/></label>
   <label className="span3">คำถาม/หัวข้อ (แสดงบนตู้)<input value={edit.questionTh} maxLength={120} placeholder="เช่น ทำบัตรผู้ป่วยใหม่ทำอย่างไร" onChange={e=>setEdit({...edit,questionTh:e.target.value})}/></label>
   <label className="full">คำค้น (คั่นด้วยจุลภาค)<input value={edit.keywords} placeholder="เช่น ทำบัตร,บัตรใหม่,ผู้ป่วยใหม่" onChange={e=>setEdit({...edit,keywords:e.target.value})}/></label>
   <label className="full">คำตอบ (ตู้แสดงและอ่านตามนี้ทุกตัวอักษร)<textarea value={edit.answerTh} maxLength={600} rows={4} onChange={e=>setEdit({...edit,answerTh:e.target.value})}/></label>
   <label>หน่วยงานเจ้าของเนื้อหา<input value={edit.owner} maxLength={60} placeholder="เช่น งานเวชระเบียน" onChange={e=>setEdit({...edit,owner:e.target.value})}/></label>
   <label>พาไปที่ (ไม่บังคับ)<Select value={edit.destinationCode} onChange={v=>setEdit({...edit,destinationCode:v})} options={[{value:'',label:'— ไม่พาไปที่ไหน'},...places.map(p=>({value:p.code,label:p.nameTh,sub:p.code}))]}/></label>
   <label>มีผลตั้งแต่<DatePicker clearable placeholder="ไม่กำหนด" value={edit.effectiveFrom} onChange={v=>setEdit({...edit,effectiveFrom:v})}/></label>
   <label>ถึง<DatePicker clearable placeholder="ไม่กำหนด" min={edit.effectiveFrom || undefined} value={edit.effectiveUntil} onChange={v=>setEdit({...edit,effectiveUntil:v})}/></label>
   <span className="segBtns full"><button className="on" onClick={()=>void saveAnswer()}>บันทึกเป็นร่าง</button><button onClick={()=>setEdit(null)}>ยกเลิก</button></span>
  </div>}
  {answers.length ? <div className="tableWrap"><table className="dataTable compact"><thead><tr><th>หมวด</th><th>คำถาม/หัวข้อ</th><th>คำตอบ</th><th>เจ้าของ</th><th>สถานะ</th><th/></tr></thead>
   <tbody>{answers.map(a=><tr key={a.id}><td>{topicText[a.topic]}</td><td><b>{a.questionTh}</b><br/><small className="muted">{a.keywords.join(', ')}</small></td>
    <td><small>{a.answerTh.length>90?`${a.answerTh.slice(0,90)}…`:a.answerTh}</small>{a.destinationCode && <small className="muted"> · พาไป {placeName(a.destinationCode)}</small>}</td><td>{a.owner}</td>
    <td>{a.status==='APPROVED' ? <span className="bookState s-CONFIRMED">อนุมัติ v{a.version}</span> : <span className="bookState s-CANCELLED">ร่าง v{a.version}</span>}
     {(a.effectiveFrom || a.effectiveUntil) && <small className="muted"> {a.effectiveFrom ?? '…'} – {a.effectiveUntil ?? '…'}</small>}</td>
    <td><span className="rowActs">{a.status==='DRAFT' && <button className="iconBtn ok" title="อนุมัติ — ตู้เริ่มใช้ทันที" aria-label={`อนุมัติ ${a.questionTh}`} onClick={()=>void approve(a)}><Check size={15}/></button>}
     <button className="iconBtn" title="แก้ไข (กลับเป็นร่าง ต้องอนุมัติใหม่)" aria-label={`แก้ไข ${a.questionTh}`} onClick={()=>setEdit({id:a.id,topic:a.topic,questionTh:a.questionTh,keywords:a.keywords.join(','),answerTh:a.answerTh,owner:a.owner,destinationCode:a.destinationCode ?? '',effectiveFrom:a.effectiveFrom ?? '',effectiveUntil:a.effectiveUntil ?? ''})}><Pencil size={14}/></button>
     <button className="iconBtn danger" title="เลิกใช้" aria-label={`เลิกใช้ ${a.questionTh}`} onClick={()=>setConfirm({title:`เลิกใช้คำตอบ "${a.questionTh}"?`,detail:`${topicText[a.topic]} · ${a.owner}`,action:'เลิกใช้คำตอบ',danger:true,
      facts:['ตู้หยุดใช้คำตอบนี้ทันที','ต้องการแก้ข้อความแทน ให้ใช้ปุ่มแก้ไข (กลับเป็นร่าง แล้วอนุมัติใหม่)'],run:()=>retire(a)})}><Trash2 size={14}/></button></span></td></tr>)}</tbody></table></div>
   : <p className="cmdNote">ยังไม่มีคำตอบ — ระหว่างนี้ตู้ตอบได้เฉพาะ "…อยู่ไหน" จาก QR นำทาง และเวลาทำการ OPD จากการตั้งค่าคิว</p>}

  <h4 className="setSub">การใช้งาน 30 วัน <small>นับจำนวนครั้งเท่านั้น ไม่มีข้อความที่ผู้ใช้พิมพ์ · "ตอบไม่ได้" สูง = ควรเพิ่มคำตอบ ก่อนพิจารณา AI</small></h4>
  <div className="tileRow small">
   <div className="tile"><small>ผู้ใช้ (ครั้ง)</small><b>{totals.sessions}</b></div>
   <div className="tile"><small>คำถาม/การแตะ</small><b>{totals.turns}</b></div>
   <div className="tile"><small>ตอบไม่ได้</small><b>{totals.turns ? `${Math.round(totals.unknown/totals.turns*100)}%` : '—'}</b><span className="muted">{totals.unknown} ครั้ง</span></div>
   <div className="tile"><small>เรียกเจ้าหน้าที่</small><b>{totals.help}</b></div>
  </div>
  {totals.byIntent.length>0 && <div className="tableWrap"><table className="dataTable compact"><thead><tr><th>ประเภท</th><th className="num">ครั้ง</th></tr></thead>
   <tbody>{totals.byIntent.map(([i,n])=><tr key={i}><td>{intentText[i] ?? i}</td><td className="num">{n}</td></tr>)}</tbody></table></div>}
 {confirm && <ConfirmDialog confirm={confirm} onClose={()=>setConfirm(null)}/>}
 </section>;
}
