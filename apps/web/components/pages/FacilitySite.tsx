'use client';
import { useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import type { Facility } from '../../lib/facility';

// The hospital grounds from above (Settings → ผังโรงพยาบาล, by place): roads, car parks and plazas as the 3D map draws
// them, the buildings and the outdoor kiosks of the draft. Drag a building to move it, its corner handle to resize it,
// a kiosk to place it; arrow keys nudge the selected building (Shift: further). Changes go into the draft.
type Data = Omit<Facility,'version'|'publishedAt'>;
type Drag = {kind:'move'|'size'|'kiosk'; id:string; start:{x:number; z:number}; orig:{x:number; z:number; w:number; d:number}};
const SNAP = 0.5, snap = (v:number) => Math.round(v/SNAP)*SNAP;
const overlap = (a:{x:number;z:number;w:number;d:number}, b:{x:number;z:number;w:number;d:number}) => Math.abs(a.x-b.x)<(a.w+b.w)/2 && Math.abs(a.z-b.z)<(a.d+b.d)/2;

export function SitePlan({data,selected,editable,onSelect,update}:{data:Data; selected?:string; editable:boolean; onSelect:(id:string)=>void; update:(fn:(d:Data)=>void)=>void}) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag,setDrag] = useState<Drag|null>(null);
  const [live,setLive] = useState<{x:number; z:number; w:number; d:number}|null>(null); // the dragged thing, before it is put in the draft
  const blds = data.buildings.filter(b=>!b.retiredAt);
  const kiosks = data.points.filter(p=>!p.retiredAt && p.map && data.groups.find(g=>g.id===p.groupId)?.pointKind==='kiosk' && !p.floorId);
  // The view: the buildings and the ground around them, with a margin (roads run on far beyond).
  const view = useMemo(()=>{
    const xs:number[] = [], zs:number[] = [];
    blds.forEach(b=>{ xs.push(b.map.x-b.map.width/2,b.map.x+b.map.width/2); zs.push(b.map.z-b.map.depth/2,b.map.z+b.map.depth/2); });
    [...(data.site.parking ?? []),...(data.site.plazas ?? [])].forEach(r=>{ xs.push(r[0],r[2]); zs.push(r[1],r[3]); });
    kiosks.forEach(k=>{ xs.push(k.map!.x); zs.push(k.map!.z); });
    if (!xs.length) return {x0:-20,z0:-20,w:40,h:40};
    const m = 6, x0 = Math.min(...xs)-m, x1 = Math.max(...xs)+m, z0 = Math.min(...zs)-m, z1 = Math.max(...zs)+m;
    return {x0,z0,w:x1-x0,h:z1-z0};
  },[data]); // eslint-disable-line react-hooks/exhaustive-deps
  const toWorld = (e:{clientX:number; clientY:number}) => { const s = svg.current!, pt = s.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(s.getScreenCTM()!.inverse()); return {x:p.x,z:p.y}; };
  // A press starts a drag; letting go without moving is a click (select the building) — selecting on the press would
  // open the building's own page under the pointer and lose the drag.
  const begin = (e:RPointerEvent, kind:Drag['kind'], id:string, orig:Drag['orig']) => {
    e.stopPropagation(); (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({kind,id,start:toWorld(e),orig}); setLive(orig);
  };
  const move = (e:RPointerEvent) => { if (!drag || !editable) return; const p = toWorld(e), dx = p.x-drag.start.x, dz = p.z-drag.start.z, o = drag.orig;
    if (drag.kind==='size') { const x0 = o.x-o.w/2, z0 = o.z-o.d/2, w = Math.max(3,snap(o.w+dx)), d = Math.max(3,snap(o.d+dz)); setLive({x:x0+w/2,z:z0+d/2,w,d}); }
    else setLive({...o,x:snap(o.x+dx),z:snap(o.z+dz)}); };
  const end = () => { if (!drag || !live) { setDrag(null); return; } const {kind,id} = drag, v = live, o = drag.orig;
    setDrag(null); setLive(null);
    if (v.x===o.x && v.z===o.z && v.w===o.w && v.d===o.d) { if (kind==='move') onSelect(id); return; }
    update(d=>{ if (kind==='kiosk') { const p = d.points.find(x=>x.id===id); if (p) p.map = {x:v.x,z:v.z}; }
      else { const b = d.buildings.find(x=>x.id===id); if (b) { b.map.x = v.x; b.map.z = v.z; b.map.width = v.w; b.map.depth = v.d; } } });
    if (kind!=='kiosk') onSelect(id); };
  const nudge = (e:RKeyboardEvent, id:string) => { if (!editable) return; const step = e.shiftKey ? 2 : SNAP;
    const d = ({ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]} as Record<string,[number,number]>)[e.key]; if (!d) return;
    e.preventDefault(); update(x=>{ const b = x.buildings.find(y=>y.id===id); if (b) { b.map.x = snap(b.map.x+d[0]); b.map.z = snap(b.map.z+d[1]); } }); };
  const rectOf = (id:string, m:{x:number; z:number; width:number; depth:number}) => drag && drag.id===id && live ? live : {x:m.x,z:m.z,w:m.width,d:m.depth};
  const clashes = new Set<string>();
  blds.forEach(a=>blds.forEach(b=>{ if (a.id<b.id && overlap(rectOf(a.id,a.map),rectOf(b.id,b.map))) { clashes.add(a.id); clashes.add(b.id); } }));
  const fs = Math.max(0.9,view.w/70);
  return <figure className="facSite">
    <svg ref={svg} viewBox={`${view.x0} ${view.z0} ${view.w} ${view.h}`} width="100%" role="img" aria-label="ผังพื้นที่โรงพยาบาล" onPointerMove={move} onPointerUp={end} onPointerCancel={end}
      style={{touchAction:'none',userSelect:'none'}}>
      <rect x={view.x0} y={view.z0} width={view.w} height={view.h} fill="#cfe3bd"/>
      {(data.site.plazas ?? []).map((r,i)=><rect key={`pl${i}`} x={r[0]} y={r[1]} width={r[2]-r[0]} height={r[3]-r[1]} fill="#e7e8e3"/>)}
      {blds.map(b=>{ const r = rectOf(b.id,b.map); return <rect key={`pz${b.id}`} x={r.x-r.w/2-1.1} y={r.z-r.d/2-1.1} width={r.w+2.2} height={r.d+2.2} fill="#e7e8e3"/>; })}
      {data.site.roads.map((r,i)=><rect key={`rd${i}`} x={r[0]} y={r[1]} width={r[2]-r[0]} height={r[3]-r[1]} fill="#6b7680"/>)}
      {data.site.parking.map((r,i)=><g key={`pk${i}`}><rect x={r[0]} y={r[1]} width={r[2]-r[0]} height={r[3]-r[1]} fill="#7b8790"/>
        <text x={(r[0]+r[2])/2} y={(r[1]+r[3])/2} fontSize={fs} textAnchor="middle" dominantBaseline="middle" fill="#fff">ลานจอดรถ</text></g>)}
      {blds.map(b=>{ const r = rectOf(b.id,b.map), sel = b.id===selected, bad = clashes.has(b.id);
        return <g key={b.id} className={'facSiteB'+(sel?' sel':'')}>
          <rect x={r.x-r.w/2} y={r.z-r.d/2} width={r.w} height={r.d} rx="0.4" fill={b.active ? b.map.color : '#e2e8f0'} stroke={bad ? '#dc2626' : sel ? '#1677ff' : '#64748b'} strokeWidth={sel||bad ? 0.35 : 0.15}
            tabIndex={0} role="button" aria-label={`${b.name} — ลากเพื่อย้าย, ลูกศรเพื่อขยับ`} style={{cursor:editable?'move':'pointer'}}
            onPointerDown={e=>begin(e,'move',b.id,{x:b.map.x,z:b.map.z,w:b.map.width,d:b.map.depth})} onKeyDown={e=>{ if (e.key==='Enter') onSelect(b.id); else nudge(e,b.id); }}/>
          <text x={r.x} y={r.z} fontSize={fs} textAnchor="middle" dominantBaseline="middle" fill="#0f2340" fontWeight="700" pointerEvents="none">{b.shortName || b.name}</text>
          {sel && editable && <rect x={r.x+r.w/2-0.7} y={r.z+r.d/2-0.7} width="1.4" height="1.4" rx="0.3" fill="#1677ff" stroke="#fff" strokeWidth="0.15" style={{cursor:'nwse-resize'}}
            aria-label="ลากเพื่อปรับขนาด" onPointerDown={e=>begin(e,'size',b.id,{x:b.map.x,z:b.map.z,w:b.map.width,d:b.map.depth})}/>}
        </g>; })}
      {kiosks.map(k=>{ const at = drag?.kind==='kiosk' && drag.id===k.id && live ? live : {x:k.map!.x,z:k.map!.z};
        return <g key={k.id}><circle cx={at.x} cy={at.z} r="0.7" fill="#0ea5e9" stroke="#fff" strokeWidth="0.2" style={{cursor:editable?'move':'default'}}
          aria-label={`${k.name ?? 'ตู้คิว'} — ลากเพื่อย้าย`} onPointerDown={e=>begin(e,'kiosk',k.id,{x:k.map!.x,z:k.map!.z,w:0,d:0})}/>
          <text x={at.x+1} y={at.z+0.3} fontSize={fs*0.8} fill="#075985" pointerEvents="none">{k.name}</text></g>; })}
    </svg>
    <figcaption>{editable ? 'ลากอาคารเพื่อย้าย · ลากมุมสีฟ้าเพื่อปรับขนาด · ลากจุดสีฟ้าเพื่อย้ายตู้คิว · ลูกศรขยับอาคารที่เลือก (Shift = ไกลขึ้น) · ' : ''}เส้นตาราง {SNAP} หน่วย
      {clashes.size>0 && <b className="facErr"> · อาคารทับกัน — ขยับออกจากกันก่อนเผยแพร่</b>}</figcaption>
  </figure>;
}
