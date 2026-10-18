'use client';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Activity, AlertTriangle, BedDouble, Building2, CalendarCheck, Clock, Gauge, Hourglass, LayoutDashboard, ListChecks, MonitorSmartphone, Server, Siren, Stethoscope, Table2, Users } from 'lucide-react';
import { LONG_WAIT, kioskAt, patientAt, stepText, triageLevels, type Patient, type PatientState, type StepKind } from '../../lib/patients';
import { PORTER_TOPIC, allStations, healthText, helpRequests, openReports, stationDoctor, type AssistView, type CapLevel, type KioskHelp, type QueueEvent, type QueueSync } from '../../lib/queue';
import { kiosks, kioskStatusLabel } from '../../lib/scene-data';
import type { LiveStatus } from '../../lib/live-feed';
import { forecast, serviceKeyOf, serviceName, serviceStations } from '../../lib/forecast';
import { STEP_ORDER, bedBoard, erBoard, type Alert } from '../../lib/ops';
import { buildingShort } from '../../lib/facility';
import { FcChart } from './CommandPage';
import { useTooltip } from './StatsPage';
import { PageGuide } from './PageGuide';

// แดชบอร์ด: the whole hospital on one page, live, without the map — how many are in, waiting and for how long; which
// queues are near or over their cap; stations and doctors; the day's trend and forecast; per service, per step, per
// floor; ER and beds; who has waited longest; what needs someone now. Charts carry a legend and a table view.
// Everything is recomputed from the same patients, queue log and assistant the other pages use.
type Go = (nav:string) => void;
// What only the server knows (dashboard:summary) — counts, no patient.
type RKiosk = {id:string; name:string; place?:string; lastSeenAt?:string; online:boolean; helpPending:boolean; sessionsToday:number; handoffsToday:number};
type Summary = {reception:{enabled:boolean; kiosks:RKiosk[]}; appointments:{enabled:boolean; total:number; confirmed:number; checkedIn:number; noShow:number; cancelled:number; movesPending:number};
  bookings:{enabled:boolean; total:number; confirmed:number; checkedIn:number; expired:number; cancelled:number}; messages:{enabled:boolean; waiting:number; failed24h:number}; visits:{active:number; cancelled:number}};
// sys: the state of the system itself — this screen's link to the central server, the HIS feed, the test clock.
export type BoardSys = {online:boolean; api?:QueueSync['api']; feed:LiveStatus; feedSource?:string; testing:boolean; kioskHelp:KioskHelp[]};
function useSummary(api:QueueSync['api']|undefined, online:boolean, minute:number) {
  const [sum,setSum] = useState<Summary|null>(null);
  const load = useCallback(async ()=>{ if (!api || !online) { setSum(null); return; } const r = await api<{ok:boolean} & Summary>('dashboard:summary',{}); if (r.ok) setSum(r); },[api,online]);
  useEffect(()=>{ void load(); },[load,minute]); // every minute, with the rest of the page
  return sum;
}
const ago = (iso?:string) => { if (!iso) return 'ยังไม่เคยเชื่อมต่อ'; const m = Math.round((Date.now()-new Date(iso).getTime())/60000); return m<1 ? 'เมื่อสักครู่' : m<60 ? `${m} นาทีที่แล้ว` : m<1440 ? `${Math.floor(m/60)} ชม.ที่แล้ว` : `${Math.floor(m/1440)} วันที่แล้ว`; };
const HEALTH_ORDER = ['ok','slow','stalled','paused','away','auto'] as const;
const HEALTH_COLOR:Record<string,string> = {ok:'#16a34a',slow:'#d97706',stalled:'#ea580c',paused:'#7c3aed',away:'#94a3b8',auto:'#cbd5e1'};
const CAP_COLOR = {over:'#c92a2a',near:'#d97706',ok:'#2a78d6'};
const CAP_TEXT = {over:'เกินเพดาน',near:'ใกล้เพดาน',ok:'ปกติ'};
const WAIT = '#2a78d6', SERVE = '#9ec5f4';
const RAMP = ['#eef2f6','#cde2fb','#9ec5f4','#6da7ec','#3987e5','#256abf','#184f95'];
const hText = (h:string, live:boolean) => h==='auto' ? (live ? 'ยังไม่เปิดช่อง' : 'ตัวจำลองดูแล') : healthText[h as keyof typeof healthText];
const avg = (l:number[]) => l.length ? Math.round(l.reduce((a,b)=>a+b,0)/l.length) : 0;

