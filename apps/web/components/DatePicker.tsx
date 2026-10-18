'use client';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { usePopover } from './usePopover';

// The app's date field (replaces the browser's native date input): the date written out in Thai on the button
// ("อา. 18 ต.ค. 2569"), a month calendar in Thai with the Buddhist year, today ringed, days outside min / max greyed.
// Keyboard: ← → a day, ↑ ↓ a week, PageUp / PageDown a month, Home / End the week, Enter picks, Esc closes.
// Values are plain 'YYYY-MM-DD' strings (local dates) — the same as the native input gave — so callers don't change.
//   <DatePicker value={d} onChange={setD} min="2026-10-18" max="…"/>     <DatePicker clearable value={''} …/> (optional date)
type Props = {value:string; onChange:(v:string)=>void; min?:string; max?:string; placeholder?:string; clearable?:boolean;
 size?:'sm'|'md'; className?:string; disabled?:boolean; id?:string; 'aria-label'?:string};

const WEEKDAYS = ['อา','จ','อ','พ','พฤ','ศ','ส'];
const MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
const pad = (n:number) => String(n).padStart(2,'0');
export const isoDate = (d:Date) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
export const parseDate = (s:string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? new Date(Number(m[1]),Number(m[2])-1,Number(m[3])) : undefined; };
export const thaiDate = (s:string) => parseDate(s)?.toLocaleDateString('th-TH',{weekday:'short',day:'numeric',month:'short',year:'numeric'}) ?? '';
const addDays = (s:string, n:number) => { const d = parseDate(s)!; d.setDate(d.getDate()+n); return isoDate(d); };
const addMonths = (s:string, n:number) => { const d = parseDate(s)!, day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth()+n);
 d.setDate(Math.min(day,new Date(d.getFullYear(),d.getMonth()+1,0).getDate())); return isoDate(d); };
// The 6 weeks shown for a month (Sunday first), as ISO dates.
export function monthGrid(year:number, month:number):string[] {
 const first = new Date(year,month,1), start = new Date(year,month,1-first.getDay());
 return Array.from({length:42},(_,i)=>isoDate(new Date(start.getFullYear(),start.getMonth(),start.getDate()+i)));
}

export function DatePicker({value,onChange,min,max,placeholder='เลือกวันที่',clearable,size='md',className,disabled,id,'aria-label':ariaLabel}:Props) {
 const today = isoDate(new Date());
 const popover = usePopover({width:300,needs:360}), {open,pos,anchor,pop} = popover;
 const [focus,setFocus] = useState(value || today); // the day the keyboard is on (and the month shown)
 const grid = useRef<HTMLDivElement>(null);
 const fd = parseDate(focus)!, year = fd.getFullYear(), month = fd.getMonth();
 const days = useMemo(()=>monthGrid(year,month),[year,month]);
 const allowed = (d:string) => (!min || d>=min) && (!max || d<=max);
 const clamp = (d:string) => min && d<min ? min : max && d>max ? max : d;

 const show = () => { if (disabled) return; setFocus(clamp(value || today)); popover.show(); };
 const pick = (d:string) => { if (!allowed(d)) return; if (d!==value) onChange(d); popover.close(); };
 useEffect(()=>{ if (open) grid.current?.querySelector<HTMLElement>('[data-focus="1"]')?.focus(); },[open,focus]);
 const onKey = (e:RKeyboardEvent) => {
  const step:Record<string,()=>string> = {ArrowLeft:()=>addDays(focus,-1),ArrowRight:()=>addDays(focus,1),ArrowUp:()=>addDays(focus,-7),ArrowDown:()=>addDays(focus,7),
   PageUp:()=>addMonths(focus,-1),PageDown:()=>addMonths(focus,1),Home:()=>addDays(focus,-fd.getDay()),End:()=>addDays(focus,6-fd.getDay())};
  if (step[e.key]) { e.preventDefault(); setFocus(clamp(step[e.key]())); }
  else if (e.key==='Enter' || e.key===' ') { if ((e.target as HTMLElement).dataset.day) { e.preventDefault(); pick(focus); } }
  else if (e.key==='Escape') { e.preventDefault(); popover.close(); }
 };
 const monthAllowed = (n:number) => { const d = parseDate(addMonths(`${year}-${pad(month+1)}-01`,n))!, first = isoDate(d), last = isoDate(new Date(d.getFullYear(),d.getMonth()+1,0));
  return (!max || first<=max) && (!min || last>=min); };

 return <>
  <span className={['dp',`dp-${size}`,className].filter(Boolean).join(' ')}>
   <button ref={anchor} type="button" id={id} className={'sel dpBtn sel-'+size+(open?' open':'')} disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel}
    onClick={()=>open ? popover.close() : show()} onKeyDown={e=>{ if (e.key==='ArrowDown') { e.preventDefault(); show(); } }}>
    <CalendarDays size={16} className="dpIcon" aria-hidden="true"/><span className={'selValue'+(value?'':' empty')}>{value ? thaiDate(value) : placeholder}</span>
   </button>
   {clearable && value && !disabled && <button type="button" className="dpClear" aria-label="ล้างวันที่" onClick={()=>onChange('')}><X size={14}/></button>}
  </span>
  {open && pos && createPortal(<div ref={pop} className={'selPop dpPop'+(pos.up?' up':'')} style={{left:pos.left,top:pos.top,width:300}} role="dialog" aria-label={ariaLabel ?? 'เลือกวันที่'} onKeyDown={onKey}>
   <div className="dpHead">
    <button type="button" className="dpNav" aria-label="เดือนก่อน" disabled={!monthAllowed(-1)} onClick={()=>setFocus(clamp(addMonths(focus,-1)))}><ChevronLeft size={18}/></button>
    <b aria-live="polite">{MONTHS[month]} {year+543}</b>
    <button type="button" className="dpNav" aria-label="เดือนถัดไป" disabled={!monthAllowed(1)} onClick={()=>setFocus(clamp(addMonths(focus,1)))}><ChevronRight size={18}/></button>
   </div>
   <div className="dpGrid" ref={grid} role="grid">
    {WEEKDAYS.map((w,i)=><span key={w} className={'dpWd'+(i===0?' sun':'')} role="columnheader">{w}</span>)}
    {days.map(d=>{ const dd = parseDate(d)!, out = dd.getMonth()!==month, ok = allowed(d);
     return <button key={d} type="button" data-day={d} data-focus={d===focus ? '1' : undefined} tabIndex={d===focus ? 0 : -1} disabled={!ok}
      className={['dpDay',out?'out':'',d===today?'today':'',d===value?'on':'',dd.getDay()===0?'sun':''].filter(Boolean).join(' ')}
      aria-selected={d===value} aria-label={thaiDate(d)} onClick={()=>pick(d)} onFocus={()=>setFocus(d)}>{dd.getDate()}</button>; })}
   </div>
   <div className="selFoot dpFoot">
    <button type="button" disabled={!allowed(today)} onClick={()=>pick(today)}>วันนี้</button>
    {clearable && <button type="button" disabled={!value} onClick={()=>{ onChange(''); popover.close(); }}>ไม่กำหนด</button>}
    <span>{value ? thaiDate(value) : ''}</span>
   </div>
  </div>,document.body)}
 </>;
}
