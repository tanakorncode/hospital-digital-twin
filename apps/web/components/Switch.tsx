'use client';
// A small on / off switch with its state written beside it (เปิด / ปิด, or `text` when given).
export function Switch({value,onChange,disabled,label,text}:{value:boolean; onChange:(v:boolean)=>void; disabled?:boolean; label:string; text?:[on:string,off:string]}) {
  return <label className="switch small" title={label}><input type="checkbox" checked={value} disabled={disabled} onChange={e=>onChange(e.target.checked)} aria-label={label}/><span/><small>{value ? text?.[0] ?? 'เปิด' : text?.[1] ?? 'ปิด'}</small></label>;
}
