'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Accessibility, Activity, ArrowRightLeft, BrainCircuit, CalendarClock, Check, Copy, MessageCircle, RefreshCw, ShieldCheck, Sparkles, TriangleAlert, Coffee } from 'lucide-react';
import { fmtMin, patientAt, type Patient } from '../../lib/patients';
import { PORTER_TOPIC, helpRequests, porters, type AssistView, type QueueCommand, type QueueEvent } from '../../lib/queue';
import { adviseStaffing, anomalies, forecast, handover, type AdviceKind, type FcPoint } from '../../lib/forecast';

// AI command centre: forecast, staffing advice, anomalies, porter jobs and the shift handover — all computed from
// counts per service and staff button presses. No patient is identified anywhere on this page.
type Control = {events:QueueEvent[]; send:(c:QueueCommand)=>Promise<{ok:boolean;reason?:string}>; canAct:boolean};
const adviceIcon:Record<AdviceKind,typeof Sparkles> = {reassign:ArrowRightLeft,break:Coffee,notify:MessageCircle,plan:CalendarClock};
const loadPref = (k:string, d:string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };

// liveData: `base` is the simulated usual day (no real history yet); it is scaled to today's real arrivals and said so.
export default function CommandPage({base,patients,minute,queue,assist,timeNote,liveData=false}:{base:Patient[];patients:Patient[];minute:number;queue:Control;assist:AssistView;timeNote:string;liveData?:boolean}) {
 const m = Math.floor(minute);
 const scale = useMemo(()=>{ if (!liveData) return 1; const came = (ps:Patient[]) => ps.filter(p=>p.flow!=='ipd' && p.arrival<=m).length;
  return (came(patients)+3)/(came(base)+3); },[liveData,base,patients,m]);
 const fc = useMemo(()=>forecast(base,patients,m,undefined,undefined,undefined,undefined,undefined,undefined,scale),[base,patients,m,scale]);
 const advice = useMemo(()=>adviseStaffing(base,patients,m,fc),[base,patients,m,fc]);
 const found = useMemo(()=>anomalies(fc,assist,queue.events),[fc,assist,queue.events]);
 const [ack,setAck] = useState<Set<string>>(new Set());
 const nowTotal = fc.total.find(p=>p.t===m), peak = fc.total.filter(p=>p.t>m).reduce((a,p)=>(p.fc ?? 0)>(a?.fc ?? -1)?p:a,undefined as FcPoint|undefined);
 const jobs = helpRequests(queue.events).filter(h=>h.report.reason===PORTER_TOPIC && !h.closed);
 return <div className="page cmdPage">
  <header className="cmdHero">
   <div className="cmdTitle"><span className="cmdOrb"><BrainCircuit size={22}/></span><div><h2>ศูนย์อัจฉริยะ</h2><p>คาดการณ์ · แนะนำ · เฝ้าระวัง · ส่งเวร — {timeNote}</p></div>
    <span className="cmdPrivacy" title="ทุกการคำนวณบนหน้านี้ใช้จำนวนรวมต่อจุดบริการและเวลา ไม่มีชื่อ HN หรือข้อมูลการรักษา"><ShieldCheck size={15}/> ใช้ข้อมูลรวมเท่านั้น · ไม่มีข้อมูลรายบุคคล</span></div>
   <div className="cmdKpis">
    <Kpi label="รออยู่ตอนนี้" value={Math.round(nowTotal?.actual ?? 0)} unit="คน" sub={`ปกติช่วงนี้ ~${Math.round(nowTotal?.plan ?? 0)}`} trend={(nowTotal?.actual ?? 0)-(nowTotal?.plan ?? 0)}/>
    <Kpi label="คาดสูงสุด 3 ชม." value={peak ? `${Math.round(peak.lo ?? 0)}–${Math.round(peak.hi ?? 0)}` : '–'} unit="คน" sub={peak ? `ช่วง ${fmtMin(peak.t)} น.` : ''}/>
    <Kpi label="จุดที่ต้องดู" value={found.length} unit="เรื่อง" sub={found[0]?.title ?? 'ทุกอย่างปกติ'} tone={found.some(f=>f.level==='critical')?'bad':found.length?'warn':'ok'}/>
    <Kpi label="งานผู้ช่วย/เปลค้าง" value={jobs.length} unit="งาน" sub={`${porters.length-new Set(jobs.filter(j=>j.assigned).map(j=>j.assigned!.reason)).size} คนว่าง`} tone={jobs.some(j=>!j.assigned)?'warn':'ok'}/>
   </div>
  </header>

  <div className="cmdGrid">
   <section className="cmdCard span2">
    <div className="cmdHead"><h3><Activity size={16}/> คนรอทั้งโรงพยาบาล · ย้อนหลัง 2 ชม. และคาดการณ์ 3 ชม.</h3>
     <span className="cmdLegend"><i className="lgActual"/>จริง<i className="lgFc"/>คาดการณ์<i className="lgBand"/>ช่วงที่น่าจะเป็น<i className="lgPlan"/>ปกติของวันนี้</span></div>
    <FcChart points={fc.total} now={m} height={260}/>
    <p className="cmdNote">คาดการณ์จากรูปแบบปกติของวัน ปรับตามสถานการณ์จริงตอนนี้ · ยิ่งไกลยิ่งไม่แน่นอน (ช่วงกว้างขึ้น)
     {liveData && <><br/>ผู้ป่วยจริง: เส้น "ปกติของวันนี้" ยังมาจากแบบจำลอง ย่อ/ขยายตามจำนวนผู้ป่วยที่มาจริงวันนี้ (×{scale.toFixed(2)}) · จะแทนด้วยประวัติจริงเมื่อเก็บข้อมูลได้หลายสัปดาห์</>}</p>
   </section>

   <section className="cmdCard">
    <div className="cmdHead"><h3><Sparkles size={16}/> AI แนะนำ</h3><small>ใช้คนและอุปกรณ์ที่มีอยู่</small></div>
    {advice.length ? <ul className="adviceList">{advice.map(a=>{ const I = adviceIcon[a.kind];
     return <li key={a.id} className={a.kind+(ack.has(a.id)?' acked':'')}>
      <span className="advIcon"><I size={15}/></span>
      <div><b>{a.title}</b><small>{a.why}</small><span className="advHow">{a.how}</span>
       <span className="advTags">{a.tags.map(t=><em key={t} className={t==='เชิงนโยบาย'||t==='ไม่ต้องทำวันนี้'?'pol':t==='ต้นทุนต่ำ'||t==='ข้อความ LINE'?'low':'free'}>{t}</em>)}<em className={'conf c'+a.confidence}>มั่นใจ{a.confidence}</em></span></div>
      <button className="btn sm ghost" onClick={()=>setAck(s=>new Set(s).add(a.id))} disabled={ack.has(a.id)}>{ack.has(a.id)?<><Check size={13}/> รับทราบ</>:'รับทราบ'}</button></li>; })}</ul>
     : <p className="cmdEmpty">ไม่มีจุดที่ต้องปรับใน 2 ชั่วโมงข้างหน้า</p>}
    <p className="cmdNote">ไม่แนะนำการเพิ่มคนหรือเปิดจุดใหม่ · ระบบเสนอเฉพาะการจัดสรรคนที่ทำงานแทนกันได้ เวลาพัก และการแจ้งผู้ป่วย</p>
   </section>

   <section className="cmdCard span3">
    <div className="cmdHead"><h3>รายจุดบริการ</h3><small>เรียงตามที่คาดว่าจะหนาแน่นที่สุด · ↑ มากกว่าปกติ</small></div>
    <div className="svcGrid">{fc.services.slice(0,8).map(s=><div key={s.key} className={'svcCard'+(s.ratio>=1.5?' hot':s.ratio<=0.7?' cool':'')}>
     <div className="svcTop"><b>{s.name}</b><span className="svcRatio">{s.ratio>=1.15?`↑${Math.round((s.ratio-1)*100)}%`:s.ratio<=0.85?`↓${Math.round((1-s.ratio)*100)}%`:'ปกติ'}</span></div>
     <div className="svcNums"><span><b>{s.now}</b> รออยู่</span><span>สูงสุด ~<b>{Math.round(s.peak)}</b> ช่วง {fmtMin(s.peakAt)}</span><span>{s.servers} จุดเปิด</span></div>
     <FcChart points={s.points} now={m} height={70} mini/>
    </div>)}</div>
   </section>

   <section className="cmdCard">
    <div className="cmdHead"><h3><TriangleAlert size={16}/> เฝ้าระวังแบบเรียลไทม์</h3><small>{found.length} เรื่อง</small></div>
    {found.length ? <ul className="anomList">{found.slice(0,8).map((a,i)=><li key={i} className={a.level}><i className="pulse"/><div><b>{a.title}</b><small>{a.detail}</small></div></li>)}</ul>
     : <p className="cmdEmpty">ไม่พบความผิดปกติ</p>}
   </section>

   <PorterBoard jobs={jobs} patients={patients} m={m} queue={queue}/>

   <Handover fc={fc} patients={patients} advice={advice} found={found}/>
  </div>
 </div>;
}

