'use client';
import { Search, X } from 'lucide-react';

// The one search field: magnifier, a borderless input, a clear button — inside its own box. Its input is `.bare`, so
// the settings cards' input style (a border on every field, globals.css) never draws a second box inside this one.
export function SearchBox({value,onChange,placeholder,label,autoFocus,className}:{value:string; onChange:(v:string)=>void; placeholder:string; label?:string; autoFocus?:boolean; className?:string}) {
  return <label className={'searchBox'+(className ? ` ${className}` : '')}>
    <Search size={15} aria-hidden="true"/>
    <input className="bare" type="search" value={value} placeholder={placeholder} aria-label={label ?? placeholder} autoFocus={autoFocus} onChange={e=>onChange(e.target.value)}/>
    {value && <button type="button" className="searchClear" aria-label="ล้างคำค้น" onClick={()=>onChange('')}><X size={14}/></button>}
  </label>;
}