export default function OverviewBoard({patients,base,liveData,minute,assist,events,alerts,acked,timeNote,onOpenPatient,go,sys}:{patients:Patient[]; base:Patient[]; liveData:boolean; minute:number;
  assist:AssistView; events:QueueEvent[]; alerts:Alert[]; acked:(id:string)=>boolean; timeNote:string; onOpenPatient:(id:string)=>void; go:Go; sys:BoardSys}) {
  const m = Math.floor(minute);
  const sum = useSummary(sys.api,sys.online,m);
  const tt = useTooltip();
  // Who is in (OPD + ER; inpatients are counted with the beds), waiting or being seen.
  const d = useMemo(()=>{
    const now = patients.map(p=>patientAt(p,m)).filter((s):s is PatientState=>!!s && s.p.flow!=='ipd' && s.status!=='done' && s.step.kind!=='leave');
    const waiting = now.filter(s=>m<s.step.called && s.step.kind!=='kiosk'), serving = now.filter(s=>m>=s.step.called);
    // Per service (a clinic, or a shared service such as the pharmacy).
    const svc = new Map<string,{key:string; name:string; waiting:number; serving:number; waits:number[]; longest:number}>();
    now.filter(s=>s.step.kind!=='kiosk').forEach(s=>{ const key = serviceKeyOf(s); const r = svc.get(key) ?? {key,name:serviceName(key),waiting:0,serving:0,waits:[],longest:0};
      if (m<s.step.called) { r.waiting++; r.waits.push(s.stepWait); r.longest = Math.max(r.longest,s.stepWait); } else r.serving++; svc.set(key,r); });
    const services = [...svc.values()].map(r=>({...r,avgWait:avg(r.waits),longest:Math.round(r.longest),servers:serviceStations(r.key,m).length})).sort((a,b)=>b.waiting-a.waiting || b.serving-a.serving);
    // Per step of the journey.
    const steps = STEP_ORDER.map(k=>({k,waiting:waiting.filter(s=>s.step.kind===k).length,serving:serving.filter(s=>s.step.kind===k).length})).filter(x=>x.waiting+x.serving>0);
    // Per building and floor (where they are now).
    const floors = new Map<string,number>(); now.forEach(s=>{ const k = `${s.step.place.buildingId}:${s.step.place.level}`; floors.set(k,(floors.get(k) ?? 0)+1); });
    return {now,waiting,serving,services,steps,floors,er:erBoard(patients,m),beds:bedBoard(patients,m)};
  },[patients,m]);
  const scale = useMemo(()=>{ if (!liveData) return 1; const came = (ps:Patient[]) => ps.filter(p=>p.flow!=='ipd' && p.arrival<=m).length; return (came(patients)+3)/(came(base)+3); },[liveData,base,patients,m]);
  const fc = useMemo(()=>forecast(base,patients,m,undefined,undefined,undefined,undefined,undefined,undefined,scale),[base,patients,m,scale]);
  // Stations: health, doctors in their rooms, queues against caps.
  const stations = allStations();
  const health = HEALTH_ORDER.map(h=>({h,n:stations.filter(st=>assist.health.get(st.id)?.state===h).length})).filter(x=>x.n);
  const rooms = stations.filter(st=>st.roomId), docs = rooms.map(st=>stationDoctor(st,m)?.status);
  const caps = [...assist.caps].sort((a,b)=>b.load/b.cap-a.load/a.cap);
  const over = caps.filter(c=>c.level==='over'), near = caps.filter(c=>c.level==='near');
  const problems = stations.filter(st=>{ const s = assist.health.get(st.id)?.state; return s==='slow' || s==='stalled' || s==='paused'; });
  const open = alerts.filter(a=>!acked(a.id)), helps = openReports(events);
  const long = d.waiting.filter(s=>s.stepWait>LONG_WAIT);
  const longest = [...d.waiting].sort((a,b)=>b.stepWait-a.stepWait).slice(0,8);
  const bedTotal = d.beds.beds.length, bedFree = d.beds.beds.filter(b=>b.state==='free').length;
  const erOver = d.er.rows.filter(r=>r.overTarget).length;
  const nowTotal = fc.total.find(p=>p.t===m);
  // Kiosks: the queue-ticket / check-in kiosks of the facility, and the Digital Reception kiosks (devices).
  const tk = kiosks.map(k=>({...k,...kioskAt(patients,k.id,m)}));
  const rk = sum?.reception.enabled ? sum.reception.kiosks : [];
  const kioskDown = tk.filter(k=>k.status!=='online').length+rk.filter(k=>!k.online).length, kioskAll = tk.length+rk.length;
  const kioskCalls = sys.kioskHelp.length;
  const porterJobs = helpRequests(events).filter(h=>h.report.reason===PORTER_TOPIC && !h.closed && !h.assigned).length;
  const msgFailed = sum?.messages.enabled ? sum.messages.failed24h : 0;
  // Everything "ต้องดูตอนนี้" lists (the list itself shows the first few of each kind).
  const rkDown = rk.filter(k=>!k.online).length;
  const attn = over.length+assist.full.size+open.length+helps.length+problems.length+kioskCalls+porterJobs+rkDown+(msgFailed?1:0)+(sys.online?0:1);

  return <div className="page viz-root dashPage" ref={tt.host}>
    <div className="pageHead"><h2><LayoutDashboard size={20}/> แดชบอร์ดทั้งโรงพยาบาล</h2><span className="pageTime">{timeNote}</span>
      <small className="muted dashLive"><i/> อัปเดตเองทุกนาที</small></div>
    <PageGuide id="แดชบอร์ด"/>

    <div className="tileRow dashTiles">
      <Tile icon={Users} label="ในโรงพยาบาลตอนนี้" value={d.now.length} unit="คน" sub={`OPD ${d.now.filter(s=>s.p.flow==='opd').length} · ER ${d.now.filter(s=>s.p.flow==='er').length}`}/>
      <Tile icon={Hourglass} label="กำลังรอ" value={d.waiting.length} unit="คน" sub={`กำลังรับบริการ ${d.serving.length} · ปกติช่วงนี้ ~${Math.round(nowTotal?.plan ?? 0)}`}/>
      <Tile icon={Clock} label="รอเฉลี่ย (ขั้นปัจจุบัน)" value={avg(d.waiting.map(s=>s.stepWait))} unit="นาที" sub={`นานสุด ${Math.round(longest[0]?.stepWait ?? 0)} นาที`}/>
      <Tile icon={AlertTriangle} label={`รอเกิน ${LONG_WAIT} นาที`} value={long.length} unit="คน" tone={long.length ? 'warn' : 'ok'} sub={long.length ? 'ดูรายชื่อคิวด้านล่าง' : 'ไม่มี'}/>
      <Tile icon={Gauge} label="คิวเกินเพดาน" value={over.length} unit="จุด" tone={over.length ? 'bad' : near.length ? 'warn' : 'ok'} sub={`ใกล้เพดาน ${near.length} จุด`}/>
      <Tile icon={Activity} label="จุดบริการติดขัด" value={problems.length} unit="จุด" tone={problems.length ? 'warn' : 'ok'} sub={`เจ้าหน้าที่เปิดอยู่ ${stations.filter(st=>['ok','slow','stalled','paused'].includes(assist.health.get(st.id)?.state ?? '')).length} จาก ${stations.length} จุด`}/>
      <Tile icon={Stethoscope} label="แพทย์ออกตรวจ" value={`${docs.filter(x=>x==='active').length}/${rooms.length}`} unit="ห้อง" sub={`พัก ${docs.filter(x=>x==='break').length} ห้อง`}/>
      <Tile icon={BedDouble} label="เตียงว่าง (หอผู้ป่วย)" value={`${bedFree}/${bedTotal}`} unit="เตียง" tone={bedTotal && bedFree/bedTotal<0.1 ? 'warn' : 'ok'} sub={`ครองเตียง ${bedTotal ? Math.round((1-bedFree/bedTotal)*100) : 0}%`}/>
      <Tile icon={Siren} label="ER" value={d.er.rows.length} unit="คน" tone={erOver ? 'bad' : 'ok'} sub={erOver ? `รอเกินเป้า ${erOver} คน` : 'ไม่มีใครรอเกินเป้า'}/>
      <Tile icon={MonitorSmartphone} label="ตู้ Kiosk ใช้งานได้" value={`${kioskAll-kioskDown}/${kioskAll}`} unit="ตู้" tone={kioskCalls ? 'bad' : kioskDown ? 'warn' : 'ok'} sub={kioskCalls ? `ตู้เรียกเจ้าหน้าที่ ${kioskCalls} ตู้` : kioskDown ? `มีปัญหา ${kioskDown} ตู้` : 'ทุกตู้ปกติ'}/>
      <Tile icon={CalendarCheck} label="นัดแพทย์วันนี้" value={sum?.appointments.enabled ? `${sum.appointments.checkedIn}/${sum.appointments.total}` : '—'} unit={sum?.appointments.enabled ? 'มาแล้ว' : ''}
        sub={!sum ? (sys.online ? 'กำลังโหลด…' : 'ต้องเชื่อมต่อระบบกลาง') : !sum.appointments.enabled ? 'ระบบนัดปิดอยู่' : `ยังไม่มา ${sum.appointments.confirmed} · ไม่มาตามนัด ${sum.appointments.noShow}`}/>
      <Tile icon={ListChecks} label="เรื่องที่ต้องดู" value={attn} unit="เรื่อง" tone={kioskCalls || over.length || open.some(a=>a.severity==='critical') || !sys.online ? 'bad' : attn ? 'warn' : 'ok'}
        sub={[`แจ้งเตือน ${open.length}`,kioskCalls ? `ตู้เรียก ${kioskCalls}` : '',helps.length ? `ผู้ป่วยขอช่วย ${helps.length}` : '',over.length ? `เกินเพดาน ${over.length}` : ''].filter(Boolean).join(' · ')}/>
    </div>

    <div className="dashTop">
      <Panel title="คนรอทั้งโรงพยาบาล · ย้อนหลัง 2 ชม. และคาดการณ์ 3 ชม." icon={Activity}
        right={<span className="cmdLegend"><i className="lgActual"/>จริง<i className="lgFc"/>คาดการณ์<i className="lgBand"/>ช่วงที่น่าจะเป็น<i className="lgPlan"/>ปกติของวันนี้</span>}>
        <FcChart points={fc.total} now={m} height={230}/>
        <p className="note">{liveData && <>ผู้ป่วยจริง: เส้น "ปกติของวันนี้" ยังมาจากแบบจำลอง ปรับตามจำนวนที่มาจริงวันนี้ (×{scale.toFixed(2)}) · </>}
          <button className="linkBtn dark dashMore" onClick={()=>go('ศูนย์อัจฉริยะ')}>คาดการณ์รายจุดบริการและคำแนะนำ → ศูนย์อัจฉริยะ</button></p>
      </Panel>

      <Panel title="ต้องดูตอนนี้" icon={ListChecks} right={<button className="linkBtn dark" onClick={()=>go('การแจ้งเตือน')}>การแจ้งเตือนทั้งหมด</button>}>
        <ul className="dashAttn">
          {sys.kioskHelp.map(h=><li key={h.id} className="bad"><b>ตู้ต้อนรับเรียกเจ้าหน้าที่{h.reason==='emergency' ? ' (ฉุกเฉิน)' : ''}</b> {h.kioskName}{h.whereTh ? ` · ${h.whereTh}` : ''}</li>)}
          {over.slice(0,3).map(c=><li key={c.st.id} className="bad"><b>เกินเพดาน</b> {c.st.label} · รอ {c.load}/{c.cap}</li>)}
          {[...assist.full].map(g=><li key={g} className="bad"><b>คิวเต็ม</b> ทุกช่องของกลุ่มเกินเพดาน · {assist.caps.find(c=>c.st.group===g)?.st.section}</li>)}
          {open.slice(0,5).map(a=><li key={a.id} className={a.severity==='critical'?'bad':'warn'}><b>{a.title}</b> {a.detail}</li>)}
          {helps.length>0 && <li className="warn"><b>ผู้ป่วยขอความช่วยเหลือ {helps.length} เรื่อง</b> รับเรื่องที่หน้าติดตามคิว</li>}
          {porterJobs>0 && <li className="warn"><b>งานเปล/ผู้ช่วยยังไม่มีคนรับ {porterJobs} งาน</b> มอบหมายที่ศูนย์อัจฉริยะ</li>}
          {rk.filter(k=>!k.online).map(k=><li key={k.id} className="warn"><b>ตู้ต้อนรับออฟไลน์</b> {k.name} · ติดต่อล่าสุด {ago(k.lastSeenAt)}</li>)}
          {msgFailed>0 && <li className="warn"><b>ส่งข้อความ LINE ไม่สำเร็จ {msgFailed} รายการ (24 ชม.)</b> ดูที่ ตั้งค่า → การแจ้งเตือน</li>}
          {!sys.online && <li className="bad"><b>หน้าจอนี้ไม่ได้เชื่อมต่อระบบกลาง</b> ตัวเลขอาจไม่ใช่ล่าสุด</li>}
          {problems.slice(0,3).map(st=><li key={st.id} className="warn"><b>{healthText[assist.health.get(st.id)!.state]}</b> {st.label} · {assist.health.get(st.id)!.text}</li>)}
          {!over.length && !assist.full.size && !open.length && !helps.length && !problems.length && !kioskCalls && !porterJobs && !msgFailed && sys.online && !rk.some(k=>!k.online) && <li className="ok"><b>ทุกอย่างปกติ</b> ไม่มีเรื่องค้าง</li>}
        </ul>
        <button className="btn ghost sm dashGo" onClick={()=>go('ติดตามคิว')}>ไปหน้าติดตามคิว</button>
      </Panel>
    </div>

    <div className="dashGrid">

      <CapPanel caps={caps} tt={tt}/>

      <Panel title="สถานะจุดบริการ" icon={Activity} sub={`${stations.length} จุดที่เปิดใช้`}>
        <div className="dashStack" role="img" aria-label={health.map(x=>`${hText(x.h,liveData)} ${x.n}`).join(', ')}>
          {health.map(x=><i key={x.h} style={{flexGrow:x.n,background:HEALTH_COLOR[x.h]}} onMouseMove={e=>tt.show(e,<><b>{hText(x.h,liveData)}</b><br/>{x.n} จุด</>)} onMouseLeave={tt.hide}/>)}</div>
        <div className="dashLegendList">{health.map(x=><span key={x.h}><i style={{background:HEALTH_COLOR[x.h]}}/>{hText(x.h,liveData)}<b>{x.n}</b></span>)}</div>
        {problems.length>0 && <ul className="dashMini">{problems.slice(0,6).map(st=><li key={st.id}><i style={{background:HEALTH_COLOR[assist.health.get(st.id)!.state]}}/><b>{st.label}</b><span className="muted">{assist.health.get(st.id)!.text}</span></li>)}</ul>}
        <p className="note">"แพทย์ไม่อยู่" = ห้องตรวจที่ไม่มีแพทย์เข้าเวรตอนนี้ · {liveData ? '"ยังไม่เปิดช่อง" = ยังไม่มีเจ้าหน้าที่เปิดจุดบนหน้าจอ' : '"ตัวจำลองดูแล" = จุดที่ไม่มีเจ้าหน้าที่เปิดบนหน้าจอ ตัวจำลองเรียกคิวแทน'}</p>
      </Panel>

      <ServicesPanel rows={d.services} tt={tt}/>

      <Panel title="ผู้ป่วยในแต่ละขั้นตอน" icon={ListChecks} right={<span className="vizLegend inline"><span><i style={{background:WAIT}}/>รอ</span><span><i style={{background:SERVE}}/>กำลังรับบริการ</span></span>}>
        {(()=>{ const max = Math.max(1,...d.steps.map(x=>x.waiting+x.serving));
          return <div className="hbars">{d.steps.map(x=><div key={x.k} className="hbar" onMouseMove={e=>tt.show(e,<><b>{stepText[x.k as StepKind].serve}</b><br/>รอ {x.waiting} · กำลังรับบริการ {x.serving}</>)} onMouseLeave={tt.hide}>
            <span className="hbarLabel">{stepText[x.k as StepKind].serve}</span>
            <span className="dashSplit"><i style={{width:`${x.waiting/max*100}%`,background:WAIT}}/><i style={{width:`${x.serving/max*100}%`,background:SERVE}}/></span>
            <span className="hbarValue">{x.waiting+x.serving}</span></div>)}</div>; })()}
      </Panel>

      <FloorsPanel floors={d.floors} tt={tt}/>

      <Panel title="ห้องฉุกเฉิน · ตามระดับคัดแยก" icon={Siren} sub={`${d.er.rows.length} คน · รอเตียงหอผู้ป่วย ${d.er.boarding.length}`}>
        {(()=>{ const max = Math.max(1,...d.er.byLevel.map(l=>l.count));
          return <div className="hbars">{d.er.byLevel.map(l=><div key={l.level} className="hbar" onMouseMove={e=>tt.show(e,<><b>ระดับ {l.level} · {l.name}</b><br/>{l.count} คน · รอเกินเป้า ({l.target} นาที) {l.over} คน</>)} onMouseLeave={tt.hide}>
            <span className="hbarLabel">ระดับ {l.level} · {l.name}</span>
            <span className="hbarTrack"><i style={{width:`${l.count/max*100}%`,background:triageLevels[l.level-1].color}}/></span>
            <span className="hbarValue">{l.count}{l.over ? <em className="dashOver"> ({l.over} เกิน)</em> : null}</span></div>)}</div>; })()}
      </Panel>

      <Panel title="เตียงหอผู้ป่วย · รายชั้น" icon={BedDouble} sub={`ว่าง ${bedFree} จาก ${bedTotal} เตียง`}>
        <div className="hbars">{d.beds.floors.map(f=>{ const pct = Math.round(f.occupancy*100);
          return <div key={`${f.buildingId}:${f.level}`} className="hbar" onMouseMove={e=>tt.show(e,<><b>{buildingShort(f.buildingId)} ชั้น {f.level}</b><br/>ครอง {f.occupied} · ทำความสะอาด {f.cleaning} · ว่าง {f.free} · รอเข้า {f.waitingAdmit}</>)} onMouseLeave={tt.hide}>
            <span className="hbarLabel">{buildingShort(f.buildingId)} ชั้น {f.level}</span>
            <span className="dashGauge"><i style={{width:`${pct}%`,background:pct>=90?CAP_COLOR.over:pct>=80?CAP_COLOR.near:CAP_COLOR.ok}}/></span>
            <span className="hbarValue">{pct}%</span></div>; })}</div>
      </Panel>

      <KioskPanel tk={tk} rk={rk} enabled={!!sum?.reception.enabled} known={!!sum} calls={sys.kioskHelp} liveData={liveData}/>

      <TodayPanel sum={sum} online={sys.online}/>

      <Panel title="ระบบและการเชื่อมต่อ" icon={Server}>
        <ul className="dashSys">
          <li className={sys.online ? 'ok' : 'bad'}><b>ระบบกลาง</b>{sys.online ? 'เชื่อมต่ออยู่' : 'ไม่ได้เชื่อมต่อ — ตัวเลขบนหน้านี้อาจไม่ใช่ล่าสุด'}</li>
          <li className={sys.feed!=='live' ? (sys.feed==='connecting' ? 'warn' : 'bad') : sys.feedSource==='his-adapter' ? 'ok' : 'off'}><b>ข้อมูลจาก HIS</b>{sys.feed==='connecting' ? 'กำลังเชื่อมต่อ' : sys.feed!=='live' ? 'ไม่ได้รับข้อมูล' : sys.feedSource==='his-adapter' ? 'รับข้อมูลจาก HIS อยู่' : 'ยังไม่ได้เชื่อม HIS — ใช้ข้อมูลจำลอง'}</li>
          <li className={liveData ? 'ok' : 'warn'}><b>ข้อมูลผู้ป่วย</b>{liveData ? 'ผู้ป่วยจริง' : 'ข้อมูลจำลอง (สาธิต)'}</li>
          <li className={sys.testing ? 'warn' : 'ok'}><b>เวลา</b>{sys.testing ? 'โหมดทดสอบ — ไม่ใช่เวลาจริง' : 'เวลาจริง'}</li>
          {sum && <li className={!sum.messages.enabled ? 'off' : sum.messages.failed24h ? 'bad' : sum.messages.waiting>20 ? 'warn' : 'ok'}><b>ข้อความ LINE</b>{!sum.messages.enabled ? 'ปิดอยู่' : `รอส่ง ${sum.messages.waiting} · ไม่สำเร็จ 24 ชม. ${sum.messages.failed24h}`}</li>}
          {sum && liveData && <li className="ok"><b>รับผู้ป่วยวันนี้</b>{sum.visits.active} คน{sum.visits.cancelled ? ` · ยกเลิก ${sum.visits.cancelled}` : ''}</li>}
        </ul>
      </Panel>

      <Panel title="รอนานที่สุดตอนนี้" icon={Hourglass} sub="คลิกเพื่อดูบนแผนที่">
        {longest.length ? <table className="dataTable compact dashTable"><thead><tr><th>คิว</th><th>รอ</th><th>ที่</th><th className="num">นาที</th></tr></thead>
          <tbody>{longest.map(s=><tr key={s.p.id} className={s.stepWait>LONG_WAIT?'warnRow':''} tabIndex={0} onClick={()=>onOpenPatient(s.p.id)} onKeyDown={e=>{ if (e.key==='Enter') onOpenPatient(s.p.id); }}>
            <td><b>{s.p.queue}</b></td><td>{stepText[s.step.kind].wait}</td><td className="muted" title={s.step.place.where}>{s.step.place.where.replace(/^พื้นที่รอ\s*/,'')}</td><td className="num"><b>{Math.round(s.stepWait)}</b></td></tr>)}</tbody></table>
          : <p className="cmdEmpty">ไม่มีผู้ป่วยรอ</p>}
      </Panel>
    </div>
    {tt.el}
  </div>;
}

