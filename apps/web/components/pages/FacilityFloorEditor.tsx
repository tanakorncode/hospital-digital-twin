'use client';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import dynamic from 'next/dynamic';
import { ArrowLeft, ArrowRight, Images, ImagePlus, Maximize, RotateCcw, Trash2, X } from 'lucide-react';
import { ModalPortal } from '../ModalPortal';
import type { Facility, FDoor, FFloor, FFloorLayout, FRect } from '../../lib/facility';
import { layoutFloor } from '../../lib/floor-preview';
import { DOORWAY, planFloor, roomFrame, roomLocal, roomPoint, roomWalls } from '../../lib/floor-layout';
import { facilityImageUrl as imageUrl } from '../../lib/api-url';

// A floor's layout, edited on its plan (Settings → ผังโรงพยาบาล → a floor). What is drawn is the shared floor layout
// (lib/floor-layout.ts) of the draft — what the 3D map shows once published.
//   อัตโนมัติ: rooms along the back wall, a corridor, waiting areas in front. Drag the line between two rooms or two
//     areas to make one wider; pick one and move it left / right; set how deep the rooms are.
//   จัดเอง: every room and waiting area where you put it — drag to move, the corner to resize, pick the wall its door
//     is in; arrow keys nudge the selected one (Shift: further). Counters, chairs and beds follow their area.
//   ภาพผังพื้นหลัง: a floor-plan picture under the plan, to trace the real floor (คลังภาพผัง: reuse one uploaded before,
//     or delete pictures nothing uses).
//   ลิฟต์/บันได: drag the lift mark to where the lift is — directions on the patients' floor plan start there.
//   ตู้คิว: queue-ticket kiosks on this floor, dragged to where they stand.
// Grips are sized in screen pixels (bigger for a finger), so the plan works on a tablet too.
type Data = Omit<Facility,'version'|'publishedAt'>;
type Api = (event:string, body:unknown)=>Promise<{ok:boolean; reason?:string} & Record<string,unknown>>;
type Target = {kind:'room'|'area'|'bg'|'lift'|'kiosk'; id:string};
type Drag = {t:Target; mode:'move'|'size'|'door'; start:{x:number; z:number}; orig:FRect} | {t:Target; mode:'split'; list:'rooms'|'bands'; i:number; start:{x:number; z:number}; widths:number[]};
const Preview3D = dynamic(()=>import('./FacilityPreview3D'),{ssr:false,loading:()=><div className="facPreview3d loading">กำลังโหลดภาพ 3 มิติ…</div>});
const SNAP = 0.25, snap = (v:number) => Math.round(v/SNAP)*SNAP, MIN = 0.8, MIN_W = 1;
const DOORS:{v:FDoor; label:string}[] = [{v:'n',label:'บน'},{v:'s',label:'ล่าง'},{v:'w',label:'ซ้าย'},{v:'e',label:'ขวา'}];
const round2 = (v:number) => Math.round(v*100)/100;
// Drop settings that say nothing, so an untouched floor stays without a layout.
function tidy(l:FFloorLayout):FFloorLayout|undefined {
  const out:FFloorLayout = {...l};
  for (const k of Object.keys(out) as (keyof FFloorLayout)[]) { const v = out[k]; if (v===undefined || (typeof v==='object' && !Array.isArray(v) && !Object.keys(v).length) || (Array.isArray(v) && !v.length)) delete out[k]; }
  if (out.mode==='auto') delete out.mode;
  return Object.keys(out).length ? out : undefined;
}
const overlaps = (a:FRect, b:FRect) => Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0)>0.05 && Math.min(a.z1,b.z1)-Math.max(a.z0,b.z0)>0.05;

