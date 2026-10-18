'use client';
import { useId, useMemo, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { Info } from 'lucide-react';
import type { Facility, FGroup, FPoint } from '../../lib/facility';

// Help for the facility settings: an (i) after a field's label that explains, with a small picture, where the value
// shows up — and a live floor plan drawn from the draft, so a change is seen on the map before it is published.
type Data = Omit<Facility,'version'|'publishedAt'>;

// ---- (i) popovers -------------------------------------------------------------------------------------------------
export type HelpTopic = 'floor'|'pointKind'|'noun'|'minOpen'|'steps'|'serves'|'arrange'|'triage'|'prefix'|'firstGroup'|'features'|'roomCode'|'pointFloor';
const TOPICS:Record<HelpTopic,{title:string; text:ReactNode; pic?:ReactNode}> = {
  floor:{title:'อยู่ที่ (ชั้นของกลุ่ม)',text:<>ชั้นที่มี<b>พื้นที่รอ</b>ของกลุ่มนี้ ห้อง/ช่อง/เตียงทั้งหมดของกลุ่มวาดบนชั้นนี้ และผู้ป่วยถูกบอกให้ไปรอที่นี่ (นำทาง, หน้าคิว, LINE)</>,pic:<PicFloor/>},
  pointKind:{title:'แสดงบนผังเป็น',text:<><b>ห้อง</b> = กล่องห้องตามผนังด้านหลังของชั้น · <b>ช่อง/โต๊ะ</b> = เคาน์เตอร์หน้าพื้นที่รอ · <b>เตียง</b> = เตียงในห้องหรือเตียงรวม · <b>ตู้คิว</b> = ตู้ออกบัตรคิว</>,pic:<PicKinds/>},
  noun:{title:'ชื่อที่ผู้ป่วยเห็น',text:<>คำนี้ + เลข = ชื่อของแต่ละห้อง/ช่องบน<b>ป้าย จอทีวี เสียงเรียกคิว และข้อความ LINE</b> เช่น “ช่องลงทะเบียน 3” · ห้อง/ช่องที่ตั้งชื่อเอง (กดดินสอที่ชิป) ใช้ชื่อนั้นแทน</>,pic:<PicCall/>},
  minOpen:{title:'ต้องเปิดอย่างน้อย',text:<>ถ้าห้อง/ช่องที่เปิดอยู่น้อยกว่าจำนวนนี้ ระบบ<b>เตือนก่อนเผยแพร่</b> ว่าแผนกอาจรับผู้ป่วยไม่ได้ · 0 = ไม่ตรวจ (เช่น ห้องทำงาน)</>,pic:<PicMinOpen/>},
  steps:{title:'ผู้ป่วยมาทำอะไรที่นี่',text:<>ขั้นในเส้นทางของผู้ป่วยที่กลุ่มนี้รับ — ทำให้กลุ่มนี้เป็น<b>จุดคิว</b> (เรียกคิว ย้ายคิว จอทีวี ตัวจำลอง) · ไม่เลือก = ไม่ใช่จุดคิว เช่น ห้องทำงาน คลังพัสดุ</>,pic:<PicSteps/>},
  serves:{title:'ใครมาใช้',text:<><b>ผู้ป่วยของแผนกนี้</b> = คิวของแผนกเอง (ซักประวัติ ห้องตรวจ) · <b>ทุกแผนก</b> = จุดบริการร่วมที่ผู้ป่วยทุกคลินิกมาใช้ (ลงทะเบียน ห้องยา การเงิน)</>},
  arrange:{title:'การจัดวาง (ช่อง/โต๊ะ)',text:<><b>เคาน์เตอร์ยาว</b> = เจ้าหน้าที่นั่งเรียงกันที่เคาน์เตอร์เดียว · <b>โต๊ะแยก</b> = โต๊ะเดี่ยวกระจายทั่วพื้นที่ (เช่น จุดเจาะเลือด)</>,pic:<PicArrange/>},
  triage:{title:'รับผู้ป่วยระดับ (เตียงฉุกเฉิน)',text:<>ระดับคัดแยกที่เตียงกลุ่มนี้รับ · วิกฤต (1–2) = เตียงกู้ชีพ · ตัวจำลองและบอร์ด ER ส่งผู้ป่วยตามระดับนี้</>},
  prefix:{title:'อักษรคิว',text:<>ตัวหน้าเลขคิวของแผนก เช่น <b>D</b> → D012 · ห้ามซ้ำกับแผนกอื่น · ว่างได้ถ้าแผนกไม่ออกคิวเอง</>,pic:<PicTicket/>},
  firstGroup:{title:'ขั้นแรก',text:<>หลังลงทะเบียน/เช็กอิน ผู้ป่วยของแผนกนี้ถูกส่งไปรอที่กลุ่มนี้ก่อน (เช่น ซักประวัติ) · เป็นกลุ่มของแผนกอื่นได้ (ER เริ่มที่จุดคัดแยก)</>},
  features:{title:'รับผู้ป่วย',text:<>เปิดให้แผนกนี้มีในหน้ารับผู้ป่วยหน้างาน · การจองล่วงหน้า · การนัดแพทย์ (ตั้งกติกาและช่วงเวลาได้ในหน้าการจอง/นัดแพทย์)</>},
  roomCode:{title:'เลขห้อง / ป้าย',text:<>เลขบนประตูจริง (เช่น 301) ใช้บนป้ายห้องในแผนที่และเสียงประกาศ · ไม่บังคับ</>},
  pointFloor:{title:'ชั้นของห้อง/ช่องนี้',text:<>ใช้เมื่อห้อง/ช่องนี้อยู่คนละชั้นกับกลุ่ม เช่น ห้องตรวจ 5 ของอายุรกรรมอยู่ชั้น 3 · ผู้ป่วยรอที่พื้นที่รอของกลุ่ม แล้วถูกเรียกไปชั้นนั้น</>},
};
export function Help({topic}:{topic:HelpTopic}) {
  const t = TOPICS[topic], id = useId();
  return <span className="facHelp">
    <button type="button" className="facHelpBtn" aria-label={`คำอธิบาย: ${t.title}`} aria-describedby={id}><Info size={14}/></button>
    <span className="facHelpPop" role="tooltip" id={id}><b>{t.title}</b><span>{t.text}</span>{t.pic && <span className="facHelpPic">{t.pic}</span>}</span>
  </span>;
}

// Small pictures for the popovers (a floor seen from above: rooms at the back, waiting area at the front).
const C = {wall:'#94a3b8',room:'#e2e8f0',band:'#f1f5f9',hi:'#1677ff',hiFill:'#dbeafe',text:'#334155',seat:'#cbd5e1',ok:'#22c58b',off:'#cbd5e1'};
function Plan({children,h=110}:{children:ReactNode; h?:number}) {
  return <svg viewBox={`0 0 240 ${h}`} width="240" height={h} aria-hidden="true"><rect x="1" y="1" width="238" height={h-2} rx="8" fill="#fff" stroke={C.wall}/>{children}</svg>;
}
function PicFloor() {
  return <svg viewBox="0 0 240 110" width="240" height="110" aria-hidden="true">
    {[0,1,2,3].map(i=><g key={i}><rect x="70" y={14+i*22} width="100" height="18" rx="3" fill={i===1?C.hiFill:C.room} stroke={i===1?C.hi:C.wall}/>
      <text x="120" y={27+i*22} fontSize="10" textAnchor="middle" fill={i===1?C.hi:C.text}>ชั้น {4-i}{i===1?' · พื้นที่รอของกลุ่ม':''}</text></g>)}</svg>;
}
function PicKinds() {
  return <Plan h={120}>
    {[0,1,2,3].map(i=><rect key={i} x={12+i*54} y="10" width="50" height="34" rx="3" fill={i===1?C.hiFill:C.room} stroke={i===1?C.hi:C.wall}/>)}
    <text x="91" y="31" fontSize="10" textAnchor="middle" fill={C.hi}>ห้อง</text>
    <rect x="16" y="62" width="44" height="9" rx="2" fill={C.hiFill} stroke={C.hi}/><text x="38" y="84" fontSize="10" textAnchor="middle" fill={C.hi}>ช่อง/โต๊ะ</text>
    <rect x="130" y="16" width="12" height="20" rx="2" fill="#fff" stroke={C.hi}/><rect x="146" y="16" width="12" height="20" rx="2" fill="#fff" stroke={C.hi}/><text x="152" y="54" fontSize="10" textAnchor="middle" fill={C.hi}>เตียง</text>
    {[0,1,2,3,4].map(i=><rect key={i} x={80+i*14} y="96" width="9" height="9" rx="2" fill={C.seat}/>)}<text x="200" y="104" fontSize="10" textAnchor="middle" fill={C.text}>พื้นที่รอ</text>
  </Plan>;
}
function PicCall() {
  return <svg viewBox="0 0 240 90" width="240" height="90" aria-hidden="true"><rect x="1" y="1" width="238" height="88" rx="10" fill="#0b1d33"/>
    <text x="120" y="30" fontSize="11" textAnchor="middle" fill="#9fb3c8">เชิญหมายเลข</text><text x="120" y="56" fontSize="22" fontWeight="800" textAnchor="middle" fill="#fff">A012</text>
    <text x="120" y="78" fontSize="12" textAnchor="middle" fill="#fbbf24">→ ช่องลงทะเบียน 3</text></svg>;
}
function PicMinOpen() {
  return <Plan h={70}>{[0,1,2,3].map(i=><g key={i}><rect x={14+i*56} y="18" width="50" height="22" rx="11" fill={i<3?'#f0fbf6':'#f8fafc'} stroke={i<3?C.ok:C.off}/>
    <circle cx={26+i*56} cy="29" r="4" fill={i<3?C.ok:C.off}/><text x={46+i*56} y="33" fontSize="10" textAnchor="middle" fill={C.text}>{i+1}</text></g>)}
    <text x="120" y="60" fontSize="10" textAnchor="middle" fill={C.text}>เปิด 3 จาก 4 · ต้องเปิดอย่างน้อย 1 ✓</text></Plan>;
}
function PicSteps() {
  const s = ['ลงทะเบียน','ซักประวัติ','พบแพทย์','รับยา'];
  return <Plan h={64}>{s.map((t,i)=><g key={t}><rect x={8+i*58} y="18" width="52" height="26" rx="6" fill={i===1?C.hiFill:'#fff'} stroke={i===1?C.hi:C.wall}/>
    <text x={34+i*58} y="35" fontSize="9.5" textAnchor="middle" fill={i===1?C.hi:C.text}>{t}</text>{i<3 && <text x={63+i*58} y="35" fontSize="10" fill={C.wall}>›</text>}</g>)}</Plan>;
}
function PicArrange() {
  return <Plan h={86}><text x="60" y="18" fontSize="10" textAnchor="middle" fill={C.text}>เคาน์เตอร์ยาว</text><rect x="20" y="30" width="80" height="10" rx="2" fill={C.hiFill} stroke={C.hi}/>
    {[0,1,2].map(i=><circle key={i} cx={34+i*26} cy="52" r="4" fill={C.hi}/>)}
    <text x="180" y="18" fontSize="10" textAnchor="middle" fill={C.text}>โต๊ะแยก</text>{[0,1,2].map(i=><g key={i}><rect x={140+i*30} y={30+(i%2)*14} width="18" height="10" rx="2" fill={C.hiFill} stroke={C.hi}/><circle cx={149+i*30} cy={50+(i%2)*14} r="4" fill={C.hi}/></g>)}</Plan>;
}
function PicTicket() {
  return <svg viewBox="0 0 240 70" width="240" height="70" aria-hidden="true"><rect x="70" y="4" width="100" height="62" rx="8" fill="#fff" stroke={C.wall}/>
    <text x="120" y="22" fontSize="9" textAnchor="middle" fill={C.text}>บัตรคิว · ศัลยกรรม</text><text x="120" y="50" fontSize="22" fontWeight="800" textAnchor="middle" fill={C.hi}>D012</text></svg>;
}

// ---- Live floor plan --------------------------------------------------------------------------------------------
// The floor as the 3D map lays it out (lib/scene-data.ts, lib/patients.ts): one waiting band per department on the
// floor (department order), rooms along the back wall in band order, counters at the front of their band (one long
// counter, or booths across it), beds in their room or in a row at the front. Drawn from the draft, in 2D or 3D.
const label = (g:FGroup|undefined, p:FPoint) => p.name || `${g?.pointNoun ?? ''} ${p.number}`.trim();
const live = (x?:{active:boolean; retiredAt?:string}) => !!x && x.active && !x.retiredAt;
type Item = {id:string; x:number; z:number; on:boolean; hi:boolean; number:number};
export type FloorLayout = {title:string; W:number; D:number; roomFront:number; front0:number;
  bands:{id:string; name:string; x0:number; w:number; on:boolean; focus:boolean}[];
  rooms:{id:string; x0:number; w:number; name:string; short:string; on:boolean; hi:boolean}[];
  counters:(Item & {booth:boolean})[]; beds:Item[]; tag:string; tagAt?:{x:number; z:number}; focusKind?:string};
export function layoutFloor(data:Data, floorId:string, focus?:string):FloorLayout|null {
  const floor = data.floors.find(f=>f.id===floorId), b = floor && data.buildings.find(x=>x.id===floor.buildingId);
  if (!floor || !b) return null;
  const groupOf = new Map(data.groups.map(g=>[g.id,g])), order = new Map(data.departments.map((d,i)=>[d.id,i])), gOrder = new Map(data.groups.map((g,i)=>[g.id,i]));
  const pts = data.points.filter(p=>!p.retiredAt && groupOf.get(p.groupId) && !groupOf.get(p.groupId)!.retiredAt);
  const onFloor = (p:FPoint) => (p.floorId ?? groupOf.get(p.groupId)!.floorId)===floorId;
  const depts = new Set<string>();
  data.groups.forEach(g=>{ if (!g.retiredAt && g.pointKind!=='kiosk' && g.floorId===floorId && data.departments.some(d=>d.id===g.departmentId && !d.retiredAt)) depts.add(g.departmentId); });
  pts.forEach(p=>{ const g = groupOf.get(p.groupId)!; if (p.floorId===floorId && g.pointKind!=='kiosk') depts.add(g.departmentId); });
  const bandIds = [...depts].sort((x,y)=>order.get(x)!-order.get(y)!), bandOf = (deptId:string) => Math.max(0,bandIds.indexOf(deptId));
  const W = b.map.width, D = b.map.depth, hw = W/2, hd = D/2, roomFront = -hd+D*0.42, front0 = roomFront+1.2, bandW = W/Math.max(1,bandIds.length);
  const roomPts = pts.filter(p=>groupOf.get(p.groupId)!.pointKind==='room' && onFloor(p))
    .sort((a,c)=>bandOf(groupOf.get(a.groupId)!.departmentId)-bandOf(groupOf.get(c.groupId)!.departmentId) || gOrder.get(a.groupId)!-gOrder.get(c.groupId)! || a.number-c.number);
  const rw = W/Math.max(1,roomPts.length), roomIndex = new Map(roomPts.map((r,i)=>[r.id,i]));
  const on = (p:FPoint) => live(p) && live(groupOf.get(p.groupId)), hi = (p:FPoint) => p.groupId===focus;
  const item = (p:FPoint, x:number, z:number):Item => ({id:p.id,x,z,on:on(p),hi:hi(p),number:p.number});
  const counters:FloorLayout['counters'] = [], beds:Item[] = [];
  data.groups.filter(g=>!g.retiredAt && g.pointKind==='counter').forEach(g=>{ const mine = pts.filter(p=>p.groupId===g.id && onFloor(p)).sort((a,c)=>a.number-c.number); if (!mine.length) return;
    const x0 = -hw+bandOf(g.departmentId)*bandW, booth = g.options?.arrange==='booths';
    mine.forEach((p,i)=>counters.push({...(booth ? item(p,x0+(i+0.5)*bandW/mine.length,front0+0.95) : item(p,x0+0.5+((i+0.5)/mine.length)*0.9,front0+0.85)),booth})); });
  const bedPts = pts.filter(p=>groupOf.get(p.groupId)!.pointKind==='bed' && onFloor(p));
  bedPts.filter(p=>p.inRoomId && roomIndex.has(p.inRoomId)).forEach(p=>{ const mates = bedPts.filter(o=>o.inRoomId===p.inRoomId).sort((a,c)=>a.number-c.number), k = mates.indexOf(p), m = mates.length;
    beds.push(item(p,-hw+roomIndex.get(p.inRoomId!)!*rw+rw*(m<=1?0.5:0.3+0.42*k/(m-1)),-hd+0.9)); });
  const open = bedPts.filter(p=>!p.inRoomId || !roomIndex.has(p.inRoomId)), ward = open.filter(p=>groupOf.get(p.groupId)!.steps.includes('ward'));
  ward.forEach((p,j)=>beds.push(item(p,-hw+0.55+j*((W-1.1)/Math.max(1,ward.length-1)),hd-0.8)));
  open.filter(p=>!ward.includes(p)).forEach(p=>{ const mates = open.filter(o=>o.groupId===p.groupId), k = mates.indexOf(p), m = mates.length, x0 = -hw+bandOf(groupOf.get(p.groupId)!.departmentId)*bandW;
    beds.push(item(p,x0+bandW*(m<=1?0.5:0.3+0.42*k/(m-1)),hd-0.8)); });
  const fg = focus ? groupOf.get(focus) : undefined;
  const rooms = roomPts.map((p,k)=>({id:p.id,x0:-hw+k*rw,w:rw,name:label(groupOf.get(p.groupId),p),short:p.roomCode ?? String(p.number),on:on(p),hi:hi(p)}));
  // The group being edited, called out with its name and its numbers, by the first of its rooms / counters / beds.
  const mine = [...rooms.filter(r=>r.hi).map(r=>({x:r.x0+r.w/2,z:roomFront})),...counters.filter(c=>c.hi),...beds.filter(c=>c.hi)];
  const nums = fg ? pts.filter(p=>p.groupId===fg.id && onFloor(p)).map(p=>p.number).sort((a,c)=>a-c) : [];
  const tag = fg && mine.length ? `${fg.pointNoun} ${nums.length>1 ? `${nums[0]}–${nums[nums.length-1]}` : nums[0] ?? ''}`.trim() : '';
  return {title:`${b.shortName || b.name} ${floor.name}`,W,D,roomFront,front0,rooms,counters,beds,tag,tagAt:mine[0] ? {x:Math.min(...mine.map(m=>m.x)),z:Math.max(...mine.map(m=>m.z))} : undefined,focusKind:fg?.pointKind,
    bands:bandIds.map((id,i)=>{ const d = data.departments.find(x=>x.id===id); return {id,name:d?.name ?? '',x0:-hw+i*bandW,w:bandW,on:live(d),focus:!!fg && fg.departmentId===id}; })};
}

// 2D or 3D, remembered while the page is open (3D loads only when asked for).
const Preview3D = dynamic(()=>import('./FacilityPreview3D'),{ssr:false,loading:()=><div className="facPreview3d loading">กำลังโหลดภาพ 3 มิติ…</div>});
let lastMode:'2d'|'3d' = '2d';
export function FloorPreview({data,floorId,focus}:{data:Data; floorId:string; focus?:string}) {
  const [mode,setModeState] = useState(lastMode);
  const setMode = (m:'2d'|'3d') => { lastMode = m; setModeState(m); };
  const L = useMemo(()=>layoutFloor(data,floorId,focus),[data,floorId,focus]);
  if (!L) return <p className="muted">กลุ่มนี้ยังไม่ได้อยู่บนชั้นใด</p>;
  return <figure className="facPreview">
    <div className="facPreviewHead"><b>ผังชั้นตัวอย่าง · {L.title}</b><span className="muted">จากร่าง — เห็นก่อนเผยแพร่</span>
      <span className="facViews sm" role="tablist">{(['2d','3d'] as const).map(m=><button key={m} role="tab" aria-selected={mode===m} className={mode===m?'on':''} onClick={()=>setMode(m)}>{m.toUpperCase()}</button>)}</span></div>
    {mode==='2d' ? <Plan2D L={L}/> : <Preview3D L={L}/>}
    <figcaption><i className="facLegend room"/>ห้อง <i className="facLegend desk"/>ช่อง/โต๊ะ <i className="facLegend bed"/>เตียง <i className="facLegend off"/>ปิด{mode==='3d' ? ' · ลากเพื่อหมุน เลื่อนล้อเพื่อซูม' : ''}</figcaption>
  </figure>;
}
function Plan2D({L}:{L:FloorLayout}) {
  const {W,D,roomFront,front0} = L, hw = W/2, hd = D/2;
  const S = 540/W, sx = (x:number) => (x+hw)*S+10, sz = (z:number) => (z+hd)*S+10, svgH = D*S+20;
  const fs = 10, fits = (t:string, w:number) => t.length*fs*0.56 <= w*S-6;
  const roomText = (r:FloorLayout['rooms'][number]) => fits(r.name,r.w) ? r.name : fits(r.short,r.w) || r.w*S>=14 ? r.short : '';
  const tagW = L.tag.length*6.2+16, tagLeft = L.tagAt ? Math.max(12,Math.min(548-tagW,sx(L.tagAt.x)-8)) : 0;
  const tagTop = L.tagAt ? Math.min(svgH-28,sz(L.tagAt.z)+(L.focusKind==='room' ? 6 : 22)) : 0;
  return <svg viewBox={`0 0 560 ${svgH}`} width="100%" role="img" aria-label={`ผังชั้นตัวอย่าง ${L.title}`}>
    <defs><pattern id="facOff" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#f1f5f9"/><line x1="0" y1="0" x2="0" y2="6" stroke="#cbd5e1" strokeWidth="2"/></pattern></defs>
    <rect x="10" y="10" width={W*S} height={D*S} rx="6" fill="#fbfcfe" stroke={C.wall} strokeWidth="1.5"/>
    {L.bands.map(bd=><g key={bd.id}><rect x={sx(bd.x0)} y={sz(front0)} width={bd.w*S} height={(hd-front0)*S} fill={bd.focus?'#eef5ff':bd.on?C.band:'url(#facOff)'} stroke="#e2e8f0"/>
      <text x={sx(bd.x0+bd.w/2)} y={sz(hd)-8} fontSize="11" textAnchor="middle" fill={bd.focus?C.hi:'#64748b'} fontWeight="700">{bd.name}{bd.on?'':' (ปิด)'}</text></g>)}
    <rect x="10" y={sz(roomFront)} width={W*S} height={1.2*S} fill="#f8fafc"/>
    <text x={sx(0)} y={sz(roomFront+0.6)+4} fontSize="9" textAnchor="middle" fill="#94a3b8">ทางเดิน</text>
    {L.rooms.map(r=><g key={r.id}><rect x={sx(r.x0)+1} y={sz(-hd)+1} width={r.w*S-2} height={(roomFront+hd)*S-2} rx="3" fill={!r.on?'url(#facOff)':r.hi?C.hiFill:C.room} stroke={r.hi?C.hi:C.wall} strokeWidth={r.hi?2:1}/>
      <text x={sx(r.x0+r.w/2)} y={sz((roomFront-hd)/2)+4} fontSize={fs} textAnchor="middle" fill={r.hi?C.hi:r.on?C.text:'#94a3b8'} fontWeight={r.hi?700:500}>{roomText(r)}</text></g>)}
    {L.counters.map(c=><g key={c.id}><rect x={sx(c.x)-7} y={sz(c.z)-9} width="14" height="7" rx="2" fill={!c.on?C.off:c.hi?C.hi:'#64748b'}/><circle cx={sx(c.x)} cy={sz(c.z)+4} r="4" fill={!c.on?C.off:c.hi?C.hi:'#94a3b8'}/>
      {c.booth && <text x={sx(c.x)} y={sz(c.z)+18} fontSize="9" textAnchor="middle" fill={c.hi?C.hi:C.text}>{c.number}</text>}</g>)}
    {L.beds.map(c=><rect key={c.id} x={sx(c.x)-6} y={sz(c.z)-10} width="12" height="20" rx="2" fill={!c.on?C.off:c.hi?C.hiFill:'#fff'} stroke={c.hi?C.hi:C.wall} strokeWidth={c.hi?2:1}/>)}
    {L.tag && <g><rect x={tagLeft} y={tagTop} width={tagW} height="20" rx="10" fill={C.hi}/><text x={tagLeft+tagW/2} y={tagTop+14} fontSize="11" fontWeight="700" textAnchor="middle" fill="#fff">{L.tag}</text></g>}
  </svg>;
}
