'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { Download, Pencil, Plus, Printer, X } from 'lucide-react';
import { buildings, buildingStats } from '../../lib/scene-data';
import type { QueueSync } from '../../lib/queue';
import { directoryPlaces, signUrl, whereText, type Destination } from '../../lib/wayfinding';

// Settings → QR นำทาง (administrators): the places patients look for, with stable codes; QR signs to print and hang.
// A sign's QR is only this page's address and the place code — nothing else. Retire a place with where it moved to,
// so signs already on the wall keep leading somewhere useful.
type Api = QueueSync['api'];
type Draft = {code:string; nameTh:string; buildingId:string; level:number; zoneIndex?:number; landmarkTh:string; descriptionTh:string; isPublic:boolean};
const empty:Draft = {code:'',nameTh:'',buildingId:'opd',level:1,landmarkTh:'',descriptionTh:'',isPublic:true};

export function WayfindingAdminPane({api,features,setFeature}:{api:Api; features:QueueSync['features']; setFeature:(on:boolean)=>Promise<void>}) {
 const [list,setList] = useState<Destination[]>([]);
 const [msg,setMsg] = useState<{text:string; bad?:boolean}|null>(null);
 const [edit,setEdit] = useState<Draft|null>(null);
 const [isNew,setIsNew] = useState(false);
 const [retire,setRetire] = useState<{code:string; to:string}|null>(null);
 const [picked,setPicked] = useState<Set<string>>(new Set());
 const [printing,setPrinting] = useState(false);
 const load = useCallback(async ()=>{ const r = await api<{ok:boolean; destinations?:Destination[]}>('wayfinding:list',{}); if (r.ok) setList(r.destinations ?? []); },[api]);
 useEffect(()=>{ void load(); },[load]);
 useEffect(()=>{ if (!msg) return; const t = setTimeout(()=>setMsg(null),6000); return ()=>clearTimeout(t); },[msg]);
 const say = (r:{ok:boolean; reason?:string}, ok:string) => { setMsg(r.ok ? {text:ok} : {text:r.reason ?? 'บันทึกไม่สำเร็จ',bad:true}); if (r.ok) void load(); return r.ok; };
 const importAll = async () => { const r = await api<{ok:boolean; reason?:string; added?:number; kept?:number}>('wayfinding:import',{list:directoryPlaces()});
  say(r,`เพิ่มจุดหมายใหม่ ${r.added ?? 0} จุด${r.kept?` · มีอยู่แล้ว ${r.kept} จุด (คงไว้ตามที่แก้)`:''}`); };
 const save = async () => { if (!edit) return; const r = await api('wayfinding:save',{...edit,zoneIndex:edit.zoneIndex ?? null}); if (say(r,`บันทึก ${edit.nameTh} แล้ว`)) setEdit(null); };
 const doRetire = async () => { if (!retire) return; const r = await api('wayfinding:retire',{code:retire.code,replacedBy:retire.to || undefined});
  if (say(r,`เลิกใช้ ${retire.code} แล้ว${retire.to?` · ป้ายเดิมพาไป ${retire.to}`:''}`)) setRetire(null); };
 const active = list.filter(d=>d.status==='ACTIVE');
 const on = !!features.phase2.wayfinding;
 const floors = (bid:string) => buildingStats[bid]?.floors ?? [];
 const zones = edit ? floors(edit.buildingId).find(f=>f.level===edit.level)?.depts ?? [] : [];
 return <section className="setCard">
  <div className={'bookSwitch'+(on?' on':'')}><div><b>QR นำทาง {on?'เปิดใช้งาน':'ปิดอยู่'}</b>
   <small>ป้าย QR ตามจุดต่าง ๆ — สแกนแล้วเห็น "คุณอยู่ที่นี่" และทางไปจุดบริการ · เมนูแผนที่ใน LINE ใช้ข้อมูลชุดนี้ · ใน QR มีแค่รหัสจุด ไม่มีข้อมูลผู้ป่วย</small></div>
   <button className={on?'btn ghost':'btn'} onClick={()=>void setFeature(!on)}>{on?'ปิด':'เปิด'}</button></div>
  {msg && <p className={'setToast'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}
  <div className="bookBar"><button className="btn ghost" onClick={()=>void importAll()}><Download size={15}/> นำเข้าจากผังแผนก</button>
   <button className="btn ghost" onClick={()=>{ setEdit({...empty}); setIsNew(true); }}><Plus size={15}/> เพิ่มจุดหมาย</button>
   <button className="btn" disabled={!picked.size} onClick={()=>setPrinting(true)}><Printer size={15}/> พิมพ์ป้าย QR ({picked.size})</button>
   {active.length>0 && <button className="linkBtn dark" onClick={()=>setPicked(picked.size===active.length ? new Set() : new Set(active.map(d=>d.code)))}>{picked.size===active.length?'ไม่เลือกทั้งหมด':'เลือกทั้งหมด'}</button>}</div>
  {edit && <div className="wayEdit">
   <div className="slotPlanGrid">
    <label>รหัส (พิมพ์บนป้าย เปลี่ยนไม่ได้){isNew ? <input value={edit.code} maxLength={32} placeholder="เช่น OPD-PHARMACY" onChange={e=>setEdit({...edit,code:e.target.value.toUpperCase()})}/> : <b className="bookCode">{edit.code}</b>}</label>
    <label className="wide">ชื่อที่ผู้ป่วยเห็น<input value={edit.nameTh} maxLength={60} onChange={e=>setEdit({...edit,nameTh:e.target.value})}/></label>
    <label>อาคาร<select value={edit.buildingId} onChange={e=>setEdit({...edit,buildingId:e.target.value,level:1,zoneIndex:undefined})}>{buildings.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
    <label>ชั้น<select value={edit.level} onChange={e=>setEdit({...edit,level:Number(e.target.value),zoneIndex:undefined})}>{floors(edit.buildingId).map(f=><option key={f.level} value={f.level}>ชั้น {f.level}</option>)}</select></label>
    <label>โซนบนผัง<select value={edit.zoneIndex ?? ''} onChange={e=>setEdit({...edit,zoneIndex:e.target.value==='' ? undefined : Number(e.target.value)})}><option value="">ไม่ระบุ</option>{zones.map((z,i)=><option key={z+i} value={i}>{z}</option>)}</select></label>
    <label className="wide">จุดสังเกต<input value={edit.landmarkTh} maxLength={120} placeholder="เช่น ตรงข้ามลิฟต์ฝั่งซ้าย" onChange={e=>setEdit({...edit,landmarkTh:e.target.value})}/></label>
    <label className="wide">รายละเอียด<input value={edit.descriptionTh} maxLength={200} placeholder="เช่น ห้อง 201–206" onChange={e=>setEdit({...edit,descriptionTh:e.target.value})}/></label>
    <label className="lineCheck"><input type="checkbox" checked={edit.isPublic} onChange={e=>setEdit({...edit,isPublic:e.target.checked})}/> ให้ผู้ป่วยค้นหาได้</label>
   </div>
   <div className="segBtns"><button onClick={()=>setEdit(null)}>ยกเลิก</button><button className="on" disabled={!edit.code || !edit.nameTh.trim()} onClick={()=>void save()}>บันทึก</button></div>
  </div>}
  {list.length ? <div className="tableWrap tall"><table className="dataTable compact"><thead><tr><th/><th>รหัส</th><th>ชื่อ</th><th>ที่ตั้ง</th><th>จุดสังเกต</th><th>สถานะ</th><th/></tr></thead>
   <tbody>{list.map(d=><tr key={d.code} className={d.status==='RETIRED'?'muted':''}>
    <td>{d.status==='ACTIVE' && <input type="checkbox" aria-label={`เลือก ${d.nameTh} เพื่อพิมพ์`} checked={picked.has(d.code)} onChange={()=>setPicked(p=>{ const n = new Set(p); if (n.has(d.code)) n.delete(d.code); else n.add(d.code); return n; })}/>}</td>
    <td><b className="bookCode">{d.code}</b></td><td>{d.nameTh}{!d.isPublic && <small className="muted"> · เฉพาะเจ้าหน้าที่</small>}</td><td>{whereText(d)}</td><td><small>{d.landmarkTh ?? ''}</small></td>
    <td>{d.status==='ACTIVE' ? 'ใช้งาน' : `เลิกใช้${d.replacedBy?` → ${d.replacedBy}`:''}`}</td>
    <td className="slotActs">{d.status==='ACTIVE' && (retire?.code===d.code
     ? <span className="slotCancel"><select value={retire.to} onChange={e=>setRetire({...retire,to:e.target.value})}><option value="">ไม่มีจุดแทน</option>{active.filter(x=>x.code!==d.code).map(x=><option key={x.code} value={x.code}>{x.nameTh} ({x.code})</option>)}</select>
        <button className="btn sm" onClick={()=>void doRetire()}>ยืนยันเลิกใช้</button><button className="iconBtn" aria-label="กลับ" onClick={()=>setRetire(null)}><X size={14}/></button></span>
     : <><button className="iconBtn" aria-label={`แก้ไข ${d.nameTh}`} onClick={()=>{ setIsNew(false); setEdit({code:d.code,nameTh:d.nameTh,buildingId:d.buildingId,level:d.level,zoneIndex:d.zoneIndex,landmarkTh:d.landmarkTh ?? '',descriptionTh:d.descriptionTh ?? '',isPublic:d.isPublic}); }}><Pencil size={14}/></button>
        <a className="linkBtn dark" href={signUrl(d.code)} target="_blank" rel="noreferrer">ดู</a>
        <button className="linkBtn danger" onClick={()=>setRetire({code:d.code,to:''})}>เลิกใช้</button></>)}</td></tr>)}</tbody></table></div>
   : <p className="cmdNote">ยังไม่มีจุดหมาย · เริ่มจาก "นำเข้าจากผังแผนก" แล้วเพิ่มจุดสังเกตให้แต่ละจุด</p>}
  {/* Rendered on the page body: the settings pane's own layout must not clip or cover the sheet. */}
  {printing && createPortal(<SignSheet places={active.filter(d=>picked.has(d.code))} onClose={()=>setPrinting(false)}/>,document.body)}
 </section>;
}

// A4 sheet of signs: one per place — "คุณอยู่ที่ …", a large QR, where it is. Printed from the browser.
function SignSheet({places,onClose}:{places:Destination[]; onClose:()=>void}) {
 const [qrs,setQrs] = useState<Record<string,string>>({});
 useEffect(()=>{ void Promise.all(places.map(async d=>[d.code,await QRCode.toDataURL(signUrl(d.code),{margin:1,width:600,errorCorrectionLevel:'M'})] as const)).then(x=>setQrs(Object.fromEntries(x))); },[places]);
 const ready = useMemo(()=>places.every(d=>qrs[d.code]),[places,qrs]);
 return <div className="signSheet" role="dialog" aria-label="ป้าย QR สำหรับพิมพ์">
  <div className="signBar"><b>ป้าย QR {places.length} แผ่น</b><span className="muted">กระดาษ A4 แนวตั้ง · ติดระดับสายตา ใกล้ทางเข้า ลิฟต์ และทางแยก</span>
   <button className="btn" disabled={!ready} onClick={()=>window.print()}><Printer size={15}/> พิมพ์</button><button className="btn ghost" onClick={onClose}>ปิด</button></div>
  {places.map(d=><article key={d.code} className="sign">
   <p className="signTop">คุณอยู่ที่</p><h1>{d.nameTh}</h1><p className="signWhere">{whereText(d)}</p>
   {qrs[d.code] && <img src={qrs[d.code]} alt={`QR นำทาง ${d.nameTh}`}/>}
   <p className="signCall">สแกนเพื่อดูทางไปจุดบริการ</p><p className="signHelp">ใช้กล้องมือถือสแกนได้เลย ไม่ต้องติดตั้งแอป · ต้องการความช่วยเหลือ ติดต่อจุดประชาสัมพันธ์</p>
   <small className="signCode">{d.code}</small></article>)}
 </div>;
}
