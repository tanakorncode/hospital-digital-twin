'use client';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import { usePopover } from './usePopover';

// The one dropdown of the app (replaces the browser's native <select>): same look everywhere, a search box in every
// list, keyboard use (↑ ↓ Enter Esc, typing goes to the search), and the list opens on the page body — a table or a
// card with overflow never clips it. ARIA: a combobox button with a listbox popup.
//   <Select value={v} onChange={setV} options={[{value:'a',label:'A',sub:'…'}]} placeholder="…" aria-label="…"/>
//   <Select multiple value={list} onChange={setList} options={…}/>      several values: ticks, the list stays open,
//                                                                          "select all shown" / clear, a summary on the button
// Values keep their type (string or number), so callers don't parse them back.
export type SelectOption<T extends string|number> = {value:T; label:string; sub?:string; disabled?:boolean};
type Base<T extends string|number> = {options:SelectOption<T>[]; placeholder?:string; searchPlaceholder?:string; size?:'sm'|'md'|'lg'; className?:string;
 disabled?:boolean; id?:string; 'aria-label'?:string};
type Single<T extends string|number> = Base<T> & {multiple?:false; value:T; onChange:(v:T)=>void};
type Multi<T extends string|number> = Base<T> & {multiple:true; value:T[]; onChange:(v:T[])=>void};

