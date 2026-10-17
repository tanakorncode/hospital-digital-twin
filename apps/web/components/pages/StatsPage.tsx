'use client';
import { useMemo, useRef, useState, type MouseEvent as RMouseEvent, type ReactNode } from 'react';
import { Download, Minus, Plus, RotateCcw, Table2 } from 'lucide-react';
import { DEFAULT_CAPACITY, capacityText, opdClinics, stepText, type Capacity, type CapacityKey, type Patient } from '../../lib/patients';
import { canDo, type AuthUser, type QueueSync } from '../../lib/queue';
import { Phase2Report } from './Phase2Report';
import { STAT_HOURS, STEP_ORDER, runScenario, summarize, toCsv, weekSummaries, type DaySummary } from '../../lib/ops';

// Sequential blue ramp (light → dark) for the heatmap; series colours for single / paired bars.
const RAMP = ['#cde2fb','#9ec5f4','#6da7ec','#3987e5','#256abf','#184f95','#0d366b'];
const SERIES = {now:'#2a78d6',scenario:'#eb6834'};
const rampColor = (v:number, max:number) => v<=0 ? 'var(--viz-empty)' : RAMP[Math.min(RAMP.length-1,Math.floor(v/max*RAMP.length))];

// One floating tooltip for all charts on the page.
function useTooltip() {
 const [tip,setTip] = useState<{x:number;y:number;body:ReactNode}|null>(null);
 const host = useRef<HTMLDivElement>(null);
 const show = (e:RMouseEvent, body:ReactNode) => { const r = host.current?.getBoundingClientRect(); if (r) setTip({x:e.clientX-r.left+12,y:e.clientY-r.top+12,body}); };
 const el = tip && <div className="vizTip" style={{left:tip.x,top:tip.y}} role="tooltip">{tip.body}</div>;
 return {host,show,hide:()=>setTip(null),el};
}