function Tile({icon:I,label,value,unit,sub,tone}:{icon:typeof Users; label:string; value:number|string; unit:string; sub:string; tone?:'ok'|'warn'|'bad'}) {
  return <div className={'tile dashTile'+(tone?' '+tone:'')}><small><I size={13}/> {label}</small><b>{value}{unit && <em> {unit}</em>}</b><span className="muted">{sub}</span></div>;
}
function Panel({title,icon:I,sub,right,children}:{title:string; icon:typeof Users; sub?:string; right?:ReactNode; children:ReactNode}) {
  return <section className="panel dashPanel">
    <div className="panelHead"><h3><I size={15}/> {title}</h3>{sub && <small className="panelMeta">{sub}</small>}{right}</div>
    {children}
  </section>;
}
type Tt = ReturnType<typeof useTooltip>;

// Every station's queue against its cap: the fullest first; graph or table; all or only those near / over.
function CapPanel({caps,tt}:{caps:CapLevel[]; tt:Tt}) {
  const [table,setTable] = useState(false), [all,setAll] = useState(false);
  // The fullest first (near / over always shown), at least six, so there is always something to compare with.
  const flagged = caps.filter(c=>c.level!=='ok'), shown = all ? caps : caps.slice(0,Math.max(6,flagged.length));
  const ratio = (c:CapLevel) => Math.round(c.load/c.cap*100);
  return <Panel title="เพดานคิว · ตรงไหนใกล้เต็ม" icon={Gauge} sub={`เกิน ${caps.filter(c=>c.level==='over').length} · ใกล้ ${caps.filter(c=>c.level==='near').length} · จาก ${caps.length} จุด`}
    right={<button className="linkBtn dark" onClick={()=>setTable(t=>!t)}><Table2 size={13}/> {table?'ดูเป็นกราฟ':'ดูเป็นตาราง'}</button>}>
    <div className="dashLegendList">{(['over','near','ok'] as const).map(k=><span key={k}><i style={{background:CAP_COLOR[k]}}/>{CAP_TEXT[k]}</span>)}<small className="muted">ใกล้ = ตั้งแต่ 80% ของเพดาน</small></div>
    {!caps.length ? <p className="cmdEmpty">ไม่มีจุดที่ตั้งเพดานไว้</p>
      : table ? <div className="tableWrap"><table className="dataTable compact"><thead><tr><th>จุดบริการ</th><th>แผนก</th><th className="num">รอ</th><th className="num">เพดาน</th><th className="num">%</th><th>สถานะ</th></tr></thead>
        <tbody>{shown.map(c=><tr key={c.st.id}><td><b>{c.st.label}</b></td><td className="muted">{c.st.section}</td><td className="num">{c.load}</td><td className="num">{c.cap}</td><td className="num">{ratio(c)}</td><td><span className={'dashChip '+c.level}>{CAP_TEXT[c.level]}</span></td></tr>)}</tbody></table></div>
      : <div className="hbars dashCaps">{shown.map(c=><div key={c.st.id} className="hbar" onMouseMove={e=>tt.show(e,<><b>{c.st.label}</b><br/>{c.st.section}<br/>รอ {c.load} · เพดาน {c.cap} ({ratio(c)}%) · {CAP_TEXT[c.level]}</>)} onMouseLeave={tt.hide}>
          <span className="hbarLabel">{c.st.label}</span>
          <span className="dashGauge"><i style={{width:`${Math.min(100,ratio(c))}%`,background:CAP_COLOR[c.level]}}/><em aria-hidden/></span>
          <span className="hbarValue">{c.load}/{c.cap}</span></div>)}</div>}
    {caps.length>shown.length || all ? <button className="linkBtn dark dashMore" onClick={()=>setAll(a=>!a)}>{all ? 'แสดงเฉพาะที่ใกล้/เกิน' : `ดูทั้งหมด ${caps.length} จุด`}</button> : null}
    <p className="note">เพดานไม่ได้ห้ามรับผู้ป่วย เป็นเกณฑ์ให้ตัวช่วยเกลี่ยคิวไปช่องอื่นในกลุ่มเดียวกัน · ปรับที่ ตั้งค่า → ตัวช่วยกระจายคิว / ปรับรายแผนก</p>
  </Panel>;
}