export function FloorEditor({data,floor,editable,update,api}:{data:Data; floor:FFloor; editable:boolean; update:(fn:(d:Data)=>void)=>void; api?:Api}) {
  const svg = useRef<SVGSVGElement>(null), file = useRef<HTMLInputElement>(null);
  const [view,setView] = useState<'2d'|'3d'>('2d');
  const [sel,setSel] = useState<Target|null>(null);
  const [drag,setDrag] = useState<Drag|null>(null);
  const [live,setLive] = useState<FFloorLayout|null>(null); // the layout while dragging, before it goes into the draft
  const [busy,setBusy] = useState(''), [problem,setProblem] = useState('');
  const [library,setLibrary] = useState(false);
  const [liveKiosk,setLiveKiosk] = useState<{id:string; x:number; z:number}|null>(null); // a kiosk while dragged (building-local)
  // Plan units per screen pixel, and whether the pointer is a finger: grips are at least 24 px (44 px by touch).
  const [upp,setUpp] = useState(0.05), [coarse,setCoarse] = useState(false);
  const spanW = (data.buildings.find(x=>x.id===floor.buildingId)?.map.width ?? 10)+1.2;
  useEffect(()=>{ const el = svg.current; if (!el) return; const measure = () => { const w = el.getBoundingClientRect().width; if (w) setUpp(spanW/w); };
    measure(); const ro = new ResizeObserver(measure); ro.observe(el); return ()=>ro.disconnect(); },[spanW,view]);
  useEffect(()=>{ const m = window.matchMedia('(pointer: coarse)'), on = () => setCoarse(m.matches); on(); m.addEventListener('change',on); return ()=>m.removeEventListener('change',on); },[]);
  const b = data.buildings.find(x=>x.id===floor.buildingId);
  const layout:FFloorLayout = live ?? floor.layout ?? {}, manual = layout.mode==='manual';
  const shown = useMemo(()=>({...data,floors:data.floors.map(f=>f.id===floor.id ? {...f,layout:live ?? f.layout} : f)}),[data,floor.id,live]);
  const L = useMemo(()=>layoutFloor(shown,floor.id),[shown,floor.id]);
  const plan = useMemo(()=>planFloor(shown,floor.id),[shown,floor.id]);
  if (!b || !L || !plan) return null;
  const W = L.W, D = L.D, hw = W/2, hd = D/2, pad = 0.6, fs = Math.max(0.32,W/48);
  const save = (next:FFloorLayout) => update(x=>{ const t = x.floors.find(y=>y.id===floor.id); if (!t) return; const v = tidy(next); if (v) t.layout = v; else delete t.layout; });
  const toWorld = (e:{clientX:number; clientY:number}) => { const s = svg.current!, pt = s.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(s.getScreenCTM()!.inverse()); return {x:p.x,z:p.y}; };
  const clampRect = (r:FRect, bounds = true):FRect => { if (!bounds) return r; const w = r.x1-r.x0, d = r.z1-r.z0, x0 = Math.min(hw-w,Math.max(-hw,r.x0)), z0 = Math.min(hd-d,Math.max(-hd,r.z0));
    return {x0,z0,x1:x0+w,z1:z0+d}; };
  // Where things are now (rooms and areas of the plan; what was placed by hand is in the layout).
  const roomRect = (id:string) => { const r = plan.rooms.find(x=>x.point.id===id); return r ? {x0:r.x0,z0:r.z0,x1:r.x1,z1:r.z1,door:r.door,doorAt:r.doorAt} : undefined; };
  const areaRect = (id:string) => { const a = plan.bands.find(x=>x.deptId===id); return a ? {x0:a.x0,z0:a.z0,x1:a.x1,z1:a.z1} : undefined; };
  // Marks keep their size on the plan; around each, an invisible pad as big as a fingertip takes the touch — never more
  // than `cap` (plan units), so pads do not cover the rooms next to them on a small plan.
  const hit = upp*(coarse ? 44 : 24), touchPad = (min:number, cap:number) => Math.max(min,Math.min(hit,cap));
  const LIFT = 0.35, lift = plan.lift; // the lift mark: a small square around the lift's spot
  // Kiosks on this floor (world positions in the facility; not placed yet = in the middle).
  const KIOSK = 0.3, bx = b.map.x, bz = b.map.z;
  const kioskGroups = new Set(data.groups.filter(g=>g.pointKind==='kiosk').map(g=>g.id));
  const floorKiosks = data.points.filter(p=>!p.retiredAt && kioskGroups.has(p.groupId) && p.floorId===floor.id).map(p=>{
    const at = liveKiosk?.id===p.id ? liveKiosk : p.map ? {x:p.map.x-bx,z:p.map.z-bz} : {x:0,z:0}; return {p,x:at.x,z:at.z,placed:!!p.map}; });
  const putKiosk = (id:string, x:number, z:number) => update(d=>{ const k = d.points.find(q=>q.id===id); if (k) k.map = {x:round2(x+bx),z:round2(z+bz)}; });
  const rectOf = (t:Target):FRect|undefined => t.kind==='room' ? roomRect(t.id) : t.kind==='area' ? areaRect(t.id) : t.kind==='lift' ? {x0:lift.x-LIFT,z0:lift.z-LIFT,x1:lift.x+LIFT,z1:lift.z+LIFT}
    : t.kind==='kiosk' ? (k=>k && {x0:k.x-KIOSK,z0:k.z-KIOSK,x1:k.x+KIOSK,z1:k.z+KIOSK})(floorKiosks.find(k=>k.p.id===t.id)) : layout.background;
  const withRect = (l:FFloorLayout, t:Target, r:FRect):FFloorLayout => t.kind==='room' ? {...l,rooms:{...l.rooms,[t.id]:{...r,door:l.rooms?.[t.id]?.door ?? roomRect(t.id)?.door ?? 's',
      ...(l.rooms?.[t.id]?.doorAt!==undefined ? {doorAt:l.rooms[t.id].doorAt} : {})}}}
    : t.kind==='area' ? {...l,areas:{...l.areas,[t.id]:r}} : t.kind==='lift' ? {...l,lift:{x:round2((r.x0+r.x1)/2),z:round2((r.z0+r.z1)/2)}} : {...l,background:{...l.background!,...r}};
  // Everything where the plan has it now, written down: the start of a hand-made layout.
  const placedAll = (l:FFloorLayout, p = plan):FFloorLayout => ({...l,mode:'manual',
    rooms:Object.fromEntries(p.rooms.map(r=>[r.point.id,{x0:round2(r.x0),z0:round2(r.z0),x1:round2(r.x1),z1:round2(r.z1),door:r.door,doorAt:r.doorAt}])),
    areas:Object.fromEntries(p.bands.map(a=>[a.deptId,{x0:round2(a.x0),z0:round2(a.z0),x1:round2(a.x1),z1:round2(a.z1)}]))});
  const autoPlan = () => planFloor({...data,floors:data.floors.map(f=>f.id===floor.id ? {...f,layout:{...f.layout,mode:'auto' as const}} : f)},floor.id)!;

  // ---- Dragging ----
  const begin = (e:RPointerEvent, t:Target, mode:'move'|'size') => {
    e.stopPropagation(); setSel(t); if (!editable) return;
    const r = rectOf(t); if (!r) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({t,mode,start:toWorld(e),orig:{x0:r.x0,z0:r.z0,x1:r.x1,z1:r.z1}});
  };
  // Drag the doorway along its wall.
  const beginDoor = (e:RPointerEvent, id:string) => { e.stopPropagation(); setSel({kind:'room',id}); if (!editable) return; const r = roomRect(id); if (!r) return;
    (e.target as Element).setPointerCapture(e.pointerId); setDrag({t:{kind:'room',id},mode:'door',start:toWorld(e),orig:r}); };
  const beginSplit = (e:RPointerEvent, list:'rooms'|'bands', i:number) => {
    e.stopPropagation(); if (!editable) return; (e.target as Element).setPointerCapture(e.pointerId);
    const widths = list==='rooms' ? plan.rooms.map(r=>r.x1-r.x0) : plan.bands.map(a=>a.x1-a.x0);
    setDrag({t:{kind:list==='rooms'?'room':'area',id:''},mode:'split',list,i,start:toWorld(e),widths});
  };
  const move = (e:RPointerEvent) => { if (!drag) return; const p = toWorld(e), dx = p.x-drag.start.x, dz = p.z-drag.start.z;
    if (drag.mode==='split') { // the line between item i and i+1: one wider, the other narrower
      const w = [...drag.widths], d = Math.max(MIN_W-w[drag.i],Math.min(w[drag.i+1]-MIN_W,snap(dx)));
      w[drag.i] += d; w[drag.i+1] -= d;
      const ids = drag.list==='rooms' ? plan.rooms.map(r=>r.point.id) : plan.bands.map(a=>a.deptId), share = W/ids.length;
      const weights = Object.fromEntries(ids.map((id,k)=>[id,round2(Math.min(10,Math.max(0.2,w[k]/share)))]));
      const base = floor.layout ?? {};
      setLive(drag.list==='rooms' ? {...base,roomOrder:ids,roomWeights:weights} : {...base,bandOrder:ids,bandWeights:weights}); return; }
    if (drag.mode==='door') { const r = roomRect(drag.t.id)!, W = roomFrame(r).across, g = Math.min(DOORWAY,W)/2/W, a = roomLocal(r,p).a/W;
      setLive(withDoorAt(floor.layout ?? {},drag.t.id,Math.round(Math.min(1-g,Math.max(g,a))*20)/20)); return; }
    const o = drag.orig, bg = drag.t.kind==='bg';
    if (drag.t.kind==='kiosk') { const r = clampRect({x0:snap(o.x0+dx),z0:snap(o.z0+dz),x1:snap(o.x0+dx)+(o.x1-o.x0),z1:snap(o.z0+dz)+(o.z1-o.z0)});
      setLiveKiosk({id:drag.t.id,x:(r.x0+r.x1)/2,z:(r.z0+r.z1)/2}); return; }
    const r = drag.mode==='move' ? clampRect({x0:snap(o.x0+dx),z0:snap(o.z0+dz),x1:snap(o.x0+dx)+(o.x1-o.x0),z1:snap(o.z0+dz)+(o.z1-o.z0)},!bg)
      : {x0:o.x0,z0:o.z0,x1:Math.max(o.x0+(bg?1:MIN),Math.min(bg?o.x0+400:hw,snap(o.x1+dx))),z1:Math.max(o.z0+(bg?1:MIN),Math.min(bg?o.z0+400:hd,snap(o.z1+dz)))};
    setLive(withRect(floor.layout ?? {},drag.t,r)); };
  // Letting go (of a drag or a slider) puts the change into the draft.
  const commit = () => { const next = live, k = liveKiosk; setDrag(null); setLive(null); setLiveKiosk(null); if (next) save(next); if (k) putKiosk(k.id,k.x,k.z); };
  const end = () => { if (drag) commit(); };
  const nudge = (e:RKeyboardEvent, t:Target) => {
    if (e.key==='Enter' || e.key===' ') { e.preventDefault(); setSel(t); return; }
    if (!editable || !(manual || t.kind==='bg' || t.kind==='lift' || t.kind==='kiosk')) return; const step = e.shiftKey ? 1 : SNAP;
    const d = ({ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]} as Record<string,[number,number]>)[e.key]; if (!d) return;
    e.preventDefault(); setSel(t); const r = rectOf(t); if (!r) return;
    if (t.kind==='kiosk') { const c = clampRect({x0:r.x0+d[0],z0:r.z0+d[1],x1:r.x1+d[0],z1:r.z1+d[1]}); putKiosk(t.id,(c.x0+c.x1)/2,(c.z0+c.z1)/2); return; }
    save(withRect(layout,t,clampRect({x0:r.x0+d[0],z0:r.z0+d[1],x1:r.x1+d[0],z1:r.z1+d[1]},t.kind!=='bg'))); };

  // ---- Commands ----
  const setMode = (m:'auto'|'manual') => { if (m===(manual?'manual':'auto')) return;
    if (m==='manual') save(placedAll(layout,planFloor({...data,floors:data.floors.map(f=>f.id===floor.id ? {...f,layout:{...f.layout,mode:'manual' as const}} : f)},floor.id)!));
    else save({...layout,mode:'auto'}); setSel(null); };
  const restart = () => { save(placedAll(layout,autoPlan())); setSel(null); };
  const resetAuto = () => { const {roomDepth:_a, bandOrder:_b, bandWeights:_c, roomOrder:_d, roomWeights:_e, ...rest} = layout; save(rest); };
  const shift = (t:Target, dir:-1|1) => { // automatic: move a room / an area one place left or right
    const ids = t.kind==='room' ? plan.rooms.map(r=>r.point.id) : plan.bands.map(a=>a.deptId), i = ids.indexOf(t.id), j = i+dir; if (i<0 || j<0 || j>=ids.length) return;
    [ids[i],ids[j]] = [ids[j],ids[i]];
    const wKey = t.kind==='room' ? 'roomWeights' : 'bandWeights', weights = layout[wKey];
    save(t.kind==='room' ? {...layout,roomOrder:ids,roomWeights:weights} : {...layout,bandOrder:ids,bandWeights:weights}); };
  // The doorway's place: on the room placed by hand, or (automatic) in the floor's door list.
  const withDoorAt = (l:FFloorLayout, id:string, at:number):FFloorLayout => { const r = roomRect(id)!;
    return l.mode==='manual' ? {...l,rooms:{...l.rooms,[id]:{x0:r.x0,z0:r.z0,x1:r.x1,z1:r.z1,door:r.door,doorAt:at}}} : {...l,doors:{...l.doors,[id]:at}}; };
  // Doorway at the start, middle or end of its wall as seen on the plan (left → right, or top → bottom).
  const doorPlace = (id:string, where:'start'|'mid'|'end') => { const r = roomRect(id); if (!r) return; const W = roomFrame(r).across, g = Math.min(DOORWAY,W)/2/W;
    const forward = r.door==='s' || r.door==='w', at = where==='mid' ? 0.5 : (where==='start')===forward ? g : 1-g; save(withDoorAt(layout,id,round2(at))); };
  const doorWhere = (r:{door:FDoor; doorAt?:number}) => { const at = r.doorAt ?? 0; if (Math.abs(at-0.5)<0.08) return 'mid'; return (at<0.5)===(r.door==='s' || r.door==='w') ? 'start' : 'end'; };
  const setDoor = (id:string, door:FDoor) => { const r = roomRect(id); if (r) save({...layout,rooms:{...layout.rooms,[id]:{x0:r.x0,z0:r.z0,x1:r.x1,z1:r.z1,door}}}); };
  const unplace = (t:Target) => { if (t.kind==='room') { const {[t.id]:_, ...rest} = layout.rooms ?? {}; save({...layout,rooms:rest}); } else if (t.kind==='area') { const {[t.id]:_, ...rest} = layout.areas ?? {}; save({...layout,areas:rest}); } };
  // A floor-plan picture: made smaller in the browser when it is big (longest side 3000 px, WebP), then uploaded.
  // Put a picture under this floor, fitted into the building, keeping its shape.
  const useImage = (id:string, iw:number, ih:number) => { const k = Math.min(W/iw,D/ih), w = iw*k, d = ih*k;
    save({...layout,background:{imageId:id,x0:round2(-w/2),z0:round2(-d/2),x1:round2(w/2),z1:round2(d/2),opacity:layout.background?.opacity ?? 0.6}}); setSel({kind:'bg',id}); };
  const upload = async (f:File) => {
    if (!api) return; setProblem(''); setBusy('กำลังอัปโหลดภาพ…');
    try {
      if (!['image/png','image/jpeg','image/webp'].includes(f.type)) throw new Error('รองรับเฉพาะภาพ PNG, JPEG หรือ WebP');
      let blob:Blob = f;
      const bmp = await createImageBitmap(f), side = Math.max(bmp.width,bmp.height);
      if (side>3000 || f.size>2_000_000) { const k = Math.min(1,3000/side), c = document.createElement('canvas'); c.width = Math.round(bmp.width*k); c.height = Math.round(bmp.height*k);
        c.getContext('2d')!.drawImage(bmp,0,0,c.width,c.height); blob = await new Promise<Blob>((ok,no)=>c.toBlob(x=>x ? ok(x) : no(new Error('ย่อภาพไม่สำเร็จ')),'image/webp',0.85)); }
      const r = await api('facility:image:upload',{name:f.name,bytes:await blob.arrayBuffer()}) as {ok:boolean; reason?:string; image?:{id:string; width:number; height:number}};
      if (!r.ok || !r.image) throw new Error(r.reason ?? 'อัปโหลดไม่สำเร็จ');
      useImage(r.image.id,r.image.width,r.image.height);
    } catch (e) { setProblem(e instanceof Error ? e.message : 'อัปโหลดไม่สำเร็จ'); }
    setBusy(''); if (file.current) file.current.value = '';
  };

  // ---- Drawing ----
  const bg = layout.background, sx = sel && rectOf(sel);
  const placed = manual ? plan.rooms.map(r=>({id:r.point.id,r})) : [];
  const clash = new Set<string>(); placed.forEach((a,i)=>placed.slice(i+1).forEach(c=>{ if (overlaps(a.r,c.r)) { clash.add(a.id); clash.add(c.id); } }));
  const selName = sel?.kind==='kiosk' ? floorKiosks.find(k=>k.p.id===sel.id)?.p.name ?? 'ตู้คิว' : sel?.kind==='room' ? L.rooms.find(r=>r.id===sel.id)?.name : sel?.kind==='area' ? L.bands.find(a=>a.id===sel.id)?.name : sel?.kind==='bg' ? 'ภาพผังพื้นหลัง' : sel?.kind==='lift' ? 'ลิฟต์ / บันได' : '';
  const isSel = (t:Target) => sel?.kind===t.kind && sel.id===t.id;
  const handle = (t:Target, r:FRect) => { if (!(editable && isSel(t) && (manual || t.kind==='bg'))) return null; const h = touchPad(0.64,Math.max(0.64,Math.min(r.x1-r.x0,r.z1-r.z0)*0.6));
    return <g style={{cursor:'nwse-resize'}} onPointerDown={e=>begin(e,t,'size')}><rect x={r.x1-h/2} y={r.z1-h/2} width={h} height={h} fill="transparent"/>
      <rect x={r.x1-0.32} y={r.z1-0.32} width="0.64" height="0.64" rx="0.12" fill="#1677ff" stroke="#fff" strokeWidth="0.08" aria-label="ลากเพื่อปรับขนาด"/></g>; };
  const canMove = editable && manual;
  return <figure className="facPreview facFloorEd">
    <div className="facPreviewHead"><b>ผังชั้น · {L.title}</b><span className="muted">{editable ? 'แก้ในร่าง — เห็นก่อนเผยแพร่' : 'ผังที่ใช้อยู่'}</span>
      <span className="facViews sm" role="tablist" aria-label="วิธีจัดผัง">{([['auto','อัตโนมัติ'],['manual','จัดเอง']] as const).map(([m,t])=>
        <button key={m} role="tab" aria-selected={(manual?'manual':'auto')===m} className={(manual?'manual':'auto')===m?'on':''} disabled={!editable} onClick={()=>setMode(m)}>{t}</button>)}</span>
      <span className="facViews sm" role="tablist" aria-label="มุมมอง">{(['2d','3d'] as const).map(m=><button key={m} role="tab" aria-selected={view===m} className={view===m?'on':''} onClick={()=>setView(m)}>{m.toUpperCase()}</button>)}</span></div>
    {editable && <div className="facEdTools">
      {!manual && <label className="facEdRange"><span>ความลึกแถวห้อง</span><input type="range" min={20} max={70} step={1} value={Math.round((layout.roomDepth ?? 0.42)*100)}
        onChange={e=>setLive({...(floor.layout ?? {}),roomDepth:Number(e.target.value)/100})} onPointerUp={commit} onKeyUp={commit} onBlur={commit}/><b>{Math.round((layout.roomDepth ?? 0.42)*100)}%</b></label>}
      {!manual && <button className="btn ghost sm" onClick={resetAuto} disabled={!layout.roomDepth && !layout.bandWeights && !layout.roomWeights && !layout.bandOrder && !layout.roomOrder}><RotateCcw size={14}/> สัดส่วนเดิม</button>}
      {manual && <button className="btn ghost sm" onClick={restart} title="วางทุกห้องและพื้นที่รอใหม่ตามผังอัตโนมัติ"><RotateCcw size={14}/> เริ่มจากผังอัตโนมัติ</button>}
      <span className="facEdSep"/>
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e=>{ const f = e.target.files?.[0]; if (f) void upload(f); }}/>
      <button className="btn ghost sm" disabled={!api || !!busy} onClick={()=>file.current?.click()}><ImagePlus size={14}/> {bg ? 'เปลี่ยนภาพผัง' : 'ใส่ภาพผังพื้นหลัง'}</button>
      <button className="btn ghost sm" disabled={!api} onClick={()=>setLibrary(true)}><Images size={14}/> คลังภาพผัง</button>
      {bg && <>
        <label className="facEdRange"><span>ความเข้มภาพ</span><input type="range" min={10} max={100} step={5} value={Math.round(bg.opacity*100)}
          onChange={e=>setLive({...(floor.layout ?? {}),background:{...bg,opacity:Number(e.target.value)/100}})} onPointerUp={commit} onKeyUp={commit} onBlur={commit}/></label>
        <button className="btn ghost sm" onClick={()=>save({...layout,background:{...bg,x0:-hw,z0:-hd,x1:hw,z1:hd}})} title="ยืดภาพให้เต็มอาคาร"><Maximize size={14}/> เต็มอาคาร</button>
        <button className="btn ghost sm warnBtn" onClick={()=>{ const {background:_, ...rest} = layout; save(rest); if (sel?.kind==='bg') setSel(null); }}><Trash2 size={14}/> เอาภาพออก</button></>}
      {busy && <span className="muted">{busy}</span>}{problem && <b className="facErr">{problem}</b>}
    </div>}
    {view==='3d' ? <Preview3D L={L}/> :
    <svg ref={svg} className="facEdSvg" viewBox={`${-hw-pad} ${-hd-pad} ${W+pad*2} ${D+pad*2}`} width="100%" role="img" aria-label={`ผังชั้น ${L.title}`}
      onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerDown={()=>setSel(null)} style={{touchAction:'none',userSelect:'none'}}>
      <defs><pattern id="facEdOff" width="0.3" height="0.3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="0.3" height="0.3" fill="#f1f5f9"/><line x1="0" y1="0" x2="0" y2="0.3" stroke="#cbd5e1" strokeWidth="0.1"/></pattern>
        <pattern id="facEdGrid" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M1 0H0V1" fill="none" stroke="#e8edf3" strokeWidth="0.02"/></pattern></defs>
      <rect x={-hw} y={-hd} width={W} height={D} rx="0.2" fill="#fbfcfe" stroke="#94a3b8" strokeWidth="0.08"/>
      {manual && <rect x={-hw} y={-hd} width={W} height={D} fill="url(#facEdGrid)"/>}
      {bg && <image href={imageUrl(bg.imageId)} x={bg.x0} y={bg.z0} width={bg.x1-bg.x0} height={bg.z1-bg.z0} preserveAspectRatio="none" opacity={bg.opacity}
        style={{cursor:editable && sel?.kind==='bg' ? 'move' : 'pointer'}} onPointerDown={e=>{ const t:Target = {kind:'bg',id:bg.imageId}; if (isSel(t)) begin(e,t,'move'); else { e.stopPropagation(); setSel(t); } }}/>}
      {L.corridor && <><rect x={-hw} y={L.corridor[0]} width={W} height={L.corridor[1]-L.corridor[0]} fill="#f1f5f9" opacity={bg ? 0.5 : 1}/>
        <text x="0" y={(L.corridor[0]+L.corridor[1])/2+fs*0.35} fontSize={fs*0.85} textAnchor="middle" fill="#94a3b8" pointerEvents="none">ทางเดิน</text></>}
      {L.bands.map(a=>{ const t:Target = {kind:'area',id:a.id}, s = isSel(t);
        return <g key={a.id}><rect x={a.x0+0.04} y={a.z0+0.04} width={a.w-0.08} height={a.d-0.08} rx="0.12" fill={!a.on?'url(#facEdOff)':s?'#e0edff':'#f3f6fa'} fillOpacity={bg ? 0.55 : 1}
          stroke={s?'#1677ff':'#d5dde7'} strokeWidth={s?0.1:0.04} strokeDasharray={manual?undefined:'0.2 0.12'} tabIndex={0} role="button" aria-label={`พื้นที่รอ ${a.name}`}
          style={{cursor:canMove?'move':'pointer'}} onPointerDown={e=>begin(e,t,'move')} onKeyDown={e=>nudge(e,t)}/>
          {handle(t,{x0:a.x0,z0:a.z0,x1:a.x0+a.w,z1:a.z0+a.d})}</g>; })}
      {L.seats.map((c,i)=><rect key={i} x={c.x-0.14} y={c.z-0.12} width="0.28" height="0.24" rx="0.05" fill="#cbd5e1" pointerEvents="none"/>)}
      {L.rooms.map(r=>{ const t:Target = {kind:'room',id:r.id}, s = isSel(t), bad = clash.has(r.id), rect = {x0:r.x0,x1:r.x0+r.w,z0:r.z0,z1:r.z0+r.d,door:r.door,doorAt:r.doorAt}, dr = roomWalls(rect).door;
        // The name by the door, clear of the beds along the back wall.
        const f = roomFrame(rect), label = r.name.length*fs*0.5<=f.across-0.2 ? r.name : r.short, at = roomPoint(rect,f.across/2,Math.max(f.deep/2,f.deep-0.45));
        return <g key={r.id}><rect x={r.x0+0.04} y={r.z0+0.04} width={r.w-0.08} height={r.d-0.08} rx="0.1" fill={!r.on?'url(#facEdOff)':s?'#dbeafe':'#eef3fa'} fillOpacity={bg ? 0.7 : 1}
          stroke={bad?'#dc2626':s?'#1677ff':'#94a3b8'} strokeWidth={s||bad?0.1:0.05} tabIndex={0} role="button" aria-label={`${r.name}${bad?' (ทับห้องอื่น)':''}`}
          style={{cursor:canMove?'move':'pointer'}} onPointerDown={e=>begin(e,t,'move')} onKeyDown={e=>nudge(e,t)}/>
          <line x1={dr.x0} y1={dr.z0} x2={dr.x1} y2={dr.z1} stroke="#1677ff" strokeWidth="0.14" strokeLinecap="round" opacity="0.75" pointerEvents="none"/>
          {editable && <line x1={dr.x0} y1={dr.z0} x2={dr.x1} y2={dr.z1} stroke="transparent" strokeWidth={touchPad(0.45,Math.max(0.45,Math.min(r.w,r.d)*0.4))} style={{cursor:r.door==='s'||r.door==='n'?'ew-resize':'ns-resize'}}
            aria-label={`ช่องประตู ${r.name} — ลากเพื่อเลื่อน`} onPointerDown={e=>beginDoor(e,r.id)}/>}
          <text x={at.x} y={at.z+fs*0.35} fontSize={fs} textAnchor="middle" fill={s?'#1677ff':'#334155'} fontWeight={s?700:500} pointerEvents="none">{label}</text>
          {handle(t,rect)}</g>; })}
      {L.counters.map(c=><g key={c.id} pointerEvents="none"><rect x={c.x-0.25} y={c.z-0.45} width="0.5" height="0.22" rx="0.05" fill={c.on?'#64748b':'#cbd5e1'}/><circle cx={c.x} cy={c.z} r="0.13" fill={c.on?'#94a3b8':'#cbd5e1'}/></g>)}
      {L.beds.map(c=><rect key={c.id} x={c.x-0.18} y={c.z-0.36} width="0.36" height="0.72" rx="0.06" fill="#fff" stroke="#94a3b8" strokeWidth="0.04" pointerEvents="none"/>)}
      {/* Area names on top of their chairs and beds */}
      {L.bands.map(a=><text key={`an${a.id}`} x={a.x0+a.w/2} y={a.z0+a.d-0.3} fontSize={fs} textAnchor="middle" fill={isSel({kind:'area',id:a.id})?'#1677ff':'#64748b'} fontWeight="700" pointerEvents="none">{a.name}</text>)}
      {/* Automatic: the lines between rooms / between areas, to drag */}
      {editable && !manual && plan.rooms.slice(0,-1).map((r,i)=>{ const n = plan.rooms[i+1], w = touchPad(0.32,Math.max(0.32,Math.min(r.x1-r.x0,n.x1-n.x0)*0.3)), hgt = Math.max(0.4,r.z1-r.z0-0.6);
        return <g key={`rs${i}`} className="facEdSplitG" aria-label="ลากเพื่อปรับความกว้างห้อง" onPointerDown={e=>beginSplit(e,'rooms',i)}>
          <rect x={r.x1-w/2} y={r.z0+0.3} width={w} height={hgt} fill="transparent"/><rect className="facEdSplit" x={r.x1-0.16} y={r.z0+0.3} width="0.32" height={hgt} rx="0.12"/></g>; })}
      {editable && !manual && plan.bands.slice(0,-1).map((a,i)=>{ const n = plan.bands[i+1], w = touchPad(0.32,Math.max(0.32,Math.min(a.x1-a.x0,n.x1-n.x0)*0.3)), hgt = Math.max(0.4,a.z1-a.z0-0.6);
        return <g key={`bs${i}`} className="facEdSplitG" aria-label="ลากเพื่อปรับความกว้างพื้นที่รอ" onPointerDown={e=>beginSplit(e,'bands',i)}>
          <rect x={a.x1-w/2} y={a.z0+0.3} width={w} height={hgt} fill="transparent"/><rect className="facEdSplit" x={a.x1-0.16} y={a.z0+0.3} width="0.32" height={hgt} rx="0.12"/></g>; })}
      {/* Queue-ticket kiosks on this floor */}
      {floorKiosks.map(k=>{ const t:Target = {kind:'kiosk',id:k.p.id}, s = isSel(t);
        return <g key={k.p.id} onPointerDown={e=>begin(e,t,'move')}><circle cx={k.x} cy={k.z} r={touchPad(KIOSK*2,0.9)/2} fill="transparent"/><circle cx={k.x} cy={k.z} r={KIOSK} fill={s?'#1677ff':'#0ea5e9'} stroke="#fff" strokeWidth="0.06" opacity={k.placed ? 1 : 0.55} tabIndex={0} role="button"
          aria-label={`${k.p.name ?? 'ตู้คิว'} — ลากเพื่อย้าย`} style={{cursor:editable?'move':'pointer'}} onKeyDown={e=>nudge(e,t)}/>
          <rect x={k.x-KIOSK*0.35} y={k.z-KIOSK*0.5} width={KIOSK*0.7} height={KIOSK} rx={KIOSK*0.12} fill="none" stroke="#fff" strokeWidth={KIOSK*0.14} pointerEvents="none"/>
          <text x={k.x+KIOSK+0.12} y={k.z+fs*0.35} fontSize={fs*0.8} fill="#075985" fontWeight="700" pointerEvents="none">{k.placed ? 'ตู้คิว' : 'ตู้คิว (ยังไม่วาง)'}</text></g>; })}
      {/* The lift / stairs: where directions to this floor start */}
      {(()=>{ const t:Target = {kind:'lift',id:'lift'}, s = isSel(t);
        const h = touchPad(LIFT*2,1);
        return <g onPointerDown={e=>begin(e,t,'move')}><rect x={lift.x-h/2} y={lift.z-h/2} width={h} height={h} fill="transparent"/>
          <rect x={lift.x-LIFT} y={lift.z-LIFT} width={LIFT*2} height={LIFT*2} rx="0.12" fill={s?'#1677ff':'#0f766e'} stroke="#fff" strokeWidth="0.06" tabIndex={0} role="button"
          aria-label="ลิฟต์ / บันได — ลากเพื่อย้าย" style={{cursor:editable?'move':'pointer'}} onKeyDown={e=>nudge(e,t)}/>
          <path d={`M${lift.x-0.17} ${lift.z-0.04}l0.12-0.2l0.12 0.2zM${lift.x-0.07} ${lift.z+0.04}l0.12 0.2l0.12-0.2z`} fill="#fff" pointerEvents="none"/>
          <text x={lift.x+LIFT+0.12} y={lift.z+fs*0.35} fontSize={fs*0.85} fill="#0f766e" fontWeight="700" pointerEvents="none">ลิฟต์</text></g>; })()}
      {bg && sel?.kind==='bg' && <><rect x={bg.x0} y={bg.z0} width={bg.x1-bg.x0} height={bg.z1-bg.z0} fill="none" stroke="#1677ff" strokeWidth="0.08" strokeDasharray="0.3 0.2" pointerEvents="none"/>{handle(sel,bg)}</>}
    </svg>}
    {sel && sx && view==='2d' && <div className="facEdSel">
      <b>{selName}</b>{sel.kind==='kiosk' ? <span className="muted">ตู้ออกบัตรคิวบนชั้นนี้ — แสดงบนแผนที่ 3D ตรงนี้</span> : sel.kind==='lift' ? <span className="muted">จุดเริ่มเส้นทางเมื่อผู้ป่วยมาจากชั้นอื่น</span> : <span className="muted">กว้าง {round2(sx.x1-sx.x0)} × ลึก {round2(sx.z1-sx.z0)}</span>}
      {sel.kind==='lift' && editable && layout.lift && <button className="btn ghost sm" onClick={()=>{ const {lift:_, ...rest} = layout; save(rest); }}>ตำแหน่งเดิม</button>}
      {(sel.kind==='room' || sel.kind==='area') && !manual && editable && <><button className="btn ghost sm" onClick={()=>shift(sel,-1)} aria-label="ย้ายไปทางซ้าย"><ArrowLeft size={14}/></button>
        <button className="btn ghost sm" onClick={()=>shift(sel,1)} aria-label="ย้ายไปทางขวา"><ArrowRight size={14}/></button></>}
      {sel.kind==='room' && manual && editable && <span className="facEdDoor"><span>ประตูอยู่ด้าน</span>{DOORS.map(d=><button key={d.v} className={'btn ghost sm'+(roomRect(sel.id)?.door===d.v?' on':'')}
        aria-pressed={roomRect(sel.id)?.door===d.v} onClick={()=>setDoor(sel.id,d.v)}>{d.label}</button>)}</span>}
      {sel.kind==='room' && editable && (()=>{ const r = roomRect(sel.id); if (!r) return null; const across = r.door==='s' || r.door==='n', w = doorWhere(r);
        return <span className="facEdDoor"><span>ช่องประตู</span>{([['start',across?'ชิดซ้าย':'ชิดบน'],['mid','กลาง'],['end',across?'ชิดขวา':'ชิดล่าง']] as const).map(([v,t])=>
          <button key={v} className={'btn ghost sm'+(w===v?' on':'')} aria-pressed={w===v} onClick={()=>doorPlace(sel.id,v)}>{t}</button>)}</span>; })()}
      {(sel.kind==='room' || sel.kind==='area') && manual && editable && (sel.kind==='room' ? layout.rooms?.[sel.id] : layout.areas?.[sel.id]) &&
        <button className="btn ghost sm" onClick={()=>unplace(sel)} title="ให้ระบบวางตามผังอัตโนมัติ">วางอัตโนมัติ</button>}
    </div>}
    {library && api && <ImageLibrary api={api} data={data} current={bg?.imageId} floorId={floor.id} onClose={()=>setLibrary(false)}
      onUse={editable ? (img)=>{ useImage(img.id,img.width,img.height); setLibrary(false); } : undefined}/>}
    <figcaption>{view==='3d' ? 'ลากเพื่อหมุน เลื่อนล้อเพื่อซูม' : !editable ? 'คลิกห้องหรือพื้นที่รอเพื่อดูขนาด'
      : manual ? 'ลากห้อง/พื้นที่รอเพื่อย้าย · ลากมุมสีฟ้าเพื่อปรับขนาด · เลือกแล้วใช้ลูกศรขยับ (Shift = 1 ช่อง) · เส้นสีฟ้า = ประตู (ลากเพื่อเลื่อน) · เคาน์เตอร์ เก้าอี้ และเตียงตามพื้นที่รอของแผนก'
      : 'ลากแถบระหว่างห้องหรือระหว่างพื้นที่รอเพื่อปรับความกว้าง · คลิกเพื่อเลือกแล้วย้ายซ้าย/ขวา · ลากเส้นประตูสีฟ้าเพื่อเลื่อนช่องประตู · อยากวางเองทุกห้อง เลือก "จัดเอง"'}
      {bg && editable && view==='2d' && ' · ปรับภาพผัง: คลิกที่ภาพ แล้วลากเพื่อย้าย ลากมุมเพื่อปรับขนาด'}
      {editable && view==='2d' && ` · ลากป้ายลิฟต์สีเขียวไปที่ลิฟต์จริง${floorKiosks.length ? ' · ลากวงกลมสีฟ้าเพื่อย้ายตู้คิว' : ''}`}
      {clash.size>0 && <b className="facErr"> · มีห้องวางทับกัน</b>}</figcaption>
  </figure>;
}