// report: the signed-in supervisor / administrator — adds the report from real records (bookings, appointments, LINE).
export default function StatsPage({patients,minute,timeNote,report}:{patients:Patient[];minute:number;timeNote:string;report?:{api:QueueSync['api'];user:AuthUser|null}}) {
 const tt = useTooltip();
 const today = useMemo(()=>summarize('วันนี้',patients,Math.floor(minute)),[patients,minute]);
 const week = useMemo(()=>weekSummaries(),[]);
 const [asTable,setAsTable] = useState(false);
 const steps = STEP_ORDER.filter(k=>today.stepWait[k]!==undefined);
 const maxStep = Math.max(1,...steps.map(k=>today.stepWait[k]!));
 const worst = steps.slice().sort((a,b)=>today.stepWait[b]!-today.stepWait[a]!)[0];
 const heatMax = Math.max(1,...week.flatMap(d=>d.arrivals));
 const exportCsv = () => {
  const rows:(string|number)[][] = [['ตาราง','วัน','ชั่วโมง/ขั้นตอน','ค่า'],
   ...week.flatMap(d=>STAT_HOURS.map((h,i)=>['มาถึงต่อชั่วโมง',d.name,`${h}:00`,d.arrivals[i]])),
   ...week.flatMap(d=>STEP_ORDER.filter(k=>d.stepWait[k]!==undefined).map(k=>['รอเฉลี่ย (นาที)',d.name,stepText[k].wait,d.stepWait[k]!])),
   ...week.map(d=>['เวลาอยู่ใน รพ. OPD มัธยฐาน (นาที)',d.name,'',d.medianTime])];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([toCsv(rows)],{type:'text/csv;charset=utf-8'})); a.download = 'hospital-stats-demo.csv'; a.click(); URL.revokeObjectURL(a.href);
 };
 return <div className="page viz-root" ref={tt.host}>
  <div className="pageHead"><h2>สถิติและรายงาน</h2><span className="pageTime">{timeNote}</span>
   <button className="btn ghost" onClick={exportCsv}><Download size={14}/> ส่งออก CSV</button></div>

  {report?.user && canDo(report.user,'supervisor') && <Phase2Report api={report.api} user={report.user} tip={tt.show} hide={tt.hide}/>}

  <div className="tileRow">
   <div className="tile"><small>ผู้มารับบริการวันนี้ (OPD + ER)</small><b>{today.total.toLocaleString()}<em> คน</em></b><span className="muted">ถึงเวลาที่เลือก</span></div>
   <div className="tile"><small>เวลาอยู่ใน รพ. (OPD) มัธยฐาน</small><b>{today.medianTime}<em> นาที</em></b><span className="muted">จาก {today.finished} คนที่กลับแล้ว</span></div>
   <div className="tile"><small>10% ที่นานที่สุด อยู่เกิน</small><b>{today.p90Time}<em> นาที</em></b><span className="muted">p90 ของเวลาทั้งหมด</span></div>
   <div className="tile"><small>คอขวดวันนี้</small><b className="tileText">{worst?stepText[worst].wait:'—'}</b><span className="muted">{worst?`รอเฉลี่ย ${today.stepWait[worst]} นาที`:'ยังไม่มีข้อมูล'}</span></div>
  </div>

  <div className="pageCols">
   <section className="panel">
    <div className="panelHead"><h3>เวลารอเฉลี่ยแต่ละขั้น · วันนี้</h3><small className="panelMeta">นาที</small></div>
    <div className="hbars">{steps.map(k=><div key={k} className="hbar" onMouseMove={e=>tt.show(e,<><b>{stepText[k].wait}</b><br/>เฉลี่ย {today.stepWait[k]} นาที · {today.stepCount[k]} ครั้ง</>)} onMouseLeave={tt.hide}>
     <span className="hbarLabel">{stepText[k].wait}</span>
     <span className="hbarTrack"><i style={{width:`${today.stepWait[k]!/maxStep*100}%`,background:SERIES.now}}/></span>
     <span className="hbarValue">{today.stepWait[k]}</span>
    </div>)}</div>
   </section>
   <section className="panel">
    <div className="panelHead"><h3>จำนวนผู้มาถึงรายชั่วโมง · สัปดาห์นี้</h3>
     <button className="linkBtn dark" onClick={()=>setAsTable(t=>!t)}><Table2 size={13}/> {asTable?'ดูเป็นแผนภาพ':'ดูเป็นตาราง'}</button></div>
    {asTable ? <div className="tableWrap"><table className="dataTable compact"><thead><tr><th>วัน</th>{STAT_HOURS.map(h=><th key={h} className="num">{h}</th>)}<th className="num">รวม</th></tr></thead>
      <tbody>{week.map(d=><tr key={d.name}><td>{d.name}</td>{d.arrivals.map((v,i)=><td key={i} className="num">{v}</td>)}<td className="num"><b>{d.total}</b></td></tr>)}</tbody></table></div>
    : <><div className="heatmap" style={{gridTemplateColumns:`72px repeat(${STAT_HOURS.length},1fr)`}}>
      <span/>{STAT_HOURS.map(h=><span key={h} className="hmHour">{h%2===0?String(h).padStart(2,'0'):''}</span>)}
      {week.map(d=><HeatRow key={d.name} d={d} max={heatMax} tt={tt}/>)}
     </div>
     <div className="rampLegend"><span>น้อย</span>{RAMP.map(c=><i key={c} style={{background:c}}/>)}<span>มาก (สูงสุด {heatMax} คน/ชม.)</span></div></>}
    <p className="note">ข้อมูลจำลอง 7 วัน · ใช้ดูว่าควรกระจายนัดไปช่วงเวลาไหน</p>
   </section>
  </div>

  <WhatIf tt={tt}/>
  {tt.el}
 </div>;
}

function HeatRow({d,max,tt}:{d:DaySummary;max:number;tt:ReturnType<typeof useTooltip>}) {
 return <><span className="hmDay">{d.name}</span>{d.arrivals.map((v,i)=><span key={i} className="hmCell" style={{background:rampColor(v,max)}}
  onMouseMove={e=>tt.show(e,<><b>{d.name} {String(STAT_HOURS[i]).padStart(2,'0')}:00–{String(STAT_HOURS[i]+1).padStart(2,'0')}:00</b><br/>มาถึง {v} คน</>)} onMouseLeave={tt.hide}/>)}</>;
}

