'use client';
import { useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import type { Clinic } from '../lib/patients';
import { buildingShort } from '../lib/facility';

// Pick several clinics out of many (20, 30 …): the chosen ones as chips (× to take one off), and a field to type part of
// a name, a letter or a floor — the list under it narrows as you type; click (or Enter) to add / remove.
export function ClinicPicker({clinics,value,onChange,placeholder='พิมพ์ชื่อคลินิก อักษร หรือชั้น เพื่อค้นหา'}:{clinics:Clinic[]; value:string[]; onChange:(v:string[])=>void; placeholder?:string}) {
  const [q,setQ] = useState(''), [open,setOpen] = useState(false), [hi,setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const label = (c:Clinic) => `${c.letter} · ${c.dept}`, where = (c:Clinic) => `${buildingShort(c.buildingId)} ชั้น ${c.level}`;
  const needle = q.trim().toLowerCase();
  const list = useMemo(()=>clinics.filter(c=>!needle || c.dept.toLowerCase().includes(needle) || c.letter.toLowerCase()===needle || where(c).toLowerCase().includes(needle)),[clinics,needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (key:string) => onChange(value.includes(key) ? value.filter(x=>x!==key) : [...value,key]);
  const chosen = value.map(k=>clinics.find(c=>c.key===k)).filter((c):c is Clinic=>!!c);
  return <div className="clinicPick" ref={box} onBlur={e=>{ if (!box.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
    {chosen.length>0 && <div className="clinicChips">{chosen.map(c=><span key={c.key} className="clinicChip"><b>{c.letter}</b>{c.dept}
      <button type="button" aria-label={`เอา ${c.dept} ออก`} onClick={()=>toggle(c.key)}><X size={12}/></button></span>)}</div>}
    <div className={'clinicField'+(open?' open':'')} onClick={()=>setOpen(true)}>
      <input className="bare" value={q} placeholder={chosen.length ? `เพิ่มคลินิก — ${placeholder}` : placeholder} aria-label="ค้นหาคลินิก" role="combobox" aria-expanded={open}
        onFocus={()=>setOpen(true)} onChange={e=>{ setQ(e.target.value); setHi(0); setOpen(true); }}
        onKeyDown={e=>{ if (e.key==='ArrowDown') { e.preventDefault(); setHi(h=>Math.min(list.length-1,h+1)); } else if (e.key==='ArrowUp') { e.preventDefault(); setHi(h=>Math.max(0,h-1)); }
          else if (e.key==='Enter') { e.preventDefault(); if (list[hi]) { toggle(list[hi].key); setQ(''); } } else if (e.key==='Escape') setOpen(false); }}/>
      <small className="muted">{value.length ? `เลือก ${value.length}` : ''}</small><ChevronDown size={15}/>
    </div>
    {open && <ul className="clinicList" role="listbox" aria-multiselectable="true">{list.length ? list.map((c,i)=>{ const on = value.includes(c.key);
      return <li key={c.key} role="option" aria-selected={on} tabIndex={-1} className={(on?'on ':'')+(i===hi?'hi':'')} onMouseDown={e=>e.preventDefault()} onMouseEnter={()=>setHi(i)}
        onClick={()=>{ toggle(c.key); setQ(''); }}><span className="clinicTick">{on && <Check size={13}/>}</span><b>{c.letter}</b><span>{c.dept}</span><small>{where(c)}</small></li>; })
      : <li className="muted clinicNone">ไม่พบคลินิกที่ตรงกับ "{q}"</li>}</ul>}
  </div>;
}