// Both kinds of kiosk. Queue-ticket kiosks: the line at each and tickets given out (paper / network state is demo data
// until the kiosks report it). Digital Reception kiosks: on when heard from in the last 12 minutes; calls for staff.
type TK = (typeof kiosks)[number] & {line:number; issuedHour:number; issuedToday:number};
function KioskPanel({tk,rk,enabled,known,calls,liveData}:{tk:TK[]; rk:RKiosk[]; enabled:boolean; known:boolean; calls:KioskHelp[]; liveData:boolean}) {
  const tone = (s:string) => s==='online' ? 'ok' : s==='offline' ? 'bad' : 'warn';
  return <Panel title="ตู้ Kiosk" icon={MonitorSmartphone} sub={`${tk.length+rk.length} ตู้`}>
    <h4 className="dashSub">ตู้ออกบัตรคิว / เช็กอิน</h4>
    {tk.length ? <table className="dataTable compact"><thead><tr><th>ตู้</th><th>สถานะ</th><th className="num">ต่อแถว</th><th className="num">บัตร ชม.นี้</th><th className="num">วันนี้</th></tr></thead>
      <tbody>{tk.map(k=><tr key={k.id}><td><b>{k.name}</b></td><td><span className={'dashChip '+tone(k.status)}>{kioskStatusLabel[k.status]}</span></td><td className="num">{k.line}</td><td className="num">{k.issuedHour}</td><td className="num">{k.issuedToday}</td></tr>)}</tbody></table>
      : <p className="cmdEmpty">ไม่มีตู้ในผังโรงพยาบาล</p>}
    <p className="note">สถานะกระดาษ/เครือข่ายยังเป็นข้อมูลจำลอง จนกว่าตู้จริงจะส่งสถานะเข้าระบบ{liveData ? ' · จำนวนบัตรนับจากผู้ป่วยที่ผ่านตู้' : ''}</p>
    <h4 className="dashSub">ตู้ต้อนรับดิจิทัล</h4>
    {!known ? <p className="cmdEmpty">ต้องเชื่อมต่อระบบกลาง</p> : !enabled ? <p className="cmdEmpty">ตู้ต้อนรับปิดอยู่ (ตั้งค่า → ตู้ต้อนรับ)</p> : !rk.length ? <p className="cmdEmpty">ยังไม่ได้ลงทะเบียนตู้</p>
      : <table className="dataTable compact"><thead><tr><th>ตู้</th><th>สถานะ</th><th>ติดต่อล่าสุด</th><th className="num">ใช้วันนี้</th><th className="num">ส่งต่อคน</th></tr></thead>
        <tbody>{rk.map(k=>{ const call = calls.find(c=>c.kioskId===k.id);
          return <tr key={k.id}><td><b>{k.name}</b>{k.place && <small className="muted"> · {k.place}</small>}</td>
            <td>{call ? <span className="dashChip bad">เรียกเจ้าหน้าที่{call.reason==='emergency' ? ' (ฉุกเฉิน)' : ''}</span> : <span className={'dashChip '+(k.online ? 'ok' : 'bad')}>{k.online ? 'ออนไลน์' : 'ออฟไลน์'}</span>}</td>
            <td className="muted">{ago(k.lastSeenAt)}</td><td className="num">{k.sessionsToday}</td><td className="num">{k.handoffsToday}</td></tr>; })}</tbody></table>}
    <p className="note">ออนไลน์ = ตู้ติดต่อระบบภายใน 12 นาที (ตู้ต่ออายุการเชื่อมต่อทุก 10 นาทีแม้ไม่มีคนใช้) · "ส่งต่อคน" = ครั้งที่ตู้ส่งเรื่องให้เจ้าหน้าที่</p>
  </Panel>;
}