// Replays today's patients with different staffing and compares against the current staffing.
const CAP_KEYS = Object.keys(capacityText) as CapacityKey[];
function WhatIf({tt}:{tt:ReturnType<typeof useTooltip>}) {
 const clinics = opdClinics(); // cached per layout revision
 const [cap,setCap] = useState<Capacity>(DEFAULT_CAPACITY);
 const [clinic,setClinic] = useState(clinics[0]?.key ?? '');
 const base = useMemo(()=>runScenario(DEFAULT_CAPACITY),[]);
 const sim = useMemo(()=>runScenario(cap),[cap]);
 const changed = JSON.stringify(cap)!==JSON.stringify(DEFAULT_CAPACITY);
 const bump = (k:CapacityKey, d:number) => setCap(c=>({...c,[k]:Math.max(1,Math.min(12,c[k]+d))}));
 const extra = cap.extraRooms[clinic] ?? 0;
 const setExtra = (n:number) => setCap(c=>({...c,extraRooms:{...c.extraRooms,[clinic]:Math.max(0,Math.min(4,n))}}));
 const steps = STEP_ORDER.filter(k=>base.summary.stepWait[k]!==undefined);
 const max = Math.max(1,...steps.flatMap(k=>[base.summary.stepWait[k]!,sim.summary.stepWait[k] ?? 0]));
 const delta = (a:number, b:number) => b===a ? <span className="muted">เท่าเดิม</span> : <span className={b<a?'good':'bad'}>{b<a?'▼':'▲'} {Math.abs(b-a)}</span>;
 return <section className="panel">
  <div className="panelHead"><h3>จำลองสถานการณ์ (what-if) · ถ้าปรับจำนวนจุดบริการ</h3>
   <button className="linkBtn dark" disabled={!changed} onClick={()=>setCap(DEFAULT_CAPACITY)}><RotateCcw size={12}/> กลับค่าปัจจุบัน</button></div>
  <div className="whatIf">
   <div className="capList">
    {CAP_KEYS.map(k=><div key={k} className={'capRow'+(cap[k]!==DEFAULT_CAPACITY[k]?' changed':'')}><span>{capacityText[k]}</span>
     <button aria-label={`ลด${capacityText[k]}`} onClick={()=>bump(k,-1)}><Minus size={14}/></button><b>{cap[k]}</b><button aria-label={`เพิ่ม${capacityText[k]}`} onClick={()=>bump(k,1)}><Plus size={14}/></button></div>)}
    <div className={'capRow'+(extra?' changed':'')}><span>เปิดห้องตรวจเพิ่ม (08–16 น.)
     <select value={clinic} onChange={e=>setClinic(e.target.value)}>{clinics.map(c=><option key={c.key} value={c.key}>{c.dept} · ชั้น {c.level}</option>)}</select></span>
     <button aria-label="ลดห้องตรวจ" onClick={()=>setExtra(extra-1)}><Minus size={14}/></button><b>+{extra}</b><button aria-label="เพิ่มห้องตรวจ" onClick={()=>setExtra(extra+1)}><Plus size={14}/></button></div>
   </div>
   <div className="whatIfResult">
    <div className="tileRow small">
     <div className="tile"><small>เวลาอยู่ใน รพ. มัธยฐาน</small><b>{sim.summary.medianTime}<em> นาที</em></b>{delta(base.summary.medianTime,sim.summary.medianTime)}</div>
     <div className="tile"><small>p90</small><b>{sim.summary.p90Time}<em> นาที</em></b>{delta(base.summary.p90Time,sim.summary.p90Time)}</div>
     <div className="tile"><small>คนที่รอเกิน 45 นาทีในขั้นใดขั้นหนึ่ง</small><b>{sim.longWaiters}<em> คน</em></b>{delta(base.longWaiters,sim.longWaiters)}</div>
     <div className="tile"><small>ผู้ป่วย OPD คนสุดท้ายกลับ</small><b>{sim.lastOut}</b><span className="muted">ปัจจุบัน {base.lastOut}</span></div>
    </div>
    <div className="vizLegend"><span><i style={{background:SERIES.now}}/>ปัจจุบัน</span><span><i style={{background:SERIES.scenario}}/>ถ้าปรับตามที่เลือก</span><small className="muted">เวลารอเฉลี่ย (นาที)</small></div>
    <div className="hbars paired">{steps.map(k=>{ const a = base.summary.stepWait[k]!, b = sim.summary.stepWait[k] ?? 0;
     return <div key={k} className="hbar" onMouseMove={e=>tt.show(e,<><b>{stepText[k].wait}</b><br/>ปัจจุบัน {a} นาที → {b} นาที</>)} onMouseLeave={tt.hide}>
      <span className="hbarLabel">{stepText[k].wait}</span>
      <span className="hbarTrack pair"><i style={{width:`${a/max*100}%`,background:SERIES.now}}/><i style={{width:`${b/max*100}%`,background:SERIES.scenario}}/></span>
      <span className="hbarValue">{a}→{b}</span>
     </div>; })}</div>
    <p className="note">ใช้ผู้ป่วยชุดเดียวกันของวันนี้ (ข้อมูลจำลอง) จำลองคิวใหม่ตามจำนวนจุดบริการ · ห้องตรวจเดิมใช้ตารางเวรแพทย์ · ใช้ประกอบการตัดสินใจ ไม่ใช่การรับประกันผล</p>
   </div>
  </div>
 </section>;
}