export function Select<T extends string|number>(props:Single<T>|Multi<T>) {
 const {options,placeholder='เลือก',searchPlaceholder='พิมพ์เพื่อค้นหา',size='md',className,disabled,id,'aria-label':ariaLabel} = props;
 const multi = props.multiple===true;
 const selected:T[] = multi ? props.value : [props.value];
 const [q,setQ] = useState('');
 const [active,setActive] = useState(0);
 const popover = usePopover({width:multi ? 260 : 220,needs:280}), {open,pos,anchor:btn,pop} = popover;
 const list = useRef<HTMLUListElement>(null), search = useRef<HTMLInputElement>(null);
 const listId = useId();
 const isOn = (v:T) => selected.includes(v);
 const shown = useMemo(()=>{ const t = q.trim().toLowerCase(); return !t ? options : options.filter(o=>`${o.label} ${o.sub ?? ''}`.toLowerCase().includes(t)); },[options,q]);
 const chosen = options.filter(o=>isOn(o.value));
 const summary = !chosen.length ? '' : !multi || chosen.length<=2 ? chosen.map(o=>o.label).join(', ') : `${chosen.slice(0,2).map(o=>o.label).join(', ')} +${chosen.length-2}`;

 const show = () => { if (disabled) return; setQ(''); setActive(Math.max(0,options.findIndex(o=>isOn(o.value)))); popover.show(); };
 const close = popover.close;
 const listH = pos ? Math.min(340,pos.maxH-(multi?110:56)) : 300;
 const pick = (o:SelectOption<T>|undefined) => {
  if (!o || o.disabled) return;
  if (props.multiple===true) { props.onChange(isOn(o.value) ? props.value.filter(v=>v!==o.value) : [...props.value,o.value]); return; } // stays open
  if (o.value!==props.value) props.onChange(o.value);
  close();
 };
 // Multiple: tick / untick every option the search shows (disabled ones are left as they are), or clear all.
 const allShownOn = shown.filter(o=>!o.disabled).every(o=>isOn(o.value));
 const toggleShown = () => { if (props.multiple!==true) return; const vals = shown.filter(o=>!o.disabled).map(o=>o.value);
  props.onChange(allShownOn ? props.value.filter(v=>!vals.includes(v)) : [...props.value,...vals.filter(v=>!props.value.includes(v))]); };
 const clear = () => { if (props.multiple===true) props.onChange([]); };

 useLayoutEffect(()=>{ if (open) search.current?.focus(); },[open]);
 useEffect(()=>{ setActive(a=>Math.min(a,Math.max(0,shown.length-1))); },[shown.length]);
 useEffect(()=>{ if (open) list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({block:'nearest'}); },[active,open]);

 const move = (d:number) => { if (!shown.length) return; let i = active; for (let n = 0; n<shown.length; n++) { i = (i+d+shown.length)%shown.length; if (!shown[i].disabled) break; } setActive(i); };
 const onKey = (e:RKeyboardEvent) => {
  if (e.key==='ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key==='ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key==='Home') { e.preventDefault(); setActive(0); }
  else if (e.key==='End') { e.preventDefault(); setActive(shown.length-1); }
  else if (e.key==='Enter') { e.preventDefault(); pick(shown[active]); }
  else if (e.key==='Escape') { e.preventDefault(); close(); }
  else if (e.key==='Tab') close(false);
 };
 const onButtonKey = (e:RKeyboardEvent) => {
  if (['ArrowDown','ArrowUp','Enter',' '].includes(e.key)) { e.preventDefault(); show(); }
  else if (e.key.length===1 && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); show(); setQ(e.key); } // typing starts a search
 };

 return <>
  <button ref={btn} type="button" id={id} className={['sel',`sel-${size}`,open?'open':'',className].filter(Boolean).join(' ')} disabled={disabled}
   role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-label={ariaLabel}
   onClick={()=>open ? close() : show()} onKeyDown={onButtonKey}>
   <span className={'selValue'+(summary?'':' empty')}>{summary || placeholder}</span>
   {multi && chosen.length>0 && <span className="selCount" aria-label={`เลือก ${chosen.length} รายการ`}>{chosen.length}</span>}
   <ChevronDown size={size==='lg'?20:16} className="selChevron" aria-hidden="true"/>
  </button>
  {open && pos && createPortal(<div ref={pop} className={'selPop'+(pos.up?' up':'')} style={{left:pos.left,top:pos.top,width:pos.width}} onKeyDown={onKey}>
   <label className="selSearch"><Search size={15} aria-hidden="true"/><input ref={search} value={q} onChange={e=>{ setQ(e.target.value); setActive(0); }} placeholder={searchPlaceholder}
    role="searchbox" aria-label={searchPlaceholder} aria-controls={listId} aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}/></label>
   <ul ref={list} id={listId} role="listbox" aria-label={ariaLabel} aria-multiselectable={multi || undefined} className="selList" style={{maxHeight:listH}}>
    {shown.map((o,i)=><li key={String(o.value)} id={`${listId}-${i}`} data-i={i} role="option" aria-selected={isOn(o.value)} aria-disabled={o.disabled || undefined}
     className={['selOpt',i===active?'active':'',isOn(o.value)?'on':'',o.disabled?'off':''].filter(Boolean).join(' ')}
     onMouseEnter={()=>setActive(i)} onMouseDown={e=>e.preventDefault()} onClick={()=>pick(o)}>
     {multi && <span className={'selBox'+(isOn(o.value)?' on':'')} aria-hidden="true">{isOn(o.value) && <Check size={13} strokeWidth={3}/>}</span>}
     <span className="selOptText"><span>{o.label}</span>{o.sub && <small>{o.sub}</small>}</span>{!multi && isOn(o.value) && <Check size={16} aria-hidden="true"/>}</li>)}
    {!shown.length && <li className="selNone" role="presentation">ไม่พบ “{q}”</li>}
   </ul>
   {multi && <div className="selFoot">
    <button type="button" onMouseDown={e=>e.preventDefault()} onClick={toggleShown} disabled={!shown.length}>{allShownOn && shown.length ? 'ไม่เลือกที่แสดง' : q ? 'เลือกที่แสดงทั้งหมด' : 'เลือกทั้งหมด'}</button>
    <button type="button" onMouseDown={e=>e.preventDefault()} onClick={clear} disabled={!chosen.length}>ล้าง</button>
    <span>{chosen.length ? `เลือก ${chosen.length}` : ''}</span>
    <button type="button" className="done" onClick={()=>close()}>เสร็จ</button>
   </div>}
  </div>,document.body)}
 </>;
}