// Today's appointments and bookings (the account's clinics): come, still to come, no-shows, cancelled.
function TodayPanel({sum,online}:{sum:Summary|null; online:boolean}) {
  const bar = (parts:[string,number,string][]) => { const total = parts.reduce((n,p)=>n+p[1],0);
    return total ? <><div className="dashStack" role="img" aria-label={parts.map(p=>`${p[0]} ${p[1]}`).join(', ')}>{parts.filter(p=>p[1]).map(p=><i key={p[0]} style={{flexGrow:p[1],background:p[2]}}/>)}</div>
      <div className="dashLegendList">{parts.map(p=><span key={p[0]}><i style={{background:p[2]}}/>{p[0]}<b>{p[1]}</b></span>)}</div></> : <p className="cmdEmpty">ไม่มีรายการวันนี้</p>; };
  return <Panel title="นัดหมายและการจองวันนี้" icon={CalendarCheck} sub="เฉพาะแผนกที่บัญชีนี้รับผิดชอบ">
    {!sum ? <p className="cmdEmpty">{online ? 'กำลังโหลด…' : 'ต้องเชื่อมต่อระบบกลาง'}</p> : <>
      <h4 className="dashSub">นัดแพทย์ {sum.appointments.enabled ? `· ${sum.appointments.total} นัด` : ''}</h4>
      {sum.appointments.enabled ? bar([['มาแล้ว',sum.appointments.checkedIn,'#16a34a'],['ยังไม่มา',sum.appointments.confirmed,'#2a78d6'],['ไม่มาตามนัด',sum.appointments.noShow,'#c92a2a'],['ยกเลิก',sum.appointments.cancelled,'#cbd5e1']]) : <p className="cmdEmpty">ระบบนัดปิดอยู่</p>}
      {sum.appointments.movesPending>0 && <p className="note">คำขอเลื่อนนัดรออนุมัติ {sum.appointments.movesPending} รายการ (ทุกวัน)</p>}
      <h4 className="dashSub">การจองล่วงหน้า {sum.bookings.enabled ? `· ${sum.bookings.total} รายการ` : ''}</h4>
      {sum.bookings.enabled ? bar([['มาแล้ว',sum.bookings.checkedIn,'#16a34a'],['ยังไม่มา',sum.bookings.confirmed,'#2a78d6'],['หมดเวลา',sum.bookings.expired,'#d97706'],['ยกเลิก',sum.bookings.cancelled,'#cbd5e1']]) : <p className="cmdEmpty">ระบบจองปิดอยู่</p>}
    </>}
  </Panel>;
}

