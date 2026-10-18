'use client';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

// The days of a doctor's schedule, picked on a calendar (two months side by side), several at once:
//   เลือกเป็นช่วง (default): click a first day, then a last day — every day between comes in (shown while pointing);
//   เลือกทีละวัน: each click puts one day in. Either way a click on a chosen day takes it out (a holiday inside a range).
// A weekday heading takes the whole column (both months shown); a month's "จ–ศ" its weekdays.
const HEAD = ['จ','อ','พ','พฤ','ศ','ส','อา'], WD = [1,2,3,4,5,6,0]; // Monday first
const iso = (d:Date) => d.toLocaleDateString('sv-SE');
const monthName = (d:Date) => d.toLocaleDateString('th-TH',{month:'long',year:'numeric'});

// onChange gets updates from the latest list (quick clicks in a row each count).
export function ScheduleCalendar({value,onChange,min}:{value:string[]; onChange:Dispatch<SetStateAction<string[]>>; min:string}) {
  const [mode,setMode] = useState<'range'|'single'>('range');
  const [anchor,setAnchor] = useState<string|null>(null), [hover,setHover] = useState<string|null>(null); // a range's first day, waiting for its last
  const [start,setStart] = useState(()=>{ const d = new Date(`${min}T12:00:00`); d.setDate(1); return d; });
  const months = [0,1].map(k=>{ const d = new Date(start); d.setMonth(d.getMonth()+k); return d; });
  const shift = (k:number) => setStart(s=>{ const d = new Date(s); d.setMonth(d.getMonth()+k); return d; });
  const daysOf = (m:Date) => { const out:string[] = [], d = new Date(m); while (d.getMonth()===m.getMonth()) { out.push(iso(d)); d.setDate(d.getDate()+1); } return out; };
  const visible = months.flatMap(daysOf).filter(d=>d>=min);
  const on = (d:string) => value.includes(d);
  const wdOf = (d:string) => new Date(`${d}T12:00:00`).getDay();
  const between = (a:string, b:string) => { const [x,y] = a<b ? [a,b] : [b,a], out:string[] = [];
    for (let d = new Date(`${x}T12:00:00`); iso(d)<=y; d.setDate(d.getDate()+1)) if (iso(d)>=min) out.push(iso(d)); return out; };
  const click = (d:string) => {
    if (value.includes(d)) { onChange(cur=>cur.filter(x=>x!==d)); setAnchor(null); return; } // a chosen day: out
    if (mode==='range' && anchor && anchor!==d) { const span = between(anchor,d); onChange(cur=>[...new Set([...cur,...span])].sort()); setAnchor(null); return; }
    onChange(cur=>[...cur,d].sort()); setAnchor(mode==='range' ? d : null);
  };
  // While a range waits for its last day: the days it would take, under the pointer.
  const preview = mode==='range' && anchor && hover && hover!==anchor ? new Set(between(anchor,hover)) : null;
  // Several dates at once: all already in → take them out, otherwise put them all in.
  const group = (dates:string[]) => { const ok = dates.filter(d=>d>=min); if (!ok.length) return;
    onChange(cur=>ok.every(d=>cur.includes(d)) ? cur.filter(d=>!ok.includes(d)) : [...new Set([...cur,...ok])].sort()); };
  return <div className="schedCal">
    <div className="schedCalNav">
      <button type="button" className="iconBtn" aria-label="เดือนก่อน" disabled={iso(start)<=min.slice(0,8)+'01'} onClick={()=>shift(-1)}><ChevronLeft size={16}/></button>
      <span className="facViews sm" role="radiogroup" aria-label="วิธีเลือกวันที่">{([['range','เลือกเป็นช่วง'],['single','เลือกทีละวัน']] as const).map(([v,t])=>
        <button key={v} type="button" role="radio" aria-checked={mode===v} className={mode===v?'on':''} onClick={()=>{ setMode(v); setAnchor(null); }}>{t}</button>)}</span>
      <span className="muted schedCalHint">{mode==='range' ? (anchor ? `เริ่ม ${Number(anchor.slice(8))}/${Number(anchor.slice(5,7))} — คลิกวันสิ้นสุด` : 'คลิกวันเริ่ม แล้วคลิกวันสิ้นสุด') : 'คลิกทีละวัน'} · คลิกวันที่เลือกแล้วเพื่อเอาออก{value.length ? ` · เลือกแล้ว ${value.length} วัน` : ''}</span>
      <span className="schedCalNavR">{value.length>0 && <button type="button" className="linkBtn dark" onClick={()=>{ onChange([]); setAnchor(null); }}>ล้างทั้งหมด</button>}
        <button type="button" className="iconBtn" aria-label="เดือนถัดไป" onClick={()=>shift(1)}><ChevronRight size={16}/></button></span>
    </div>
    <div className="schedCalMonths">{months.map(m=>{ const days = daysOf(m), lead = (new Date(m).getDay()+6)%7;
      const weekdays = days.filter(d=>{ const w = wdOf(d); return w>=1 && w<=5; });
      return <div key={iso(m)} className="schedCalMonth">
        <div className="schedCalHead"><b>{monthName(m)}</b><button type="button" className="linkBtn dark" onClick={()=>group(weekdays)}>จ–ศ ทั้งเดือน</button></div>
        <div className="schedCalGrid" role="grid" aria-label={monthName(m)} aria-multiselectable="true">
          {HEAD.map((h,i)=><button key={h} type="button" className="schedCalWd" title={`เลือกทุกวัน${h}ที่เห็น`} onClick={()=>group(visible.filter(d=>wdOf(d)===WD[i]))}>{h}</button>)}
          {Array.from({length:lead},(_,i)=><span key={`b${i}`}/>)}
          {days.map(d=>{ const past = d<min;
            return <button key={d} type="button" role="gridcell" aria-selected={on(d)} disabled={past}
              className={'schedCalDay'+(on(d)?' on':'')+(past?' past':'')+(d===anchor?' anchor':'')+(preview?.has(d) && !on(d)?' preview':'')}
              onMouseEnter={()=>setHover(d)} onMouseLeave={()=>setHover(h=>h===d ? null : h)} onClick={()=>click(d)}><span>{Number(d.slice(8))}</span></button>; })}
        </div>
      </div>; })}</div>
  </div>;
}
