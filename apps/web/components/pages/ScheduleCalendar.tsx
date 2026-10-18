'use client';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

// The days of a doctor's schedule, picked on a calendar (two months side by side) — several at once: click a date to
// put it in or take it out; a weekday heading takes the whole column (both months shown), a month's "จ–ศ" its weekdays.
const HEAD = ['จ','อ','พ','พฤ','ศ','ส','อา'], WD = [1,2,3,4,5,6,0]; // Monday first
const iso = (d:Date) => d.toLocaleDateString('sv-SE');
const monthName = (d:Date) => d.toLocaleDateString('th-TH',{month:'long',year:'numeric'});

// onChange gets updates from the latest list (quick clicks in a row each count).
export function ScheduleCalendar({value,onChange,min}:{value:string[]; onChange:Dispatch<SetStateAction<string[]>>; min:string}) {
  const [start,setStart] = useState(()=>{ const d = new Date(`${min}T12:00:00`); d.setDate(1); return d; });
  const months = [0,1].map(k=>{ const d = new Date(start); d.setMonth(d.getMonth()+k); return d; });
  const shift = (k:number) => setStart(s=>{ const d = new Date(s); d.setMonth(d.getMonth()+k); return d; });
  const daysOf = (m:Date) => { const out:string[] = [], d = new Date(m); while (d.getMonth()===m.getMonth()) { out.push(iso(d)); d.setDate(d.getDate()+1); } return out; };
  const visible = months.flatMap(daysOf).filter(d=>d>=min);
  const on = (d:string) => value.includes(d);
  const wdOf = (d:string) => new Date(`${d}T12:00:00`).getDay();
  // Several dates at once: all already in → take them out, otherwise put them all in.
  const group = (dates:string[]) => { const ok = dates.filter(d=>d>=min); if (!ok.length) return;
    onChange(cur=>ok.every(d=>cur.includes(d)) ? cur.filter(d=>!ok.includes(d)) : [...new Set([...cur,...ok])].sort()); };
  return <div className="schedCal">
    <div className="schedCalNav">
      <button type="button" className="iconBtn" aria-label="เดือนก่อน" disabled={iso(start)<=min.slice(0,8)+'01'} onClick={()=>shift(-1)}><ChevronLeft size={16}/></button>
      <span className="muted">คลิกวันที่เพื่อเลือก / เอาออก (เลือกได้หลายวัน) · คลิกหัวคอลัมน์เพื่อเลือกทั้งคอลัมน์{value.length ? ` · เลือกแล้ว ${value.length} วัน` : ''}</span>
      <span className="schedCalNavR">{value.length>0 && <button type="button" className="linkBtn dark" onClick={()=>onChange([])}>ล้างทั้งหมด</button>}
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
            return <button key={d} type="button" role="gridcell" aria-selected={on(d)} disabled={past} className={'schedCalDay'+(on(d)?' on':'')+(past?' past':'')}
              onClick={()=>onChange(cur=>cur.includes(d) ? cur.filter(x=>x!==d) : [...cur,d].sort())}><span>{Number(d.slice(8))}</span></button>; })}
        </div>
      </div>; })}</div>
  </div>;
}