type SvcRow = {key:string; name:string; waiting:number; serving:number; avgWait:number; longest:number; servers:number};
function ServicesPanel({rows,tt}:{rows:SvcRow[]; tt:Tt}) {
  const [table,setTable] = useState(false);
  const top = rows.slice(0,12), max = Math.max(1,...top.map(r=>r.waiting));
  return <Panel title="คนรอแยกตามแผนก / จุดบริการ" icon={Users} sub="เรียงจากคนรอมากที่สุด"
    right={<button className="linkBtn dark" onClick={()=>setTable(t=>!t)}><Table2 size={13}/> {table?'ดูเป็นกราฟ':'ดูเป็นตาราง'}</button>}>
    {table ? <div className="tableWrap"><table className="dataTable compact"><thead><tr><th>แผนก / จุดบริการ</th><th className="num">รอ</th><th className="num">กำลังรับบริการ</th><th className="num">รอเฉลี่ย</th><th className="num">นานสุด</th><th className="num">จุดที่ให้บริการ</th></tr></thead>
        <tbody>{rows.map(r=><tr key={r.key}><td><b>{r.name}</b></td><td className="num">{r.waiting}</td><td className="num">{r.serving}</td><td className="num">{r.avgWait}</td><td className="num">{r.longest}</td><td className="num">{r.servers}</td></tr>)}</tbody></table></div>
      : <div className="hbars">{top.map(r=><div key={r.key} className="hbar dashSvc" onMouseMove={e=>tt.show(e,<><b>{r.name}</b><br/>รอ {r.waiting} · กำลังรับบริการ {r.serving}<br/>รอเฉลี่ย {r.avgWait} นาที · นานสุด {r.longest} นาที · เปิด {r.servers} จุด</>)} onMouseLeave={tt.hide}>
          <span className="hbarLabel">{r.name}</span>
          <span className="hbarTrack"><i style={{width:`${r.waiting/max*100}%`,background:WAIT}}/></span>
          <span className="hbarValue">{r.waiting}<small className="muted"> · {r.avgWait}′</small></span></div>)}</div>}
    {!table && <p className="note">ตัวเลขหลัง · = รอเฉลี่ย (นาที) · ชี้ที่แถบเพื่อดูรายละเอียด{rows.length>12 ? ` · ดูครบ ${rows.length} รายการในมุมมองตาราง` : ''}</p>}
  </Panel>;
}

