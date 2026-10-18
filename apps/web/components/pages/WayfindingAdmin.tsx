'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { Ban, Download, ExternalLink, Link2, Pencil, Plus, Printer, Search, X } from 'lucide-react';
import { buildings, buildingStats } from '../../lib/scene-data';
import type { QueueSync } from '../../lib/queue';
import { directoryPlaces, signUrl, whereText, type Destination } from '../../lib/wayfinding';
import { Select } from '../Select';
import { ModalPortal } from '../ModalPortal';

// Settings → QR นำทาง (administrators): the places patients look for, with stable codes; QR signs to print and hang.
// A sign's QR is only this page's address and the place code — nothing else. Retire a place with where it moved to,
// so signs already on the wall keep leading somewhere useful.
type Api = QueueSync['api'];
type Draft = {code:string; nameTh:string; buildingId:string; level:number; zoneIndex?:number; landmarkTh:string; descriptionTh:string; isPublic:boolean};
// A new place starts in the first building, floor 1.
const empty = ():Draft => ({code:'',nameTh:'',buildingId:buildings[0]?.id ?? '',level:1,landmarkTh:'',descriptionTh:'',isPublic:true});

export function WayfindingAdminPane({api,features,setFeature}:{api:Api; features:QueueSync['features']; setFeature:(on:boolean)=>Promise<void>}) {
 const [list,setList] = useState<Destination[]>([]);
 const [msg,setMsg] = useState<{text:string; bad?:boolean}|null>(null);
 const [edit,setEdit] = useState<Draft|null>(null);
 const [isNew,setIsNew] = useState(false);
 const [retire,setRetire] = useState<{code:string; to:string}|null>(null);
 const [picked,setPicked] = useState<Set<string>>(new Set());
 const [printing,setPrinting] = useState(false);
 const [q,setQ] = useState('');
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
 // Search: name, code, building/floor or landmark.
 const shown = useMemo(()=>{ const t = q.trim().toLowerCase(); return !t ? list : list.filter(d=>[d.nameTh,d.code,whereText(d),d.landmarkTh ?? '',d.descriptionTh ?? ''].some(x=>x.toLowerCase().includes(t))); },[list,q]);
 const shownActive = shown.filter(d=>d.status==='ACTIVE'), allPicked = shownActive.length>0 && shownActive.every(d=>picked.has(d.code));
 // The place's link is what its QR sign holds — for a website, a LINE post or a sign made elsewhere.
 const copyLink = async (d:Destination) => { try { await navigator.clipboard.writeText(signUrl(d.code)); setMsg({text:`คัดลอกลิงก์ของ ${d.nameTh} แล้ว`}); } catch { setMsg({text:'คัดลอกไม่สำเร็จ',bad:true}); } };
 const on = !!features.phase2.wayfinding;
 const floors = (bid:string) => buildingStats[bid]?.floors ?? [];
 const zones = edit ? floors(edit.buildingId).find(f=>f.level===edit.level)?.depts ?? [] : [];
 return <section className="setCard">
  <div className={'bookSwitch'+(on?' on':'')}><div><b>QR นำทาง {on?'เปิดใช้งาน':'ปิดอยู่'}</b>
   <small>ป้าย QR ตามจุดต่าง ๆ — สแกนแล้วเห็น "คุณอยู่ที่นี่" และทางไปจุดบริการ · เมนูแผนที่ใน LINE ใช้ข้อมูลชุดนี้ · ใน QR มีแค่รหัสจุด ไม่มีข้อมูลผู้ป่วย</small></div>
   <button className={on?'btn ghost':'btn'} onClick={()=>void setFeature(!on)}>{on?'ปิด':'เปิด'}</button></div>
  {msg && <p className={'setToast'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}
  <div className="bookBar"><button className="btn ghost" onClick={()=>void importAll()}><Download size={15}/> นำเข้าจากผังแผนก</button>
   <button className="btn ghost" onClick={()=>{ setEdit(empty()); setIsNew(true); }}><Plus size={15}/> เพิ่มจุดหมาย</button>
   <button className="btn" disabled={!picked.size} onClick={()=>setPrinting(true)}><Printer size={15}/> พิมพ์ป้าย QR ({picked.size})</button>
   {shownActive.length>0 && <button className="btn ghost" onClick={()=>setPicked(p=>{ const n = new Set(p); shownActive.forEach(d=>allPicked ? n.delete(d.code) : n.add(d.code)); return n; })}>{allPicked?'ไม่เลือกที่แสดง':'เลือกที่แสดงทั้งหมด'}</button>}
   {list.length>0 && <label className="tblSearch"><Search size={16}/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="ค้นหา ชื่อ รหัส อาคาร ชั้น จุดสังเกต" aria-label="ค้นหาจุดหมาย"/>
    {q && <button className="iconBtn xs" aria-label="ล้างการค้นหา" onClick={()=>setQ('')}><X size={14}/></button>}</label>}</div>
  {edit && <div className="wayEdit">
   <div className="slotPlanGrid">
    <label>รหัส (พิมพ์บนป้าย เปลี่ยนไม่ได้){isNew ? <input value={edit.code} maxLength={32} placeholder="เช่น OPD-PHARMACY" onChange={e=>setEdit({...edit,code:e.target.value.toUpperCase()})}/> : <b className="bookCode">{edit.code}</b>}</label>
    <label className="wide">ชื่อที่ผู้ป่วยเห็น<input value={edit.nameTh} maxLength={60} onChange={e=>setEdit({...edit,nameTh:e.target.value})}/></label>
    <label>อาคาร<Select value={edit.buildingId} onChange={v=>setEdit({...edit,buildingId:v,level:1,zoneIndex:undefined})} options={buildings.map(b=>({value:b.id,label:b.name}))}/></label>
    <label>ชั้น<Select value={edit.level} onChange={v=>setEdit({...edit,level:v,zoneIndex:undefined})} options={floors(edit.buildingId).map(f=>({value:f.level,label:`ชั้น ${f.level}`}))}/></label>
    <label>โซนบนผัง<Select value={edit.zoneIndex ?? -1} onChange={v=>setEdit({...edit,zoneIndex:v<0 ? undefined : v})} options={[{value:-1,label:'ไม่ระบุ'},...zones.map((z,i)=>({value:i,label:z}))]}/></label>
    <label className="wide">จุดสังเกต<input value={edit.landmarkTh} maxLength={120} placeholder="เช่น ตรงข้ามลิฟต์ฝั่งซ้าย" onChange={e=>setEdit({...edit,landmarkTh:e.target.value})}/></label>
    <label className="wide">รายละเอียด<input value={edit.descriptionTh} maxLength={200} placeholder="เช่น ห้อง 201–206" onChange={e=>setEdit({...edit,descriptionTh:e.target.value})}/></label>
    <label className="lineCheck"><input type="checkbox" checked={edit.isPublic} onChange={e=>setEdit({...edit,isPublic:e.target.checked})}/> ให้ผู้ป่วยค้นหาได้</label>
   </div>
   <div className="segBtns"><button onClick={()=>setEdit(null)}>ยกเลิก</button><button className="on" disabled={!edit.code || !edit.nameTh.trim()} onClick={()=>void save()}>บันทึก</button></div>
  </div>}
  {list.length ? <div className="tableWrap tall"><table className="dataTable compact"><thead><tr><th/><th>รหัส</th><th>ชื่อ</th><th>ที่ตั้ง</th><th>จุดสังเกต</th><th>สถานะ</th><th/></tr></thead>
   <tbody>{shown.map(d=><tr key={d.code} className={d.status==='RETIRED'?'muted':''}>
    <td>{d.status==='ACTIVE' && <input type="checkbox" aria-label={`เลือก ${d.nameTh} เพื่อพิมพ์`} checked={picked.has(d.code)} onChange={()=>setPicked(p=>{ const n = new Set(p); if (n.has(d.code)) n.delete(d.code); else n.add(d.code); return n; })}/>}</td>
    <td><b className="bookCode">{d.code}</b></td><td>{d.nameTh}{!d.isPublic && <small className="muted"> · เฉพาะเจ้าหน้าที่</small>}</td><td>{whereText(d)}</td><td><small>{d.landmarkTh ?? ''}</small></td>
    <td>{d.status==='ACTIVE' ? 'ใช้งาน' : `เลิกใช้${d.replacedBy?` → ${d.replacedBy}`:''}`}</td>
    <td>{d.status==='ACTIVE' && <span className="rowActs"><button className="iconBtn" title="แก้ไข" aria-label={`แก้ไข ${d.nameTh}`} onClick={()=>{ setIsNew(false); setEdit({code:d.code,nameTh:d.nameTh,buildingId:d.buildingId,level:d.level,zoneIndex:d.zoneIndex,landmarkTh:d.landmarkTh ?? '',descriptionTh:d.descriptionTh ?? '',isPublic:d.isPublic}); }}><Pencil size={14}/></button>
        <button className="iconBtn" title="คัดลอกลิงก์ของจุดนี้ (ลิงก์เดียวกับในป้าย QR)" aria-label={`คัดลอกลิงก์ของ ${d.nameTh}`} onClick={()=>void copyLink(d)}><Link2 size={14}/></button>
        <a className="iconBtn" href={signUrl(d.code)} target="_blank" rel="noreferrer" title="เปิดหน้าที่ป้าย QR พาไป" aria-label={`เปิดหน้าของ ${d.nameTh}`}><ExternalLink size={14}/></a>
        <button className="iconBtn danger" title="เลิกใช้" aria-label={`เลิกใช้ ${d.nameTh}`} onClick={()=>setRetire({code:d.code,to:''})}><Ban size={14}/></button></span>}</td></tr>)}</tbody></table></div>
   : <p className="cmdNote">ยังไม่มีจุดหมาย · เริ่มจาก "นำเข้าจากผังแผนก" แล้วเพิ่มจุดสังเกตให้แต่ละจุด</p>}
  {list.length>0 && !shown.length && <p className="cmdNote">ไม่พบจุดหมายที่ตรงกับ "{q}"</p>}
  {retire && <RetireDialog place={list.find(x=>x.code===retire.code)} to={retire.to} others={active.filter(x=>x.code!==retire.code)}
   setTo={to=>setRetire({...retire,to})} onCancel={()=>setRetire(null)} onConfirm={()=>void doRetire()}/>}
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

// Retiring a place, in its own dialog: what happens to the QR signs already on the walls, and where they lead instead.
function RetireDialog({place,to,others,setTo,onCancel,onConfirm}:{place?:Destination; to:string; others:Destination[]; setTo:(to:string)=>void; onCancel:()=>void; onConfirm:()=>void}) {
 useEffect(()=>{ const f = (e:KeyboardEvent)=>{ if (e.key==='Escape') onCancel(); }; window.addEventListener('keydown',f); return ()=>window.removeEventListener('keydown',f); },[onCancel]);
 if (!place) return null;
 const target = others.find(x=>x.code===to);
 return <ModalPortal><div className="modalBack" onClick={onCancel}>
  <div className="moveDialog retireDialog" role="dialog" aria-modal="true" aria-labelledby="retireTitle" onClick={e=>e.stopPropagation()}>
   <header><div><b id="retireTitle">เลิกใช้ "{place.nameTh}"?</b><small className="muted">{place.code} · {whereText(place)}</small></div>
    <button className="iconBtn" aria-label="ปิด" onClick={onCancel}><X size={18}/></button></header>
   <ul className="retireFacts">
    <li>ตู้ต้อนรับ หน้าแผนที่ใน LINE และการค้นหา จะไม่แสดงจุดนี้อีก</li>
    <li>ป้าย QR ที่ติดไว้แล้วยังสแกนได้ — {target ? <>จะพาไปที่ <b>{target.nameTh}</b> แทน</> : 'จะขึ้นว่า "จุดนี้เลิกใช้แล้ว กรุณาสอบถามจุดประชาสัมพันธ์"'}</li>
    <li>รหัส {place.code} จะใช้ซ้ำไม่ได้ (ป้ายเก่าจะได้ไม่พาไปผิดที่)</li>
   </ul>
   <label className="retirePick"><span>ย้ายไปที่ (ไม่บังคับ)</span>
    <Select value={to} onChange={setTo} options={[{value:'',label:'ไม่มีจุดแทน — ปิดเฉย ๆ'},...others.map(x=>({value:x.code,label:x.nameTh,sub:whereText(x)}))]}/></label>
   <footer><span className="muted">บันทึกในบันทึกการใช้งาน</span><button className="btn ghost" onClick={onCancel}>ยกเลิก</button><button className="btn danger" onClick={onConfirm}>เลิกใช้จุดนี้</button></footer>
  </div>
 </div></ModalPortal>;
}

