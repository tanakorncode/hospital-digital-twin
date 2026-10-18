'use client';
import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

// The dates of a doctor's schedule, picked on a calendar (two months side by side): click a date to put it in — or
// take it out of — the hours chosen above it; a weekday heading takes the whole column, a month's "จ–ศ" its weekdays.
// A date can carry more than one set of hours (morning and afternoon): each shows as its own colour under the number.
export type HourSet = {id:number; color:string; dates:string[]};
const HEAD = ['จ','อ','พ','พฤ','ศ','ส','อา'], WD = [1,2,3,4,5,6,0]; // Monday first
const iso = (d:Date) => d.toLocaleDateString('sv-SE');
const monthName = (d:Date) => d.toLocaleDateString('th-TH',{month:'long',year:'numeric'});

export function ScheduleCalendar({sets,active,onToggle,min}:{sets:HourSet[]; active?:HourSet; onToggle:(dates:string[], add:boolean)=>void; min:string}) {
  const [start,setStart] = useState(()=>{ const d = new Date(`${min}T12:00:00`); d.setDate(1); return d; });
  const months = [0,1].map(k=>{ const d = new Date(start); d.setMonth(d.getMonth()+k); return d; });
  const shift = (k:number) => setStart(s=>{ const d = new Date(s); d.setMonth(d.getMonth()+k); return d; });
  const daysOf = (m:Date) => { const out:string[] = [], d = new Date(m); while (d.getMonth()===m.getMonth()) { out.push(iso(d)); d.setDate(d.getDate()+1); } return out; };
  const visible = months.flatMap(daysOf).filter(d=>d>=min);
  const on = (d:string) => !!active?.dates.includes(d);
  // Toggle a group of dates: all in → all out, otherwise all in.
  const group = (dates:string[]) => { const ok = dates.filter(d=>d>=min); if (!ok.length || !active) return; onToggle(ok,!ok.every(on)); };
  const wdOf = (d:string) => new Date(`${d}T12:00:00`).getDay();
  return <div className={'schedCal'+(active?'':' idle')}>
    <div className="schedCalNav">
      <button type="button" className="iconBtn" aria-label="เดือนก่อน" disabled={iso(start)<=min.slice(0,8)+'01'} onClick={()=>shift(-1)}><ChevronLeft size={16}/></button>
      <span className="muted">{active ? 'คลิกวันที่เพื่อเลือก / เอาออก · คลิกหัวคอลัมน์เพื่อเลือกทั้งคอลัมน์' : 'เลือกช่วงเวลาด้านบนก่อน แล้วคลิกวันที่'}</span>
      <button type="button" className="iconBtn" aria-label="เดือนถัดไป" onClick={()=>shift(1)}><ChevronRight size={16}/></button>
    </div>
    <div className="schedCalMonths">{months.map(m=>{ const days = daysOf(m), lead = (new Date(m).getDay()+6)%7;
      const weekdays = days.filter(d=>{ const w = wdOf(d); return w>=1 && w<=5; });
      return <div key={iso(m)} className="schedCalMonth">
        <div className="schedCalHead"><b>{monthName(m)}</b><button type="button" className="linkBtn dark" disabled={!active} onClick={()=>group(weekdays)}>จ–ศ ทั้งเดือน</button></div>
        <div className="schedCalGrid" role="grid" aria-label={monthName(m)}>
          {HEAD.map((h,i)=><button key={h} type="button" className="schedCalWd" disabled={!active} title={`เลือกทุกวัน${h}ที่เห็น`} onClick={()=>group(visible.filter(d=>wdOf(d)===WD[i]))}>{h}</button>)}
          {Array.from({length:lead},(_,i)=><span key={`b${i}`}/>)}
          {days.map(d=>{ const past = d<min, mine = sets.filter(s=>s.dates.includes(d));
            return <button key={d} type="button" role="gridcell" aria-selected={on(d)} disabled={past || !active} className={'schedCalDay'+(on(d)?' on':'')+(past?' past':'')}
              // the chosen hours: filled; other hours on this date: a light tint of theirs, so what is already planned shows at a glance
              style={on(d) ? {background:active!.color,borderColor:active!.color} : mine.length && !past ? {background:`color-mix(in srgb, ${mine[0].color} 16%, #fff)`} : undefined}
              title={mine.length ? `มี ${mine.length} ช่วงเวลาในวันนี้` : undefined} onClick={()=>onToggle([d],!on(d))}>
              <span>{Number(d.slice(8))}</span>
              {mine.length>0 && <i className="schedCalBars">{mine.map(s=><em key={s.id} style={{background:s.color}}/>)}</i>}
            </button>; })}
        </div>
      </div>; })}</div>
  </div>;
}