// Where people are now: a building × floor grid, darker = more.
function FloorsPanel({floors,tt}:{floors:Map<string,number>; tt:Tt}) {
  const list = [...floors.entries()].map(([k,n])=>{ const [b,l] = k.split(':'); return {b,level:Number(l),n}; }).filter(x=>x.b && x.b!=='undefined');
  const blds = [...new Set(list.map(x=>x.b))].sort((a,c)=>buildingShort(a).localeCompare(buildingShort(c),'th'));
  const levels = [...new Set(list.map(x=>x.level))].sort((a,c)=>c-a);
  const max = Math.max(1,...list.map(x=>x.n));
  const color = (n:number) => n<=0 ? RAMP[0] : RAMP[Math.min(RAMP.length-1,1+Math.floor(n/max*(RAMP.length-1)))];
  return <Panel title="จำนวนคนตามอาคารและชั้น" icon={Building2} sub="ผู้ป่วยนอกและ ER ที่อยู่ตอนนี้">
    {!list.length ? <p className="cmdEmpty">ยังไม่มีผู้ป่วย</p> : <>
      <div className="dashHeat" style={{gridTemplateColumns:`64px repeat(${blds.length},minmax(0,1fr))`}}>
        <span/>{blds.map(b=><span key={b} className="dashHeatHead">{buildingShort(b)}</span>)}
        {levels.map(l=>[<span key={`l${l}`} className="dashHeatRow">ชั้น {l}</span>,...blds.map(b=>{ const n = list.find(x=>x.b===b && x.level===l)?.n ?? 0;
          return <span key={`${b}:${l}`} className={'dashHeatCell'+(n/max>0.55?' dark':'')} style={{background:color(n)}} onMouseMove={e=>tt.show(e,<><b>{buildingShort(b)} ชั้น {l}</b><br/>{n} คน</>)} onMouseLeave={tt.hide}>{n || ''}</span>; })])}
      </div>
      <div className="rampLegend"><span>น้อย</span>{RAMP.slice(1).map(c=><i key={c} style={{background:c}}/>)}<span>มาก (สูงสุด {max} คน)</span></div></>}
  </Panel>;
}