// ---- คลังภาพผัง: every floor-plan picture uploaded, which floors use it, reuse one, delete what nothing uses --------
type LibImage = {id:string; name:string; mime:string; width:number; height:number; size:number; uploadedAt:string; uploadedByName?:string; referenced:boolean};
function ImageLibrary({api,data,current,floorId,onClose,onUse}:{api:Api; data:Data; current?:string; floorId:string; onClose:()=>void; onUse?:(img:LibImage)=>void}) {
  const [list,setList] = useState<LibImage[]|null>(null), [problem,setProblem] = useState(''), [confirm,setConfirm] = useState('');
  useEffect(()=>{ void api('facility:images',{}).then(r=>{ if (r.ok) setList((r as unknown as {images:LibImage[]}).images); else setProblem(r.reason ?? 'โหลดคลังภาพไม่สำเร็จ'); }); },[api]);
  useEffect(()=>{ const k = (e:KeyboardEvent)=>{ if (e.key==='Escape') onClose(); }; window.addEventListener('keydown',k); return ()=>window.removeEventListener('keydown',k); },[onClose]);
  // Floors of this draft that show a picture.
  const floorName = (id:string) => { const f = data.floors.find(x=>x.id===id), b = f && data.buildings.find(x=>x.id===f.buildingId); return f ? `${b?.shortName || b?.name || ''} ${f.name}`.trim() : id; };
  const usedOn = (id:string) => data.floors.filter(f=>f.layout?.background?.imageId===id).map(f=>f.id);
  const remove = async (id:string) => { setProblem(''); const r = await api('facility:image:delete',{id});
    if (r.ok) setList((r as unknown as {images:LibImage[]}).images); else setProblem(r.reason ?? 'ลบไม่สำเร็จ'); setConfirm(''); };
  const kb = (n:number) => n>=1e6 ? `${(n/1e6).toFixed(1)} MB` : `${Math.max(1,Math.round(n/1e3))} KB`;
  return <ModalPortal><div className="modalBack" onClick={onClose}><div className="moveDialog facDialog wide" role="dialog" aria-modal="true" aria-label="คลังภาพผัง" onClick={e=>e.stopPropagation()}>
    <header><div><h3>คลังภาพผัง</h3><small className="muted">ภาพที่เคยอัปโหลด · เลือกใช้กับชั้นนี้ได้ · ลบได้เฉพาะภาพที่ไม่มีผังเวอร์ชันใดหรือร่างใดใช้อยู่</small></div>
      <button className="iconBtn" aria-label="ปิด" onClick={onClose}><X size={18}/></button></header>
    <div className="facDialogBody">
      {problem && <p className="facErr">{problem}</p>}
      {!list ? <p className="muted">กำลังโหลด…</p> : !list.length ? <p className="muted">ยังไม่มีภาพผัง — ใช้ปุ่ม "ใส่ภาพผังพื้นหลัง" เพื่ออัปโหลด</p> :
      <ul className="facLib">{list.map(img=>{ const here = usedOn(img.id), inUse = img.referenced || here.length>0, mine = img.id===current;
        return <li key={img.id} className={mine?'on':''}>
          <div className="facLibPic"><img src={imageUrl(img.id)} alt={img.name || 'ภาพผัง'} loading="lazy"/></div>
          <b title={img.name}>{img.name || 'ภาพผัง'}</b>
          <small className="muted">{img.width}×{img.height} px · {kb(img.size)} · {new Date(img.uploadedAt).toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'2-digit'})}{img.uploadedByName ? ` · ${img.uploadedByName}` : ''}</small>
          <small>{here.length ? `ใช้บน ${here.map(floorName).join(', ')}` : img.referenced ? 'อยู่ในผังที่เผยแพร่/เวอร์ชันเก่า หรือในร่าง' : 'ยังไม่มีชั้นใดใช้'}</small>
          <span className="facLibActs">
            {onUse && (mine ? <em className="muted">ใช้กับชั้นนี้อยู่</em> : <button className="btn sm" onClick={()=>onUse(img)}>ใช้กับชั้นนี้</button>)}
            {confirm===img.id ? <><button className="btn sm warnBtn" onClick={()=>void remove(img.id)}>ยืนยันลบถาวร</button><button className="btn ghost sm" onClick={()=>setConfirm('')}>ไม่ลบ</button></>
              : <button className="btn ghost sm" disabled={inUse} title={inUse ? 'ยังมีผังใช้ภาพนี้อยู่' : 'ลบภาพนี้'} onClick={()=>setConfirm(img.id)}><Trash2 size={14}/> ลบ</button>}
          </span></li>; })}</ul>}
      <small className="muted">ชั้นนี้: {floorName(floorId)}</small>
    </div>
    <footer><button className="btn ghost" onClick={onClose}>ปิด</button></footer>
  </div></div></ModalPortal>;
}