function Kpi({label,value,unit,sub,trend,tone}:{label:string;value:number|string;unit:string;sub:string;trend?:number;tone?:'ok'|'warn'|'bad'}) {
 return <div className={'cmdKpi'+(tone?' '+tone:'')}><small>{label}</small><b>{value}<em>{unit}</em></b>
  <span>{trend!==undefined && Math.abs(trend)>=1 && <i className={trend>0?'up':'down'}>{trend>0?'▲':'▼'} {Math.abs(Math.round(trend))}</i>}{sub}</span></div>;
}

// Actual (solid line over a soft area), forecast (dashed) inside its likely range (band), the usual day (thin grey).
// Drawn at the element's real pixel size so text never stretches; hover for values.
function useSize<T extends HTMLElement>() {
 const ref = useRef<T>(null); const [size,setSize] = useState({w:0,h:0});
 useEffect(()=>{ const el = ref.current; if (!el) return; const ro = new ResizeObserver(([e])=>setSize({w:Math.round(e.contentRect.width),h:Math.round(e.contentRect.height)})); ro.observe(el); return ()=>ro.disconnect(); },[]);
 return [ref,size] as const;
}
const niceMax = (v:number) => { const step = v<=20?5:v<=60?10:v<=150?25:50; return Math.max(step,Math.ceil(v/step)*step); };
export function FcChart({points,now,height,mini}:{points:FcPoint[];now:number;height:number;mini?:boolean}) {
 const [box,size] = useSize<HTMLDivElement>();
 const [hover,setHover] = useState<FcPoint|null>(null);
 const W = Math.max(120,size.w), H = Math.max(height,mini?height:size.h || height);
 const padL = mini?2:40, padR = mini?2:14, padT = mini?6:26, padB = mini?4:28;
 const t0 = points[0]?.t ?? 0, t1 = points.at(-1)?.t ?? 1, max = niceMax(Math.max(4,...points.map(p=>Math.max(p.hi ?? 0,p.actual ?? 0,p.plan))));
 const x = (t:number) => padL+(t-t0)/Math.max(1,t1-t0)*(W-padL-padR), y = (v:number) => padT+(1-v/max)*(H-padT-padB);
 // Smooth path (monotone-ish cubic) so the lines read as trends, not zig-zags.
 const smooth = (pts:[number,number][]) => pts.map((p,i)=>{ const X = x(p[0]), Y = y(p[1]); if (!i) return `M${X},${Y}`; const q = pts[i-1], qx = x(q[0]), qy = y(q[1]), mx = (qx+X)/2; return `C${mx},${qy} ${mx},${Y} ${X},${Y}`; }).join('');
 const act = points.filter(p=>p.actual!==undefined), fut = points.filter(p=>p.fc!==undefined);
 const actPath = act.length>1 ? smooth(act.map(p=>[p.t,p.actual!])) : '';
 const actArea = actPath ? `${actPath}L${x(act.at(-1)!.t)},${y(0)}L${x(act[0].t)},${y(0)}Z` : '';
 const band = fut.length>1 ? `${smooth(fut.map(p=>[p.t,p.hi!]))}L${fut.slice().reverse().map(p=>`${x(p.t)},${y(p.lo!)}`).join('L')}Z` : '';
 const peak = fut.filter(p=>p.t>now).reduce((a,p)=>(p.fc ?? 0)>(a?.fc ?? -1)?p:a,undefined as FcPoint|undefined);
 const yTicks = mini ? [] : [0,max/2,max];
 const xTicks = mini ? [] : points.filter(p=>p.t%60===0);
 const gid = useMemo(()=>`g${Math.random().toString(36).slice(2,8)}`,[]);
 const onMove = (e:React.MouseEvent) => { const r = box.current?.getBoundingClientRect(); if (!r) return; const t = t0+(e.clientX-r.left-padL)/(W-padL-padR)*(t1-t0);
  setHover(points.reduce((a,p)=>Math.abs(p.t-t)<Math.abs(a.t-t)?p:a,points[0])); };
 return <div ref={box} className={'fcChart'+(mini?' mini':'')} style={mini?{height}:{minHeight:height}} onMouseMove={onMove} onMouseLeave={()=>setHover(null)}>
  {size.w>0 && <svg width={W} height={H} role="img" aria-label="กราฟคนรอและคาดการณ์">
   <defs>
    <linearGradient id={`${gid}a`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2a78d6" stopOpacity=".28"/><stop offset="1" stopColor="#2a78d6" stopOpacity="0"/></linearGradient>
    <linearGradient id={`${gid}b`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#7c3aed" stopOpacity=".22"/><stop offset="1" stopColor="#7c3aed" stopOpacity=".06"/></linearGradient>
   </defs>
   {!mini && <rect x={x(now)} y={padT} width={Math.max(0,W-padR-x(now))} height={H-padT-padB} className="future"/>}
   {yTicks.map(v=><g key={v}><line x1={padL} x2={W-padR} y1={y(v)} y2={y(v)} className="grid"/><text x={padL-8} y={y(v)+4} className="axis" textAnchor="end">{Math.round(v)}</text></g>)}
   {xTicks.map(p=><text key={p.t} x={x(p.t)} y={H-8} className="axis" textAnchor="middle">{fmtMin(p.t)}</text>)}
   <path d={smooth(points.map(p=>[p.t,p.plan]))} className="plan"/>
   {band && <path d={band} fill={`url(#${gid}b)`}/>}
   {actArea && <path d={actArea} fill={`url(#${gid}a)`}/>}
   {fut.length>1 && <path d={smooth(fut.map(p=>[p.t,p.fc!]))} className="fc"/>}
   {actPath && <path d={actPath} className="actual"/>}
   <line x1={x(now)} x2={x(now)} y1={padT-2} y2={H-padB} className="nowLine"/>
   {act.length>0 && <circle cx={x(act.at(-1)!.t)} cy={y(act.at(-1)!.actual!)} r={mini?3:5} className="nowDot"/>}
   {!mini && <g transform={`translate(${x(now)},${padT-14})`}><rect x={-26} y={-9} width={52} height={18} rx={9} className="nowPill"/><text y={4} textAnchor="middle" className="nowText">ตอนนี้</text></g>}
   {!mini && peak && (peak.fc ?? 0)>0 && <g transform={`translate(${x(peak.t)},${y(peak.fc!)})`}><circle r={4.5} className="peakDot"/>
    <text y={-12} textAnchor="middle" className="peakText">สูงสุด ~{Math.round(peak.fc!)} · {fmtMin(peak.t)}</text></g>}
   {hover && <><line x1={x(hover.t)} x2={x(hover.t)} y1={padT} y2={H-padB} className="cross"/><circle cx={x(hover.t)} cy={y(hover.actual ?? hover.fc ?? hover.plan)} r={mini?3:4.5} className="dot"/></>}
  </svg>}
  {hover && <div className="fcTip" style={{left:Math.min(W-150,Math.max(4,x(hover.t)+10))}}><b>{fmtMin(hover.t)} น.</b>
   {hover.actual!==undefined && <span>จริง {Math.round(hover.actual)} คน</span>}
   {hover.fc!==undefined && hover.t>now && <span>คาด {Math.round(hover.lo!)}–{Math.round(hover.hi!)} คน</span>}
   <span className="muted">ปกติ {Math.round(hover.plan)} คน</span></div>}
 </div>;
}

// Wheelchair / porter jobs from patients' "need help" requests. Suggests the free porter nearest to the patient's floor.
function PorterBoard({jobs,patients,m,queue}:{jobs:ReturnType<typeof helpRequests>;patients:Patient[];m:number;queue:Control}) {
 const busy = new Map(jobs.filter(j=>j.assigned).map(j=>[j.assigned!.reason!.slice(7),j]));
 const free = porters.filter(p=>!busy.has(p.name));
 const where = (id?:string) => { const p = patients.find(x=>x.id===id), s = p ? patientAt(p,m) : null; return s ? {b:s.area.buildingId,level:s.area.level,text:s.step.place.where} : undefined; };
 const nearest = (b?:string, level?:number) => [...free].sort((a,c)=>((a.buildingId===b?0:2)+(a.level===level?0:1))-((c.buildingId===b?0:2)+(c.level===level?0:1)))[0];
 const by = () => loadPref('hdt.operator','') || undefined;
 const assign = (j:typeof jobs[number], name:string) => queue.send({action:'resolve',at:m,station:'porter',patientId:j.report.patientId,step:j.report.step,target:j.report.id,reason:`assign:${name}`,by:by()});
 const finish = (j:typeof jobs[number]) => queue.send({action:'resolve',at:m,station:'porter',patientId:j.report.patientId,step:j.report.step,target:j.report.id,reason:'done',by:by()});
 const waiting = jobs.filter(j=>!j.assigned), going = jobs.filter(j=>j.assigned);
 return <section className="cmdCard">
  <div className="cmdHead"><h3><Accessibility size={16}/> งานผู้ช่วย / เปล</h3><small>ผู้ป่วยขอจากหน้าคิวของตัวเอง</small></div>
  <div className="porterRoster">{porters.map(p=><span key={p.id} className={busy.has(p.name)?'busy':'free'}><i/>{p.name}<small>{busy.has(p.name)?'ติดงาน':'ว่าง'}</small></span>)}</div>
  {!jobs.length && <p className="cmdEmpty">ไม่มีงานค้าง · เมื่อผู้ป่วยกด "ต้องการรถเข็น / ผู้ช่วย" งานจะขึ้นที่นี่</p>}
  {waiting.map(j=>{ const w = where(j.report.patientId), n = nearest(w?.b,w?.level);
   return <div key={j.report.id} className="job new"><div><b>รอมอบหมาย · {fmtMin(j.report.at)}</b><small>{w?.text ?? '—'} · รอ {Math.max(0,m-j.report.at)} นาที</small></div>
    {n ? <button className="btn sm" disabled={!queue.canAct} onClick={()=>void assign(j,n.name)}>ส่ง {n.name}</button> : <span className="muted">ไม่มีคนว่าง</span>}</div>; })}
  {going.map(j=>{ const w = where(j.report.patientId);
   return <div key={j.report.id} className="job go"><div><b>{j.assigned!.reason!.slice(7)} กำลังไป</b><small>{w?.text ?? '—'} · มอบหมาย {fmtMin(j.assigned!.at)}</small></div>
    <button className="btn sm ghost" disabled={!queue.canAct} onClick={()=>void finish(j)}>เสร็จแล้ว</button></div>; })}
 </section>;
}

// Shift handover written from the aggregates, typed out like an assistant; copy it into LINE or the handover book.
function Handover({fc,patients,advice,found}:{fc:ReturnType<typeof forecast>;patients:Patient[];advice:ReturnType<typeof adviseStaffing>;found:ReturnType<typeof anomalies>}) {
 const [span,setSpan] = useState(240);
 const [seed,setSeed] = useState(0);
 const [shown,setShown] = useState(0);
 const [copied,setCopied] = useState(false);
 const sections = useMemo(()=>handover(fc,patients,advice,found,Math.max(0,fc.minute-span)),[fc,patients,advice,found,span,seed]); // eslint-disable-line react-hooks/exhaustive-deps
 const text = sections.map(s=>`■ ${s.title}\n${s.lines.map(l=>`• ${l}`).join('\n')}`).join('\n\n');
 useEffect(()=>{ setShown(0); },[seed,span]);
 useEffect(()=>{ if (shown>=text.length) return; const t = setTimeout(()=>setShown(n=>Math.min(text.length,n+6)),16); return ()=>clearTimeout(t); },[shown,text.length]);
 return <section className="cmdCard span3 handover">
  <div className="cmdHead"><h3><Sparkles size={16}/> สรุปส่งเวรอัตโนมัติ</h3>
   <div className="chipRow">{[[120,'2 ชม.'],[240,'4 ชม.'],[480,'8 ชม.']].map(([v,l])=><button key={v} className={'chip'+(span===v?' on':'')} onClick={()=>setSpan(v as number)}>{l}</button>)}
    <button className="btn sm ghost" onClick={()=>setSeed(s=>s+1)}><RefreshCw size={13}/> สร้างใหม่</button>
    <button className="btn sm" onClick={()=>{ void navigator.clipboard?.writeText(text).then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),2000); }); }}><Copy size={13}/> {copied?'คัดลอกแล้ว':'คัดลอก'}</button></div></div>
  <pre className="handoverText">{text.slice(0,shown)}{shown<text.length && <span className="caret"/>}</pre>
  <p className="cmdNote">เขียนจากตัวเลขรวมของระบบ ไม่มีชื่อหรือเลขคิวผู้ป่วย · ตรวจทานก่อนส่งต่อ</p>
 </section>;
}
