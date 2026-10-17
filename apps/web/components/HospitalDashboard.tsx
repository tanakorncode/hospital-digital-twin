'use client';
import dynamic from 'next/dynamic';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, MapPin, Tags, Route as RouteIcon, RotateCcw, FastForward, Building2, ChartColumn, ClipboardList, Clock, Droplet, House, Layers, ListOrdered, LocateFixed, Minus, Pill, Plus, Radiation, Search, Settings, Stethoscope, Thermometer, Users, UsersRound, Wallet, Hospital, LayoutGrid, Play, Pause, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, X, Ticket, UserRound, Accessibility, type LucideIcon, BrainCircuit } from 'lucide-react';
import { findDepts, findDoctors, isOff, type DeptPlace, kiosks, kioskStatusLabel, type Kiosk, DENSITY_HIGH, DENSITY_LOW, doctorName, dutyLabel, findRoom, floorDutyAt, roomDutyAt, HOURS, HOUR_END, HOUR_START, REF_HOUR, buildingDensityAt, buildingStatsAt, buildings, buildingStats, clampHour, crowdFactor, demoFlows, densityColor, densityLevel, floorDepartments, fmtHour, hourlySeries, parkingLots, peakWindow, personTypes, roads, scopeAt, servicePointAt, servicePoints, type PersonType, type Scope, type ServicePoint } from '../lib/scene-data';
import { useLiveFeed, type LiveStatus } from '../lib/live-feed';
import { SYSTEM_BY, allStations, canDo, openStations, useTicket, applyQueueEvents, basePatients as startingPatients, isLive, queueAssist, rulesFor, suggestionText, useQueueEvents, worldKey } from '../lib/queue';
import { demoOffset } from '../lib/use-demo-clock';
import { LONG_WAIT, alertsAt, bottlenecksAt, etaOf, fmtDur, fmtMin, knownUntil, placeText, patientToken, kioskAt, maskHN, patientAt, searchPatients, statusColor as patientColor, statusText, stepText, type Patient, type StepKind } from '../lib/patients';
import { LoginScreen, UserChip } from './LoginScreen';
import type { LabelKind, PickedPerson, SceneApi, SceneMode, SceneView } from './HospitalScene';
import QRCode from 'qrcode';
import QueuePage from './pages/QueuePage';
import StatsPage from './pages/StatsPage';
import SettingsPage from './pages/SettingsPage';
import CommandPage from './pages/CommandPage';
import CapacityPage from './pages/CapacityPage';
import AlertsPage, { type Ack } from './pages/AlertsPage';
import { alertsFor, defaultRules, serviceNote, servicePointsNow, type AlertRule } from '../lib/ops';

const HospitalScene = dynamic(()=>import('./HospitalScene'),{ssr:false,loading:()=> <div className="loading">กำลังโหลดแผนผังโรงพยาบาล 3D…</div>});
const navItems:[LucideIcon,string][] = [[House,'ภาพรวม'],[Building2,'ผังโรงพยาบาล'],[ListOrdered,'ติดตามคิว'],[BrainCircuit,'ศูนย์อัจฉริยะ'],[ChartColumn,'สถิติและรายงาน'],[Bell,'การแจ้งเตือน'],[Settings,'ตั้งค่า']];
const views:[SceneView,string][] = [['campus','ภาพรวมทั้งโรงพยาบาล'],['building','อาคาร'],['floor','ชั้น'],['department','แผนก']];
const serviceIcons:Record<string,LucideIcon> = {registration:ClipboardList,screening:Thermometer,clinic:Stethoscope,lab:Droplet,pharmacy:Pill,finance:Wallet,radiology:Radiation};
const statusColor = (s:ServicePoint['status']) => s==='critical'?'#ef4444':s==='busy'?'#f5a524':'#22c58b';
type InfoStat = {label:string;value:string|number;unit?:string;tone?:ServicePoint['status']};
const hh = (h:number) => String(h).padStart(2,'0');

// offsetMin: demo mode (?demoStart=9.5) runs the clock from another time of day, still ticking in real time.
function useClock(offsetMin=0) {
 const [now,setNow] = useState<Date|null>(null);
 useEffect(()=>{ const tick = ()=>setNow(new Date(Date.now()+offsetMin*60000)); tick(); const t=setInterval(tick,5000); return ()=>clearInterval(t); },[offsetMin]);
 if (!now) return {time:'--:--',date:'',hour:null as number|null};
 const time = now.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})+' น.';
 const weekday = now.toLocaleDateString('th-TH',{weekday:'long'}).replace(/^วัน/,'');
 return {time,date:`${weekday} ${now.toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'numeric'})}`,hour:now.getHours()+now.getMinutes()/60};
}

function MiniMap({selected,onSelect,showDensity,hour}:{selected:string|null;onSelect:(id:string)=>void;showDensity:boolean;hour:number}) {
 // Top-down sketch rotated 45° so it reads in the same orientation as the 3D view.
 return <svg viewBox="-34 -30 68 52" className="miniMapSvg" role="img" aria-label="แผนผังโดยรวม">
  <rect x="-40" y="-40" width="80" height="80" fill="#9cc77e"/>
  <g transform="rotate(45)">
   {roads.map(([x0,z0,x1,z1],i)=><rect key={i} x={x0} y={z0} width={x1-x0} height={z1-z0} fill="#6c7880"/>)}
   {parkingLots.map(([x0,z0,x1,z1],i)=><rect key={'p'+i} x={x0} y={z0} width={x1-x0} height={z1-z0} fill="#7d8890"/>)}
   {demoFlows.map(f=><polyline key={f.id} points={f.points.map(p=>p.join(',')).join(' ')} fill="none" stroke={f.color} strokeWidth="0.7" strokeLinejoin="round"/>)}
   {buildings.map(b=><rect key={b.id} x={b.x-b.width/2} y={b.z-b.depth/2} width={b.width} height={b.depth} rx="0.4" fill={showDensity?densityColor(buildingDensityAt(b.id,hour)):selected===b.id?'#1677ff':'#f3f6f8'} stroke={selected===b.id?'#1677ff':'#8a9aa8'} strokeWidth={selected===b.id?0.8:0.25} onClick={()=>onSelect(b.id)} style={{cursor:'pointer'}}/>)}
  </g>
 </svg>;
}

// Hourly crowd chart for the current scope. Dragging (or arrow keys) picks the hour shown on the map.
// liveKey changes with every realtime snapshot so the current hour's bar is recomputed.
function Timeline({scope,title,hour,nowHour,onHour,playing,onTogglePlay,onNow,following,liveNow,liveKey}:{scope:Scope;title:string;hour:number;nowHour:number|null;onHour:(h:number)=>void;playing:boolean;onTogglePlay:()=>void;onNow:()=>void;following:boolean;liveNow:boolean;liveKey:string}) {
 const series = useMemo(()=>hourlySeries(scope),[scope.building,scope.level,liveKey]); // eslint-disable-line react-hooks/exhaustive-deps
 const peak = peakWindow(series), max = Math.max(1,peak.max), span = HOUR_END+1-HOUR_START;
 const pct = (h:number) => (clampHour(h)-HOUR_START)/span*100;
 const chart = useRef<HTMLDivElement>(null), dragging = useRef(false);
 const pick = (clientX:number) => { const r = chart.current?.getBoundingClientRect(); if (r) onHour(clampHour(HOUR_START+(clientX-r.left)/r.width*span)); };
 const cur = series[Math.floor(clampHour(hour))-HOUR_START];
 // One compact row: summary | chart | controls.
 return <div className="timeline" title={liveNow?'ชั่วโมงปัจจุบันเป็นค่าสด · ชั่วโมงอื่นเป็นค่าจำลอง':'ข้อมูลจำลอง'}>
  <div className="tlInfo">
   <strong><span>ความหนาแน่นรายชั่วโมง · {title}</span>{liveNow ? <em className="liveBadge"><i/>สด</em> : !following && <em className="tlHistory">ช่วงเวลาอื่น</em>}</strong>
   <small><b>{fmtHour(hour)} · {cur?.total.toLocaleString()} คน</b> · <span className="tlPeak">พีค {fmtHour(peak.from)}–{fmtHour(peak.to)}</span></small>
  </div>
  <div className="tlTrack">
   <div className="tlChart" ref={chart} role="slider" tabIndex={0} aria-label="เลือกช่วงเวลา" aria-valuemin={HOUR_START} aria-valuemax={HOUR_END} aria-valuenow={Math.floor(hour)} aria-valuetext={fmtHour(hour)}
    onPointerDown={e=>{ dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); pick(e.clientX); }}
    onPointerMove={e=>{ if (dragging.current) pick(e.clientX); }}
    onPointerUp={()=>{ dragging.current = false; }}
    onKeyDown={e=>{ if (e.key==='ArrowLeft') onHour(clampHour(hour-1)); if (e.key==='ArrowRight') onHour(clampHour(hour+1)); }}>
    {series.map(pt=><div key={pt.hour} className={'tlBar'+(pt.hour===Math.floor(hour)?' on':'')} style={{height:`${Math.max(8,pt.total/max*100)}%`,background:densityColor(pt.density)}} title={`${fmtHour(pt.hour)} · ${pt.total.toLocaleString()} คน`}/>)}
    {nowHour!==null && nowHour>=HOUR_START && nowHour<HOUR_END+1 && <i className="tlNow" style={{left:`${pct(nowHour)}%`}} title="เวลาปัจจุบัน"/>}
    <div className="tlCursor" style={{left:`${pct(hour)}%`}}/>
   </div>
   <div className="tlTicks">{HOURS.filter(h=>h%2===0).map(h=><span key={h} style={{left:`${pct(h)}%`}}>{String(h).padStart(2,'0')}</span>)}</div>
  </div>
  <div className="tlBtns">
   <button className={following?'':'primary'} onClick={onNow}>ตอนนี้</button>
   <button onClick={onTogglePlay} aria-label={playing?'หยุด':'เล่นทั้งวัน'}>{playing?<Pause size={13}/>:<Play size={13}/>}</button>
  </div>
 </div>;
}

// Patient journey card. Shows only steps already done, the current one and the next few planned steps.
// QR printed on the queue slip: opens the patient's own status page (no HN, no name).
function SlipQR({p,minute}:{p:Patient;minute:number}) {
 const [src,setSrc] = useState('');
 const ticket = useTicket(p,true);
 const url = typeof window==='undefined' || !ticket.token ? '' : `${window.location.origin}/q/${ticket.token}?hour=${(minute/60).toFixed(2)}`;
 useEffect(()=>{ if (url) QRCode.toDataURL(url,{margin:1,width:160}).then(setSrc).catch(()=>setSrc('')); else setSrc(''); },[url]);
 return <a className="slipQR" href={url} target="_blank" rel="noreferrer" title="หน้าสถานะสำหรับผู้ป่วย">
  {src ? <img src={src} alt="QR หน้าสถานะคิว"/> : <span/>}<small>QR บนบัตรคิว<br/>ผู้ป่วยสแกนดูสถานะเอง</small></a>;
}

function PatientCard({p,minute,onClose,onReplay,replaying}:{p:Patient;minute:number;onClose:()=>void;onReplay?:()=>void;replaying?:boolean}) {
 const st = patientAt(p,minute), last = p.steps[p.steps.length-1], current = st?.index ?? (minute<p.arrival ? -1 : p.steps.length);
 const waiting = !!st && minute<st.step.called, eta = st ? etaOf(st,minute) : 0;
 return <div className="sceneInfo patientCard">
  <div className="sceneInfoHead"><span className="infoIcon"><UserRound size={20}/></span><strong>คิว {p.queue} · {maskHN(p.hn)}</strong>
   <button className="infoClose" aria-label="ปิด" onClick={onClose}><X size={16}/></button></div>
  <p className="sceneInfoSub">{p.dept} · {p.flow==='er'?'ผู้ป่วยฉุกเฉิน':p.flow==='ipd'?'ผู้ป่วยใน':'ผู้ป่วยนอก'}</p>
  {p.ward && <p className="sceneInfoLine">เตียง {p.ward.bed} · นอนโรงพยาบาลวันที่ {p.ward.day}{p.ward.dischargeAt?` · แพทย์อนุญาตกลับบ้านวันนี้ ${fmtMin(p.ward.dischargeAt)}`:''}</p>}
  {st ? <div className="ptStatus" style={{borderColor:patientColor[st.status]}}>
    <b style={{color:patientColor[st.status]}}>{statusText[st.status]}</b> · {waiting?stepText[st.step.kind].wait:stepText[st.step.kind].serve}
    <small>{placeText(st,minute)}{waiting?` · รอมาแล้ว ${fmtDur(st.stepWait)}`:''}{eta?` · คาดว่าอีก ~${fmtDur(eta)}`:''}</small>
   </div>
   : <p className="sceneInfoLine">{minute<p.arrival ? `ยังไม่มาถึง · มาถึงเวลา ${fmtMin(p.arrival)}` : `กลับบ้านแล้ว · ${fmtMin(last.end)}`}</p>}
  {onReplay && !replaying && minute>p.arrival && p.flow!=='ipd' && <button className="replayBtn" onClick={onReplay}><RouteIcon size={15}/> ย้อนดูเส้นทางบนแผนที่</button>}
  {p.help && <p className="ptNote"><Accessibility size={13}/> ขอความช่วยเหลือ: {p.help} · แจ้งเวรเปล/จิตอาสาแล้ว</p>}
  {p.missed && minute>=p.missed.at && !p.steps.some(x=>x.manual && x.start<=p.missed!.at && p.missed!.at<x.end) && <p className="ptNote missed">เรียกคิว {fmtMin(p.missed.at)} แล้วไม่อยู่หน้าห้อง · เรียกซ้ำ {fmtMin(p.missed.at+15)}</p>}
  <ol className="journey">{p.steps.map((x,i)=>{
   if (i>Math.max(current,knownUntil(p,minute))) return null;
   const state = i<current ? 'done' : i===current ? 'now' : 'next';
   return <li key={i} className={state}><i className="num">{i+1}</i><span>{state==='next'?'ถัดไป':fmtMin(state==='done'?x.called:x.start)}</span>{stepText[x.kind].serve}
    {state==='done' && x.kind!=='kiosk' && x.kind!=='leave' && x.kind!=='labResult' && <em>รอ {Math.round(x.called-x.start)} น.</em>}</li>;
  })}</ol>
  {st && knownUntil(p,minute)<p.steps.length-1 && p.flow!=='ipd' && <p className="ptTotal">ขั้นตอนหลังพบแพทย์ขึ้นกับคำสั่งแพทย์ (ยังไม่ทราบล่วงหน้า)</p>}
  {st && !p.ward && <p className="ptTotal">อยู่ในโรงพยาบาลมาแล้ว {Math.round(st.inHospital)} นาที</p>}
  {p.flow!=='ipd' && <SlipQR p={p} minute={minute}/>}
 </div>;
}

function KioskCard({k,patients,minute,onClose,onPick}:{k:Kiosk;patients:Patient[];minute:number;onClose:()=>void;onPick:(id:string)=>void}) {
 const now = kioskAt(patients,k.id,minute);
 // Suggest the least busy working kiosk elsewhere when this one is broken, low on paper or queued.
 const alt = k.status!=='online' || now.line>=3
  ? kiosks.filter(x=>x.id!==k.id && x.status==='online').map(x=>({x,line:kioskAt(patients,x.id,minute).line,d:Math.hypot(x.x-k.x,x.z-k.z)})).sort((a,b)=>a.line-b.line||a.d-b.d)[0] : undefined;
 return <div className="sceneInfo">
  <div className="sceneInfoHead"><span className="infoIcon"><Ticket size={20}/></span><strong>{k.name}</strong>
   <button className="infoClose" aria-label="ปิด" onClick={onClose}><X size={16}/></button></div>
  <p className={'sceneInfoLine kiosk-'+k.status}>สถานะเครื่อง: {kioskStatusLabel[k.status]}</p>
  <div className="infoStats">
   <div><small>ต่อแถวตอนนี้</small><b className={now.line>=3?'busy':''}>{now.line}<em> คน</em></b></div>
   <div><small>ออกบัตร ชม.นี้</small><b>{now.issuedHour}<em> ใบ</em></b></div>
   <div><small>ออกบัตรวันนี้</small><b>{now.issuedToday}<em> ใบ</em></b></div>
  </div>
  {alt && <p className="ptNote">แนะนำให้ใช้ <button className="linkBtn" onClick={()=>onPick(alt.x.id)}>{alt.x.name}</button> · ต่อแถว {alt.line} คน</p>}
 </div>;
}

// Every building in one row: a photo taken from the 3D model plus live figures, for comparing buildings
// at a glance and jumping to one. Opened on demand from the service bar.
type PatientAlert = ReturnType<typeof alertsAt>[number];
function BuildingDrawer({thumbs,hour,alerts,present,current,onPick,onClose}:{thumbs:Record<string,string>;hour:number;alerts:PatientAlert[];present:number;current:string|null;onPick:(id:string|null)=>void;onClose:()=>void}) {
 const row = useRef<HTMLDivElement>(null);
 useEffect(()=>{ const esc = (e:KeyboardEvent)=>{ if (e.key==='Escape') onClose(); }; window.addEventListener('keydown',esc); return ()=>window.removeEventListener('keydown',esc); },[onClose]);
 const alertsIn = (id:string) => alerts.filter(a=>a.area.buildingId===id).length;
 const card = (id:string|null, name:string, lines:React.ReactNode) => <button key={id??'campus'} className={'bCard'+(current===id?' on':'')} onClick={()=>onPick(id)}>
  {thumbs[id??'campus'] ? <img src={thumbs[id??'campus']} alt=""/> : <span className="bThumb"><Building2 size={28}/></span>}
  <b>{name}</b>{lines}
 </button>;
 return <div className="buildingDrawer" role="dialog" aria-label="อาคารทั้งหมด">
  <div className="bHead"><strong>อาคารทั้งหมด</strong><small>{fmtHour(hour)} · สีตามความหนาแน่นต่อชั้น</small>
   <button className="infoClose" aria-label="ปิด" onClick={onClose}><X size={16}/></button></div>
  <div className="bRowWrap">
   <button className="bArrow" aria-label="เลื่อนซ้าย" onClick={()=>row.current?.scrollBy({left:-420,behavior:'smooth'})}><ChevronLeft size={18}/></button>
   <div className="bRow" ref={row}>
    {card(null,'มุมมองรวม',<><small>ผู้ป่วยในระบบ {present} คน</small><small className={alerts.length?'warn':'ok'}>{alerts.length?`⚠ ${alerts.length} ต้องติดตาม`:'ไม่มีรายการต้องติดตาม'}</small></>)}
    {buildings.map(b=>{ const avg = buildingDensityAt(b.id,hour), n = alertsIn(b.id);
     return card(b.id,b.name,<><small><i className="bDot" style={{background:densityColor(avg)}}/>{avg} คน/ชั้น · {b.floors} ชั้น</small><small className={n?'warn':'ok'}>{n?`⚠ ${n} ต้องติดตาม`:'ไม่มีรายการต้องติดตาม'}</small></>); })}
   </div>
   <button className="bArrow" aria-label="เลื่อนขวา" onClick={()=>row.current?.scrollBy({left:420,behavior:'smooth'})}><ChevronRight size={18}/></button>
  </div>
 </div>;
}

function LiveStatusBadge({status,at,source}:{status:LiveStatus;at?:string;source?:string}) {
 const time = at ? new Date(at).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '';
 const [dot,title,detail] = status==='live'
  ? ['greenDot','เชื่อมต่อแบบเรียลไทม์',`อัปเดต ${time} · ${source==='his-adapter'?'HIS':'ตัวจำลอง (DEMO)'}`]
  : status==='connecting' ? ['amberDot','กำลังเชื่อมต่อ…','ระหว่างนี้ใช้ข้อมูลจำลองตามช่วงเวลา']
  : ['redDot','ออฟไลน์','เชื่อมต่อ API ไม่ได้ · ใช้ข้อมูลจำลองตามช่วงเวลา'];
 return <div className="systemStatus" role="status"><strong><span className={dot}/>{title}</strong><small>{detail}</small></div>;
}

export default function HospitalDashboard() {
 const [selected,setSelected] = useState<string|null>('opd');
 const [activeNav,setActiveNav] = useState('ภาพรวม');
 const onMap = activeNav==='ภาพรวม';
 // Alert rules and acknowledgements: kept in this browser only (a real deployment stores them server-side).
 const [rules,setRules] = useState<AlertRule[]>(defaultRules);
 const [acks,setAcks] = useState<Record<string,Ack>>({});
 useEffect(()=>{ try {
  const r = localStorage.getItem('hdt.alertRules'), a = localStorage.getItem('hdt.alertAcks');
  if (r) setRules(defaultRules.map(d=>({...d,...(JSON.parse(r) as AlertRule[]).find(x=>x.id===d.id)})));
  if (a) setAcks(JSON.parse(a));
 } catch { /* storage unavailable: defaults */ } },[]);
 const saveRules = (r:AlertRule[]) => { setRules(r); try { localStorage.setItem('hdt.alertRules',JSON.stringify(r)); } catch { /* ignore */ } };
 const [view,setView] = useState<SceneView>('campus');
 const [mode,setMode] = useState<SceneMode>('3d');
 const [showLabels,setShowLabels] = useState(true);
 const [pinnedFlow,setPinnedFlow] = useState<string|null>(null);
 const [hoverFlow,setHoverFlow] = useState<string|null>(null);
 const [hiddenTypes,setHiddenTypes] = useState<PersonType[]>([]);
 const [showDensity,setShowDensity] = useState(false);
 const [hour,setHour] = useState(REF_HOUR+0.4);
 const [playing,setPlaying] = useState(false);
 const [legendOpen,setLegendOpen] = useState(false);
 // What the map shows (labels by kind, patient-flow ribbons, the summary card) — remembered on this device.
 const [layers,setLayers] = useState<MapLayers>(SIMPLE_LAYERS);
 const [layersOpen,setLayersOpen] = useState(false);
 useEffect(()=>{ try { const v = JSON.parse(localStorage.getItem('hdt.mapLayers') ?? 'null'); if (v && Array.isArray(v.hidden)) setLayers({...SIMPLE_LAYERS,...v}); } catch { /* ignore */ } },[]);
 const saveLayers = (l:MapLayers) => {
  if (!l.timeline && layers.timeline) { setPlaying(false); setFollowing(true); } // no time control left on screen: go back to now
  setLayers(l); try { localStorage.setItem('hdt.mapLayers',JSON.stringify(l)); } catch { /* ignore */ } };
 const [selectedRoom,setSelectedRoom] = useState<string|null>(null);
 // A department picked from the search: its floor opens and its area is highlighted.
 const [selectedDept,setSelectedDept] = useState<{buildingId:string;level:number;name:string}|null>(null);
 const [selectedPatient,setSelectedPatient] = useState<string|null>(null);
 // Journey replay: the map's clock is driven from the patient's arrival forward while the view follows them.
 const [replay,setReplay] = useState<Replay|null>(null);
 const [selectedKiosk,setSelectedKiosk] = useState<string|null>(null);
 const [query,setQuery] = useState('');
 const [toast,setToast] = useState<string|null>(null);
 const [drawerOpen,setDrawerOpen] = useState(false);
 const [thumbs,setThumbs] = useState<Record<string,string>>({});
 useEffect(()=>{ if (!toast) return; const t = setTimeout(()=>setToast(null),3500); return ()=>clearTimeout(t); },[toast]);
 // Staff queue actions (from the API, or this browser when offline) replayed over the simulated day.
 const queueSync = useQueueEvents();
 // One simulated day of journeys (fixed seed so server and browser render the same), built on the OPD hours and the department / station layout in Settings.
 const world = worldKey(queueSync.settings);
 // Live data mode: today's real visits instead (rebuilt with the log, since each step starts when the previous one is done).
 const liveData = isLive(queueSync.settings);
 const basePatients = useMemo(()=>startingPatients(queueSync.settings,queueSync.visits,queueSync.events),[world,liveData,liveData?queueSync.visits:null,liveData?queueSync.events:null]); // eslint-disable-line react-hooks/exhaustive-deps
 const patients = useMemo(()=>applyQueueEvents(basePatients,queueSync.events),[basePatients,queueSync.events]);
 // following: the timeline tracks the clock and shows realtime values; scrubbing or playing leaves it.
 const [following,setFollowing] = useState(true);
 const live = useLiveFeed();
 const liveKey = live.status==='live' ? live.snapshot?.at ?? '' : live.status;
 const liveNow = following && live.status==='live';
 const toggleType = (t:PersonType) => setHiddenTypes(h=>h.includes(t)?h.filter(x=>x!==t):[...h,t]);
 const sceneApi = useRef<SceneApi|null>(null);
 const [clockOffset,setClockOffset] = useState(0);
 const urlClock = useRef(false); // ?hour / ?demoStart in the link wins over the test time in Settings
 useEffect(()=>{ if (!urlClock.current) setClockOffset(queueSync.settings.demoOffset ?? 0); },[queueSync.settings.demoOffset]);
 const clock = useClock(clockOffset);
 const spec = buildings.find(b=>b.id===selected);
 const stats = spec ? buildingStatsAt(spec.id,hour) : undefined;
 const panelBuilding = spec ?? buildings[0];
 const panelStats = buildingStats[panelBuilding.id];
 const panelNow = buildingStatsAt(panelBuilding.id,hour) ?? panelStats;
 const [activeFloor,setActiveFloor] = useState(2);
 // Deep link, e.g. ?view=floor&building=opd&floor=2&mode=2d&flow=flow-er&hide=visitor,staff&hour=9.5&room=opd-203&patient=A012
 const linkedFloor = useRef<{building:string;floor:number}|null>(null);
 useEffect(()=>{
  const q = new URLSearchParams(window.location.search);
  const v = q.get('view'), b = q.get('building'), f = Number(q.get('floor')), m = q.get('mode');
  if (views.some(([value])=>value===v)) setView(v as SceneView);
  if (m==='2d'||m==='3d') setMode(m);
  if (b && buildings.some(x=>x.id===b)) setSelected(b);
  if (f) linkedFloor.current = {building:b ?? 'opd',floor:f};
  const fl = q.get('flow');
  if (fl && demoFlows.some(x=>x.id===fl)) setPinnedFlow(fl);
  if (q.get('density')==='1') setShowDensity(true);
  const rm = q.get('room'), room = rm ? findRoom(rm) : undefined;
  if (room) { setSelectedRoom(room.id); setSelected(room.buildingId); linkedFloor.current = {building:room.buildingId,floor:room.level}; if (!v) setView('floor'); }
  const hide = q.get('hide')?.split(',').filter((t):t is PersonType=>personTypes.some(x=>x.id===t));
  if (hide?.length) setHiddenTypes(hide);
  // Start at the current time (clamped to opening hours) unless the link pins an hour.
  const h = Number(q.get('hour')), d = new Date();
  const pinned = q.get('hour')!==null && !Number.isNaN(h);
  setHour(clampHour(pinned ? h : d.getHours()+d.getMinutes()/60));
  if (pinned) { setFollowing(false); urlClock.current = true; }
  const ds = Number(q.get('demoStart'));
  if (!pinned && q.get('demoStart')!==null && !Number.isNaN(ds)) { urlClock.current = true; const off = demoOffset(ds); setClockOffset(off); setHour(clampHour((d.getHours()*60+d.getMinutes()+off)/60)); }
  // ?patient=A012 (queue number) opens that patient's card and the floor they are on.
  const pq = q.get('patient')?.toUpperCase(), pt = pq ? patients.find(x=>x.queue===pq||x.id===pq.toLowerCase()) : undefined;
  if (pt) {
   setSelectedPatient(pt.id);
   const place = patientAt(pt,clampHour(pinned?h:d.getHours()+d.getMinutes()/60)*60)?.area;
   if (place?.buildingId && place.level) { setSelected(place.buildingId); linkedFloor.current = {building:place.buildingId,floor:place.level}; setView('floor'); }
  }
 },[]);
 useEffect(()=>{ if (following && clock.hour!==null) setHour(clampHour(clock.hour)); },[following,clock.hour]);
 // Play: sweep through the day, looping back to opening time.
 useEffect(()=>{
  if (!playing) return;
  const t = setInterval(()=>setHour(h=>h+0.1>HOUR_END+0.99?HOUR_START:h+0.1),120);
  return ()=>clearInterval(t);
 },[playing]);
 useEffect(()=>{
  const link = linkedFloor.current;
  if (link) { if (link.building===panelBuilding.id) { setActiveFloor(link.floor); linkedFloor.current = null; } return; }
  setActiveFloor(panelStats.floors[Math.floor(panelStats.floors.length/2)]?.level ?? 1);
 },[panelStats,panelBuilding.id]);
 // Real queue-system data (HIS adapter) wins; otherwise count the tracked patients so the bar matches the map.
 const pointsNow = live.snapshot?.source==='his-adapter' && liveNow ? servicePoints.map(p=>servicePointAt(p,hour)) : servicePointsNow(servicePoints,patients,hour*60);
 const totalWaiting = pointsNow.reduce((n,p)=>n+p.queue,0);
 // Top metrics scale with the hospital-wide crowd; "today" accumulates through the day (demo).
 const campusRatio = scopeAt({},hour).total/scopeAt({},REF_HOUR).total, opdK = crowdFactor('opd',hour);
 const cumulative = (h:number) => HOURS.filter(x=>x<Math.floor(h)).reduce((n,x)=>n+scopeAt({},x).total,0)+scopeAt({},h).total*(h%1);
 const todayTotal = Math.round(1842*cumulative(hour)/cumulative(REF_HOUR+0.4));
 const roomsUsed = Math.min(56,Math.round(42*Math.min(1.3,opdK))); // no clinics before opening
 const shortName = panelBuilding.name.replace(/ \(.*\)$/,'');
 const floorInfo = panelNow.floors.find(f=>f.level===activeFloor);
 const depts = floorDepartments(panelBuilding.id,activeFloor,hour);
 const scope:Scope = view==='campus' ? {} : view==='building' ? {building:panelBuilding.id} : {building:panelBuilding.id,level:activeFloor};
 const scopeTitle = view==='campus' ? 'ทั้งโรงพยาบาล' : view==='building' ? shortName : `${shortName} ชั้น ${activeFloor}`;
 const roomsLabel = panelBuilding.kind==='inpatient' ? 'เตียง' : 'ห้องตรวจ';
 const duties = floorDutyAt(panelBuilding.id,activeFloor,hour);
 // A selected room only applies while its own floor is on screen.
 const roomOf = selectedRoom ? findRoom(selectedRoom) : undefined;
 const activeRoom = (view==='floor'||view==='department') && roomOf && roomOf.buildingId===panelBuilding.id && roomOf.level===activeFloor ? roomOf.id : null;
 const roomDuty = activeRoom ? roomDutyAt(activeRoom,hour) : undefined;
 const activeDept = (view==='floor'||view==='department') && selectedDept && selectedDept.buildingId===panelBuilding.id && selectedDept.level===activeFloor ? selectedDept.name : null;
 const changeView = (v:SceneView) => { if (v!=='campus' && !selected) setSelected('opd'); setView(v); };
 // Picking a floor from the campus or building view drills down into that floor's plan.
 const pickFloor = (level:number) => { setSelectedRoom(null); setActiveFloor(level); setSelected(panelBuilding.id); if (view==='campus'||view==='building') setView('floor'); };
 // Selecting a room (from the roster or its sign) opens its floor plan and zooms to it.
 const minute = replay ? replay.t : hour*60; // during a replay everything reads the replay clock directly (no one-frame lag)
 const replayPatient = replay ? patients.find(x=>x.id===replay.id) : undefined;
 const patientsRef = useRef(patients); patientsRef.current = patients;
 const startReplay = (p:Patient) => {
  const to = Math.min(p.steps[p.steps.length-1].end,minute); if (to<=p.arrival) return;
  setReplay({id:p.id,from:p.arrival,to,t:p.arrival,playing:true,speed:6,skipWait:true,solo:true,back:{hour,following}});
  setPlaying(false); setFollowing(false); setSelectedPatient(p.id); setSelectedRoom(null); setSelectedKiosk(null); setSelectedDept(null);
 };
 const exitReplay = (keepTime=false) => { if (!replay) return; if (!keepTime) { setHour(replay.back.hour); setFollowing(replay.back.following); } setReplay(null); };
 // Advance ~10 times a second; waits run 5× faster when "skip waits" is on. A slow frame never advances more than
 // 0.2 s worth, so a busy machine plays slower instead of skipping whole steps.
 useEffect(()=>{
  if (!replay?.playing) return;
  let raf = 0, last = performance.now(), acc = 0;
  const tick = (now:number) => { acc += (now-last)/1000; last = now;
   if (acc>=0.1) { const dt = Math.min(acc,0.2); acc = 0;
    setReplay(r=>{ if (!r || !r.playing) return r; const p = patientsRef.current.find(x=>x.id===r.id); const st = p ? patientAt(p,r.t) : null;
     const fast = r.skipWait && st && r.t<st.step.called-1.5 ? 5 : 1, t = Math.min(r.to,r.t+dt*r.speed*fast); return {...r,t,playing:t<r.to}; }); }
   raf = requestAnimationFrame(tick); };
  raf = requestAnimationFrame(tick); return ()=>cancelAnimationFrame(raf);
 },[replay?.playing]); // eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{ if (replay) setHour(replay.t/60); },[replay?.t]); // eslint-disable-line react-hooks/exhaustive-deps
 // Choosing another patient (or closing the card) ends the replay where it is.
 useEffect(()=>{ if (replay && selectedPatient!==replay.id) setReplay(null); },[selectedPatient]); // eslint-disable-line react-hooks/exhaustive-deps
 // Follow the patient between buildings and floors; outdoors (walking between buildings) shows the whole campus.
 const replayArea = replayPatient && replay ? (()=>{ const st = patientAt(replayPatient,replay.t); return st ? `${st.area.buildingId ?? ''}:${st.area.level ?? ''}` : ''; })() : '';
 useEffect(()=>{
  if (!replay || !replayArea) return;
  const [b,l] = replayArea.split(':'), lv = Number(l);
  if (!b || !lv) { setView('campus'); return; }
  if (b!==panelBuilding.id) { linkedFloor.current = {building:b,floor:lv}; setSelected(b); } else { setSelected(b); setActiveFloor(lv); }
  if (view==='campus' || view==='building') setView('floor');
 },[replayArea]); // eslint-disable-line react-hooks/exhaustive-deps
 const patient = selectedPatient ? patients.find(p=>p.id===selectedPatient) : undefined;
 const kiosk = selectedKiosk ? kiosks.find(k=>k.id===selectedKiosk) : undefined;
 const alerts = alertsAt(patients,minute), bottleneck = bottlenecksAt(patients,minute)[0];
 const minuteKey = Math.floor(minute);
 const opsAlerts = useMemo(()=>alertsFor(patients,minuteKey,rules),[patients,minuteKey,rules]);
 const openAlerts = opsAlerts.filter(a=>!acks[a.id]).length;
 // Queue assistant: station health and balancing suggestions for the minute on screen.
 const assist = useMemo(()=>queueAssist(patients,minuteKey,queueSync.events,queueSync.settings),[patients,minuteKey,queueSync.events,queueSync.settings]);
 const [settingsFocus,setSettingsFocus] = useState<string|null>(null);
 // In groups set to "auto", any open dashboard carries out the moves; the API keeps the first and drops repeats.
 const autoBusy = useRef(false);
 useEffect(()=>{
  if (!following || autoBusy.current || (queueSync.online && !canDo(queueSync.user,'staff'))) return; // online: only a signed-in screen may act
  const todo = assist.suggestions.filter(sg=>rulesFor(queueSync.settings,sg.group).mode==='auto');
  if (!todo.length) return;
  autoBusy.current = true;
  void (async ()=>{
   for (const sg of todo) for (const s of sg.moves)
    await queueSync.send({at:minuteKey,station:sg.from.id,action:'transfer',patientId:s.p.id,step:s.index,target:sg.to.id,position:'keep',by:SYSTEM_BY,
     reason:`${suggestionText[sg.kind]} · ${sg.reason}`,key:`auto:${s.p.id}:${s.index}:${sg.to.id}:${Math.floor(minuteKey/10)}`});
   autoBusy.current = false;
  })();
 },[assist,following]); // eslint-disable-line react-hooks/exhaustive-deps
 const ackAlert = (id:string) => setAcks(prev=>{ const next = {...prev,[id]:{minute:minuteKey,at:new Date().toISOString()}}; try { localStorage.setItem('hdt.alertAcks',JSON.stringify(next)); } catch { /* ignore */ } return next; });
 const timeNote = `ข้อมูล ณ ${fmtHour(hour)} · ${liveNow?'สด':following?'ตามเวลาปัจจุบัน':'ช่วงเวลาที่เลือกในไทม์ไลน์'} · ${liveData?'ผู้ป่วยจริง':'ข้อมูลจำลอง'}`;
 // Live data mode: the top figures come from the real patients and the stations staff have opened — no simulated trends.
 const realStats = useMemo(()=>{
  if (!liveData) return null;
  const now = patients.map(p=>patientAt(p,minute)).filter((s):s is NonNullable<typeof s>=>!!s && s.step.kind!=='leave');
  const waits = now.filter(s=>s.status==='waiting'||s.status==='long').map(s=>s.stepWait);
  const rooms = allStations().filter(st=>st.roomId), open = new Set(openStations(queueSync.events).map(st=>st.id));
  return {total:patients.length,serving:now.filter(s=>s.status==='serving').length,wait:waits.length?Math.round(waits.reduce((a,b)=>a+b,0)/waits.length):undefined,
   rooms:rooms.filter(st=>open.has(st.id)).length,allRooms:rooms.length};
 },[liveData,patients,minute,queueSync.events]);
 const openOnMap = (id:string) => { setActiveNav('ภาพรวม'); selectPatient(id); };
 const presentNow = patients.filter(p=>patientAt(p,minute)).length;
 const pickBuilding = (id:string|null) => {
  setDrawerOpen(false); setSelectedPatient(null); setSelectedRoom(null); setSelectedKiosk(null); setSelectedDept(null);
  if (!id) { setView('campus'); sceneApi.current?.reset(); return; }
  setSelected(id); setView('building');
 };
 const results = searchPatients(patients,query,minute), deptResults = findDepts(query), doctorResults = findDoctors(query,hour);
 const openDept = (d:DeptPlace) => {
  setQuery(''); setDrawerOpen(false); setSelectedPatient(null); setSelectedKiosk(null); setSelectedRoom(null);
  setSelectedDept({buildingId:d.buildingId,level:d.level,name:d.name});
  if (d.buildingId!==panelBuilding.id) linkedFloor.current = {building:d.buildingId,floor:d.level}; else setActiveFloor(d.level);
  setSelected(d.buildingId); setView('department');
 };
 // Selecting a patient opens the place they are at now (their floor plan), so they are on screen.
 const selectPatient = (id:string) => {
  const p = patients.find(x=>x.id===id); if (!p) return;
  setSelectedPatient(id); setSelectedKiosk(null); setSelectedRoom(null); setSelectedDept(null); setQuery('');
  const place = patientAt(p,minute)?.area, b = place?.buildingId ? buildings.find(x=>x.id===place.buildingId) : undefined;
  if (!b || !place?.level || (view==='campus' && b.kind==='opd' && place.level===b.floors)) return; // outdoors, or already visible
  if (b.id!==panelBuilding.id) { linkedFloor.current = {building:b.id,floor:place.level}; setSelected(b.id); } else setActiveFloor(place.level);
  setView('floor');
 };
 // Clicking someone who isn't a tracked patient: a doctor at a desk opens that room; others get a note.
 const pickPerson = (who:PickedPerson) => {
  if (who.dutyRoom) { selectRoom(who.dutyRoom); return; }
  setToast(who.type==='visitor' ? 'ญาติ / ผู้ติดตาม · ไม่ได้ติดตามรายบุคคล (ไม่ใช่ผู้ป่วย)'
   : who.type==='doctor' ? 'แพทย์ · ดูเวรได้ที่การ์ดแผนกและแพทย์ออกตรวจ' : 'เจ้าหน้าที่ · ไม่ได้ติดตามรายบุคคล');
 };
 const selectKiosk = (id:string) => { setSelectedKiosk(id); setSelectedPatient(null); setSelectedRoom(null); };
 const selectRoom = (id:string) => {
  const r = findRoom(id); if (!r) return;
  setSelectedRoom(id); setSelectedPatient(null); setSelectedKiosk(null);
  if (r.buildingId!==panelBuilding.id) { linkedFloor.current = {building:r.buildingId,floor:r.level}; setSelected(r.buildingId); } else setActiveFloor(r.level);
  if (view!=='floor' && view!=='department') setView('floor');
 };
 // From the queue pages: show a floor (or one room) on the map.
 const openPlaceOnMap = (buildingId:string, level:number, roomId?:string) => {
  setActiveNav('ภาพรวม'); setSelectedPatient(null); setSelectedKiosk(null);
  if (roomId) { selectRoom(roomId); return; }
  setSelectedRoom(null);
  if (buildingId!==panelBuilding.id) { linkedFloor.current = {building:buildingId,floor:level}; setSelected(buildingId); } else setActiveFloor(level);
  setView('floor');
 };
 // Waiting in a building = tracked patients physically there and waiting (matches the queue board).
 const waitingIn = (id:string) => patients.map(p=>patientAt(p,minute)).filter(x=>x && x.area.buildingId===id && minute<x.step.called && x.step.kind!=='ward').length;
 const buildingInfo:InfoStat[] = stats
  ? [{label:'ผู้รอ',value:waitingIn(spec!.id),unit:'คน',tone:'critical'},{label:'รอเฉลี่ย',value:stats.avgWait,unit:'นาที'},{label:roomsLabel,value:`${stats.rooms[0]}/${stats.rooms[1]}`}]
  : [{label:'ผู้รอ',value:totalWaiting,unit:'คน',tone:'critical'},{label:'รอเฉลี่ย',value:Math.round(28*(0.4+0.6*opdK)),unit:'นาที'},{label:'ห้องตรวจ',value:`${roomsUsed}/56`}];
 const info:{Icon:LucideIcon;title:string;sub?:string;lines?:string[];stats:InfoStat[];onClose?:()=>void} =
  roomDuty ? {Icon:Stethoscope,title:`${roomDuty.room.name} · ${roomDuty.room.dept}`,onClose:()=>setSelectedRoom(null),
   lines:[roomDuty.current && roomDuty.status!=='vacant' ? `แพทย์เวร: ${doctorName(roomDuty.current.doctor,true)} · ${hh(roomDuty.current.from)}:00–${hh(roomDuty.current.to)}:00` : 'ตอนนี้ไม่มีแพทย์ออกตรวจ',
    roomDuty.next ? `เวรถัดไป ${hh(roomDuty.next.from)}:00 · ${doctorName(roomDuty.next.doctor,true)}` : 'ไม่มีเวรถัดไปวันนี้'],
   stats:[{label:'คิวหน้าห้อง',value:roomDuty.queue,unit:'คน'},{label:'สถานะ',value:dutyLabel[roomDuty.status],tone:roomDuty.status==='active'?'normal':roomDuty.status==='break'?'busy':undefined},{label:'รอโดยประมาณ',value:roomDuty.queue*7,unit:'นาที'}]}
  : view==='building' ? {Icon:Building2,title:panelBuilding.name,sub:'สีของแต่ละชั้นแสดงความหนาแน่น · คลิกชั้นเพื่อดูผัง',stats:buildingInfo}
  : view==='floor' ? {Icon:Layers,title:`${shortName} · ชั้น ${activeFloor}`,sub:floorInfo?.desc,stats:[
     {label:'ผู้ใช้บริการ',value:floorInfo?.count??0,unit:'คน',tone:densityLevel(floorInfo?.count??0)},{label:'แผนก',value:depts.length},{label:'รอเฉลี่ย',value:panelNow.avgWait,unit:'นาที'}]}
  : view==='department' ? {Icon:LayoutGrid,title:`แผนก · ${shortName} ชั้น ${activeFloor}`,sub:'สีพื้นแสดงพื้นที่ของแต่ละแผนก',stats:depts.map(d=>({label:d.name,value:d.queue,unit:'คน',tone:d.status}))}
  : {Icon:Hospital,title:spec?.name??'ภาพรวมโรงพยาบาล',stats:buildingInfo};

 // A patient card is open on the map: the bottom bars step aside so the card can use the full height.
 const patientFocus = onMap && !!selectedPatient;
 return <main className={'app'+(layers.timeline?'':' noTimeline')+(patientFocus?' patientFocus':'')+(replay?' replaying':'')}>
  <header className="topbar">
   <div className="brand"><div className="brandIcon"><Plus size={26} strokeWidth={3.4}/></div><div><strong>Hospital Digital Twin</strong><small>โรงพยาบาลตัวอย่าง</small></div></div>
   <div className="metrics">
    {realStats ? <>
     <div className="metric"><span className="metricIcon blue"><Users size={24}/></span><div><span>ผู้ป่วยจริงวันนี้</span><strong>{realStats.total} <em>คน</em></strong></div></div>
     <div className="metric"><span className="metricIcon amber"><Clock size={24}/></span><div><span>รอคิวเฉลี่ยตอนนี้</span><strong>{realStats.wait===undefined?'–':realStats.wait} <em>นาที</em></strong></div></div>
     <div className="metric"><span className="metricIcon blue"><UsersRound size={24}/></span><div><span>กำลังรับบริการ</span><strong>{realStats.serving} <em>คน</em></strong></div></div>
     <div className="metric"><span className="metricIcon blue"><Stethoscope size={24}/></span><div><span>ห้องตรวจที่เปิด</span><strong>{realStats.rooms} / {realStats.allRooms}</strong></div></div>
    </> : <>
    <div className="metric"><span className="metricIcon blue"><Users size={24}/></span><div><span>ผู้ป่วยทั้งหมดวันนี้</span><strong>{todayTotal.toLocaleString()} <em>คน</em></strong></div><b className="positive">+12%</b></div>
    <div className="metric"><span className="metricIcon amber"><Clock size={24}/></span><div><span>รอคิวเฉลี่ย</span><strong>{Math.round(28*(0.4+0.6*opdK))} <em>นาที</em></strong></div><b className="positive">−5%</b></div>
    <div className="metric"><span className="metricIcon blue"><UsersRound size={24}/></span><div><span>กำลังรับบริการ</span><strong>{Math.round(327*campusRatio)} <em>คน</em></strong></div></div>
    <div className="metric"><span className="metricIcon blue"><Stethoscope size={24}/></span><div><span>ห้องตรวจที่ใช้งาน</span><strong>{roomsUsed} / 56</strong></div><b className="positive">{Math.round(roomsUsed/56*100)}%</b></div>
    </>}
   </div>
   <div className={'clock'+(clockOffset?' testing':'')}><strong>{clock.time}</strong><small>{clock.date}</small>{clockOffset!==0 && <button className="testBadge" title="กำลังใช้เวลาทดสอบ · ปรับที่ ตั้งค่า → โหมดทดสอบ" onClick={()=>setActiveNav('ตั้งค่า')}>ทดสอบ</button>}</div>
   <LiveStatusBadge status={live.status} at={live.snapshot?.at} source={live.snapshot?.source}/>
   {queueSync.user && <UserChip user={queueSync.user} logout={queueSync.logout}/>}
  </header>

  <section className="mapStage">
   <div className="sceneFrame">
    <HospitalScene view={view} selectedBuilding={selected} onSelectBuilding={id=>{ setSelectedRoom(null); setSelected(id||null); }} activeFloor={activeFloor} onSelectFloor={pickFloor}
     mode={mode} showLabels={showLabels} highlightFlow={hoverFlow??pinnedFlow} hiddenTypes={hiddenTypes} showDensity={showDensity} hour={replay ? replay.t/60 : hour} liveKey={liveKey} selectedRoom={activeRoom} selectedDept={activeDept} hiddenLabels={layers.hidden} showFlows={layers.flows} routeDetail={!!replay} soloPatient={replay?.solo ? replay.id : null} onSelectRoom={selectRoom}
     patients={patients} selectedPatient={selectedPatient} onSelectPatient={selectPatient} selectedKiosk={selectedKiosk} onSelectKiosk={selectKiosk} onPickPerson={pickPerson} onThumbnails={setThumbs} paused={!onMap} apiRef={sceneApi}/>
   </div>

   <nav className="nav">
    {navItems.filter(([,label])=>label!=='ตั้งค่า' || !queueSync.online || canDo(queueSync.user,'supervisor')).map(([Icon,label])=><button key={label} className={activeNav===label?'navItem selected':'navItem'} onClick={()=>setActiveNav(label)}><Icon size={20}/>{label}
     {label==='การแจ้งเตือน' && openAlerts>0 && <span className="navBadge" aria-label={`${openAlerts} รายการรอดำเนินการ`}>{openAlerts}</span>}</button>)}
   </nav>

   {activeNav==='ติดตามคิว' && <QueuePage patients={patients} minute={minute} timeNote={timeNote} onOpenPatient={openOnMap}
    queue={{...queueSync,canAct:following,onNow:()=>{ setPlaying(false); setFollowing(true); }}} assist={assist}
    onOpenSettings={g=>{ setSettingsFocus(g); setActiveNav('ตั้งค่า'); }} onOpenPlace={openPlaceOnMap}/>}
   {activeNav==='ศูนย์อัจฉริยะ' && <CommandPage base={basePatients} patients={patients} minute={minute} queue={{events:queueSync.events,send:queueSync.send,canAct:following}} assist={assist} timeNote={timeNote}/>}
   {activeNav==='สถิติและรายงาน' && <StatsPage patients={patients} minute={minute} timeNote={timeNote}/>}
   {activeNav==='การแจ้งเตือน' && <AlertsPage alerts={opsAlerts} rules={rules} onRules={saveRules} acks={acks} onAck={ackAlert} minute={minute} timeNote={timeNote} onOpenPatient={openOnMap}/>}
   {activeNav==='ผังโรงพยาบาล' && <CapacityPage patients={patients} minute={minute} timeNote={timeNote} onOpenPatient={openOnMap}/>}
   {activeNav==='ตั้งค่า' && <SettingsPage settings={queueSync.settings} save={queueSync.saveSettings} events={queueSync.events} minute={minute} timeNote={timeNote} focusGroup={settingsFocus}
     user={queueSync.online ? queueSync.user : null} listUsers={queueSync.listUsers} saveUser={queueSync.saveUser} sync={queueSync}/>}

   {onMap && <>
   <div className="viewBar">
    <strong>มุมมอง</strong>
    <div className="segmented">{views.map(([value,label])=><button key={value} className={view===value?'active':''} onClick={()=>changeView(value)}>{label}</button>)}</div>
    <button className={'layerBtn'+(layersOpen?' on':'')} aria-expanded={layersOpen} onClick={()=>setLayersOpen(o=>!o)}><Tags size={16}/>ป้ายบนแผนที่<em>{LABEL_KINDS.length-layers.hidden.length}/{LABEL_KINDS.length}</em></button>
   </div>
   {layersOpen && <LayersPanel layers={layers} onChange={saveLayers} onClose={()=>setLayersOpen(false)}/>}
   <div className="peopleFilter" role="group" aria-label="เลือกประเภทบุคคลที่แสดง">
    <span>แสดงบุคคล</span>
    {personTypes.map(t=>{const on = !hiddenTypes.includes(t.id);return <button key={t.id} className={on?'':'off'} aria-pressed={on} onClick={()=>toggleType(t.id)}>
     <i style={{background:on?t.color:'transparent',borderColor:t.accent}}/>{t.name}
    </button>;})}
    {hiddenTypes.length>0 && <button className="reset" onClick={()=>setHiddenTypes([])}>แสดงทั้งหมด</button>}
   </div>
   {toast && <div className="mapToast" role="status">{toast}</div>}
   {serviceNote(minute) && <div className="mapServiceNote">{serviceNote(minute)}</div>}
   <div className="mapHint" aria-hidden>ลากเพื่อเลื่อน · {mode==='3d'?'คลิกขวาลากเพื่อหมุน · ':''}ล้อเมาส์ซูมตรงตำแหน่งเมาส์</div>
   <div className="viewSwitch">{(['2d','3d'] as const).map(m=><button key={m} className={mode===m?'active':''} onClick={()=>setMode(m)}>{m.toUpperCase()}</button>)}</div>

   {patient ? <PatientCard p={patient} minute={minute} onClose={()=>setSelectedPatient(null)} onReplay={()=>startReplay(patient)} replaying={replay?.id===patient.id}/>
   : kiosk ? <KioskCard k={kiosk} patients={patients} minute={minute} onClose={()=>setSelectedKiosk(null)} onPick={selectKiosk}/>
   : (layers.summary || roomDuty) && <div className="sceneInfo">
    <div className="sceneInfoHead"><span className="infoIcon"><info.Icon size={20}/></span><strong>{info.title}</strong>
     {info.onClose && <button className="infoClose" aria-label="ปิด" onClick={info.onClose}><X size={16}/></button>}</div>
    {info.sub && <p className="sceneInfoSub">{info.sub}</p>}
    {info.lines?.map(line=><p key={line} className="sceneInfoLine">{line}</p>)}
    <div className="infoStats">{info.stats.map(st=><div key={st.label}><small>{st.label}</small><b className={st.tone??''}>{st.value}{st.unit && <em> {st.unit}</em>}</b></div>)}</div>
   </div>}

   <div className={'flowLegend'+(legendOpen?' open':'')}>
    <button className="legendHead" aria-expanded={legendOpen} onClick={()=>setLegendOpen(o=>!o)}>
     <strong>เส้นทางผู้ป่วย <small>(จำลอง)</small></strong>
     {!legendOpen && <span className="legendDots">{demoFlows.map(f=><i key={f.id} style={{background:f.color}}/>)}</span>}
     {legendOpen?<ChevronDown size={16}/>:<ChevronUp size={16}/>}
    </button>
    {legendOpen && <>{demoFlows.map(f=>{const lit = (hoverFlow??pinnedFlow)===f.id, dim = !!(hoverFlow??pinnedFlow) && !lit;
     return <button key={f.id} className={(lit?'lit':'')+(dim?' dim':'')} aria-pressed={pinnedFlow===f.id}
      onMouseEnter={()=>setHoverFlow(f.id)} onMouseLeave={()=>setHoverFlow(null)} onClick={()=>setPinnedFlow(p=>p===f.id?null:f.id)}>
      <i style={{background:f.color}}/>{f.name}
     </button>;})}
    <p>ไม่ใช่ตำแหน่งผู้ป่วยจริง · คลิกเพื่อไฮไลต์เส้น</p></>}
   </div>

   {replay && replayPatient && <ReplayBar p={replayPatient} r={replay} onChange={u=>setReplay(r=>r && {...r,...u})} onExit={exitReplay}/>}
   {layers.timeline && !replay && <Timeline scope={scope} title={scopeTitle} hour={hour} nowHour={clock.hour} onHour={h=>{ setPlaying(false); setFollowing(false); setHour(h); }}
    playing={playing} onTogglePlay={()=>{ setFollowing(false); setPlaying(p=>!p); }} onNow={()=>{ setPlaying(false); setFollowing(true); }}
    following={following} liveNow={liveNow} liveKey={liveKey}/>}

   {drawerOpen && <BuildingDrawer thumbs={thumbs} hour={hour} alerts={alerts} present={presentNow} current={view==='campus'?null:panelBuilding.id}
    onPick={pickBuilding} onClose={()=>setDrawerOpen(false)}/>}
   <div className="bottomServices"><button className="drawerToggle" aria-expanded={drawerOpen} onClick={()=>setDrawerOpen(o=>!o)}><Building2 size={18}/><span>อาคาร<br/>ทั้งหมด</span><ChevronUp size={14}/></button>{pointsNow.map(p=>{const Icon=serviceIcons[p.id]??ClipboardList;return <div key={p.id}>
    <span className="serviceIcon" style={{color:statusColor(p.status),borderColor:statusColor(p.status)}}><Icon size={18}/></span>
    <span><b>{p.name}</b><small style={{color:statusColor(p.status)}}>{p.queue} <em>คน</em></small></span>
   </div>;})}</div>

   <aside className="side">
    <div className="searchBox">
     <label className="search"><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="ค้นหาแผนก ชื่อแพทย์ เลขคิว หรือ HN"
      onKeyDown={e=>{ if (e.key==='Enter') { if (results[0]) selectPatient(results[0].id); else if (deptResults[0]) openDept(deptResults[0]); else if (doctorResults[0]) { selectRoom(doctorResults[0].room.id); setQuery(''); } } if (e.key==='Escape') setQuery(''); }}/></label>
     {query.trim() && <div className="searchResults" role="listbox">
      {deptResults.length>0 && <><h5>แผนก / จุดบริการ</h5>{deptResults.map(d=><button key={d.buildingId+d.level+d.name} role="option" className="deptHit" onClick={()=>openDept(d)}>
       <MapPin size={15}/><span><b>{d.name}</b><small>{d.place}{d.rooms && ` · ${d.rooms}`}</small></span>{d.off ? <em className="off">งดให้บริการ</em> : <em>ดูบนแผนที่</em>}</button>)}
       </>}
      {doctorResults.length>0 && <><h5>แพทย์ · {fmtHour(hour)}</h5>{doctorResults.map(d=><button key={d.room.id+d.from} role="option" className="deptHit docHit" onClick={()=>{ selectRoom(d.room.id); setQuery(''); }}>
       <Stethoscope size={15}/><span><b>{d.name}</b><small>{d.room.name} · {d.room.dept} · {d.place}</small></span>
       <em className={d.status}>{d.status==='active' ? `ตรวจอยู่ ถึง ${hh(d.to)}:00` : d.status==='break' ? 'พักอยู่' : `เข้าตรวจ ${hh(d.from)}:00`}</em></button>)}</>}
      {(deptResults.length>0 || doctorResults.length>0) && results.length>0 && <h5>ผู้ป่วย</h5>}
      {results.length ? results.map(p=>{ const st = patientAt(p,minute); return <button key={p.id} role="option" onClick={()=>selectPatient(p.id)}>
       <b>{p.queue}</b><span>{maskHN(p.hn)} · {p.dept}</span>
       <em style={{color:st?patientColor[st.status]:'#8496a9'}}>{st?statusText[st.status]:'กลับบ้านแล้ว'}</em>
      </button>; }) : !deptResults.length && !doctorResults.length && <p>ไม่พบแผนก แพทย์ หรือผู้ป่วยตามคำค้น</p>}
     </div>}
    </div>
    {(view==='campus'||view==='building') && <section className="panel">
     <div className="panelHead"><h3>ผู้ป่วยที่ต้องติดตาม</h3><small className="panelMeta">{fmtHour(hour)}</small></div>
     <div className="badgeLegend">{(['waiting','serving','result','long','missed','ward','done'] as const).map(k=><span key={k}><i style={{background:patientColor[k]}}/>{statusText[k]}</span>)}</div>
     {alerts.slice(0,4).map(a=><button key={a.p.id} className="alertRow" onClick={()=>selectPatient(a.p.id)}>
      <i style={{background:patientColor[a.status]}}/><b>{a.p.queue}</b>
      <span>{a.status==='missed' ? 'เรียกคิวแล้วไม่มา' : `${stepText[a.step.kind].wait} ${fmtDur(a.stepWait)}`}</span>
     </button>)}
     {!alerts.length && <p className="rosterNone" style={{paddingLeft:6}}>ไม่มีผู้ป่วยรอเกิน {LONG_WAIT} นาที</p>}
     {bottleneck && <p className="note">คอขวดวันนี้: {stepText[bottleneck.kind].wait} เฉลี่ย {bottleneck.avg} นาที{liveData?'':' · ข้อมูลจำลอง'}</p>}
    </section>}
    <section className="panel"><h3>ชั้นของ{panelBuilding.name.replace(/ \(.*\)$/,'')}</h3>
     {panelNow.floors.map(f=><button key={f.level} className={'floorRow'+(activeFloor===f.level?' floorActive':'')} onClick={()=>pickFloor(f.level)}>
      <b>ชั้น {f.level}</b><span title={f.desc}>{f.depts.map((d,i)=><Fragment key={d}>{i>0 && ' · '}<span className={isOff(`dept:${d}`)?'deptOff':''}>{d}</span></Fragment>)}</span><em className={densityLevel(f.count)}>{f.count} คน</em>
     </button>)}
    </section>
    {(view==='floor'||view==='department') && <section className="panel">
     <div className="panelHead"><h3>แผนกและแพทย์ออกตรวจ</h3><small className="panelMeta">ชั้น {activeFloor} · {fmtHour(hour)}</small></div>
     {depts.map((d,i)=>{ const rows = duties.filter(x=>x.room.deptIndex===i); return <div key={d.name} className="rosterDept">
      <button className={'deptRow'+(activeDept===d.name?' on':'')} onClick={()=>{ setSelectedRoom(null); setSelectedDept({buildingId:panelBuilding.id,level:activeFloor,name:d.name}); changeView('department'); }}><i style={{background:d.color}}/><span>{d.name}</span><em className={d.status}>{d.queue} คน</em></button>
      {rows.map(x=><button key={x.room.id} className={'rosterRow'+(activeRoom===x.room.id?' on':'')} onClick={()=>selectRoom(x.room.id)}>
       <b>{x.room.number}</b><span>{x.current && x.status!=='vacant' ? doctorName(x.current.doctor,true) : '—'}</span>
       <small>{x.current ? `${hh(x.current.from)}–${hh(x.current.to)}` : ''}</small><em className={'duty '+x.status}>{dutyLabel[x.status]}</em>
      </button>)}
      {rows.length===0 && <p className="rosterNone">ไม่มีห้องตรวจแพทย์ในแผนกนี้</p>}
     </div>; })}
     <p className="note">ตารางเวรจำลอง · ชื่อแพทย์สมมติ · คลิกห้องเพื่อดูบนแผนที่</p>
    </section>}
    <section className="panel">
     <div className="panelHead"><h3>ความหนาแน่นของพื้นที่</h3>
      <button role="switch" aria-checked={showDensity} className={'switch'+(showDensity?' on':'')} onClick={()=>setShowDensity(d=>!d)}><span/>{showDensity?'แสดงบนแผนที่':'ซ่อน'}</button>
     </div>
     <div className="heatbar"/>
     <div className="heatLabels"><span>น้อย<small>&lt; {DENSITY_LOW}</small></span><span>ปานกลาง<small>{DENSITY_LOW}–{DENSITY_HIGH}</small></span><span>มาก<small>&gt; {DENSITY_HIGH}</small></span></div>
     <p className="note">จำนวนคนต่อชั้นหรือต่อโซนแผนก · มุมมองภาพรวมใช้ค่าเฉลี่ยต่อชั้นของแต่ละอาคาร (ข้อมูลจำลอง)</p>
    </section>
    <section className="panel miniMap"><h3>แผนผังโดยรวม</h3>
     <div className="miniMapBody">
      <MiniMap selected={selected} onSelect={setSelected} showDensity={showDensity} hour={hour}/>
      <div className="miniControls">
       <button aria-label="ซูมเข้า" onClick={()=>sceneApi.current?.zoomBy(1.25)}><Plus size={18}/></button>
       <button aria-label="ซูมออก" onClick={()=>sceneApi.current?.zoomBy(0.8)}><Minus size={18}/></button>
       <button aria-label="กลับมุมมองเริ่มต้น" onClick={()=>{setView('campus');sceneApi.current?.reset();}}><LocateFixed size={18}/></button>
       <button aria-label="แสดง/ซ่อนป้ายชื่อ" className={showLabels?'':'off'} onClick={()=>setShowLabels(s=>!s)}><Layers size={18}/></button>
      </div>
     </div>
    </section>
   </aside>
   </>}
  </section>
  {/* Online and nobody signed in on this browser: staff sign in first (offline keeps the local demo mode). */}
  {queueSync.online && queueSync.authReady && !queueSync.user && <LoginScreen login={queueSync.login}/>}
 </main>;
}

// ---- Map layers menu: pick which labels and overlays the map shows ----------------------------------------
type MapLayers = {hidden:LabelKind[]; flows:boolean; summary:boolean; timeline:boolean};
const LABEL_KINDS:[LabelKind,string,string][] = [
 ['building','ชื่ออาคาร / ทางเข้า','ป้ายอาคาร ทางเข้า ลานจอดรถ'],
 ['zone','ชื่อแผนก','ชื่อแผนกและจำนวนคนรอ'],
 ['room','ห้องตรวจ · แพทย์','เลขห้องและแพทย์ที่ออกตรวจ'],
 ['counter','จุดซักประวัติ / เคาน์เตอร์','ป้ายจุดบริการในแต่ละแผนก'],
 ['area','ป้ายพื้นที่','เช่น พื้นที่รอ เตียงรวม'],
 ['kiosk','ตู้ Kiosk','ตู้ออกบัตรคิวและสถานะ'],
];
const SIMPLE_LAYERS:MapLayers = {hidden:['counter','area','kiosk'],flows:true,summary:true,timeline:true};
// Defined at module level: a component declared inside the panel would be a new type on every render, so React
// would rebuild every row on each toggle (and the list would jump back to the top).
function LayerRow({on,title,sub,onToggle}:{on:boolean;title:string;sub:string;onToggle:()=>void}) {
 return <label className="layerRow"><span><b>{title}</b><small>{sub}</small></span>
  <span className={'mini-switch'+(on?' on':'')}><input type="checkbox" checked={on} onChange={onToggle}/><i/></span></label>;
}
function LayersPanel({layers,onChange,onClose}:{layers:MapLayers;onChange:(l:MapLayers)=>void;onClose:()=>void}) {
 const ref = useRef<HTMLDivElement>(null);
 useEffect(()=>{ const off = (e:MouseEvent) => { const t = e.target as HTMLElement; if (ref.current && !ref.current.contains(t) && !t.closest('.layerBtn')) onClose(); };
  const esc = (e:KeyboardEvent) => { if (e.key==='Escape') onClose(); };
  document.addEventListener('mousedown',off); document.addEventListener('keydown',esc); return ()=>{ document.removeEventListener('mousedown',off); document.removeEventListener('keydown',esc); }; },[onClose]);
 const toggle = (k:LabelKind) => onChange({...layers,hidden:layers.hidden.includes(k) ? layers.hidden.filter(x=>x!==k) : [...layers.hidden,k]});
 const same = (a:MapLayers,b:MapLayers) => a.flows===b.flows && a.summary===b.summary && a.hidden.length===b.hidden.length && a.hidden.every(x=>b.hidden.includes(x));
 // Presets are about labels and overlays on the map; they leave the timeline as it is.
 const presets:[string,MapLayers][] = ([['เรียบง่าย',SIMPLE_LAYERS],['แสดงทั้งหมด',{hidden:[],flows:true,summary:true}],['ไม่มีป้าย',{hidden:LABEL_KINDS.map(k=>k[0]),flows:false,summary:false}]] as [string,Omit<MapLayers,'timeline'>][])
  .map(([n,l])=>[n,{...l,timeline:layers.timeline}]);
 return <div className="layerPanel" ref={ref} role="dialog" aria-label="เลือกสิ่งที่แสดงบนแผนที่">
  <div className="layerPresets">{presets.map(([name,l])=><button key={name} className={same(layers,l)?'on':''} onClick={()=>onChange(l)}>{name}</button>)}</div>
  <h5>ป้ายชื่อ</h5>
  {LABEL_KINDS.map(([k,title,sub])=><LayerRow key={k} on={!layers.hidden.includes(k)} title={title} sub={sub} onToggle={()=>toggle(k)}/>)}
  <h5>อื่นๆ</h5>
  <LayerRow on={layers.flows} title="เส้นทางผู้ป่วย" sub="เส้นสีแสดงเส้นทางเดินหลัก" onToggle={()=>onChange({...layers,flows:!layers.flows})}/>
  <LayerRow on={layers.summary} title="การ์ดสรุปมุมมอง" sub="กล่องสรุปมุมซ้ายบน (การ์ดห้องที่เลือกยังแสดง)" onToggle={()=>onChange({...layers,summary:!layers.summary})}/>
  <LayerRow on={layers.timeline} title="ความหนาแน่นรายชั่วโมง" sub="แถบกราฟและเลื่อนเวลาด้านล่าง · ซ่อนแล้วแผนที่แสดงเวลาปัจจุบัน" onToggle={()=>onChange({...layers,timeline:!layers.timeline})}/>
  <p className="layerNote">จำค่าไว้ในเครื่องนี้ · แผนกหรือห้องที่ค้นหา/เลือกจะไฮไลต์เสมอ</p>
 </div>;
}

// ---- Journey replay ---------------------------------------------------------------------------------------------
// back: the map's time before the replay, restored on exit.
type Replay = {id:string; from:number; to:number; t:number; playing:boolean; speed:number; skipWait:boolean; solo:boolean; back:{hour:number; following:boolean}};
const REPLAY_SPEEDS:[number,string][] = [[2,'ช้า'],[6,'ปกติ'],[20,'เร็ว']];
const stepTone:Partial<Record<StepKind,string>> = {kiosk:'#64748b',registration:'#2563eb',screening:'#0d9488',exam:'#7c3aed',followup:'#7c3aed',lab:'#dc2626',labResult:'#f59e0b',xray:'#0891b2',pharmacy:'#16a34a',finance:'#ca8a04',triage:'#e11d48',treatment:'#e11d48',leave:'#94a3b8'};
function ReplayBar({p,r,onChange,onExit}:{p:Patient;r:Replay;onChange:(u:Partial<Replay>)=>void;onExit:(keepTime?:boolean)=>void}) {
 const span = Math.max(1,r.to-r.from), pct = (t:number) => `${Math.max(0,Math.min(100,(t-r.from)/span*100))}%`;
 const steps = p.steps.map((st,i)=>({st,i})).filter(({st})=>st.start<r.to);
 const cur = patientAt(p,r.t), idx = cur?.index ?? (r.t>=r.to ? steps.length-1 : 0), now = p.steps[idx];
 const waiting = !!cur && r.t<cur.step.called;
 const caption = !now ? '' : now.kind==='kiosk' ? 'มาถึงโรงพยาบาล · รับบัตรคิวที่ตู้ Kiosk'
  : now.kind==='leave' ? 'เสร็จทุกขั้นตอน · เดินออกจากโรงพยาบาล'
  : waiting ? `${stepText[now.kind].wait} · รอมาแล้ว ${Math.round(r.t-now.start)} นาที` : `${stepText[now.kind].serve} · ${Math.max(1,Math.round(r.t-now.called))} / ${Math.max(1,Math.round(now.end-now.called))} นาที`;
 const seek = (e:React.MouseEvent<HTMLDivElement>) => { const b = e.currentTarget.getBoundingClientRect(); onChange({t:r.from+Math.max(0,Math.min(1,(e.clientX-b.left)/b.width))*span}); };
 return <div className="replayBar" role="region" aria-label={`ย้อนดูเส้นทางคิว ${p.queue}`}>
  <div className="rpHead">
   <span className="rpTitle"><RouteIcon size={16}/> ย้อนดูเส้นทาง · คิว {p.queue}</span>
   <b className="rpClock">{fmtMin(r.t)}</b>
   <span className="rpCaption"><i style={{background:now ? stepTone[now.kind] ?? '#1677ff' : '#1677ff'}}/>ขั้น {idx+1}/{p.steps.length} · {caption}<small>{now?.place.where}</small></span>
   <span className="rpCtl">
    <button aria-label="เริ่มใหม่" title="เริ่มใหม่" onClick={()=>onChange({t:r.from,playing:true})}><RotateCcw size={15}/></button>
    <button className="rpPlay" aria-label={r.playing?'หยุด':'เล่น'} onClick={()=>onChange(r.t>=r.to ? {t:r.from,playing:true} : {playing:!r.playing})}>{r.playing ? <Pause size={16}/> : <Play size={16}/>}</button>
    <span className="rpSpeed">{REPLAY_SPEEDS.map(([v,l])=><button key={v} className={r.speed===v?'on':''} onClick={()=>onChange({speed:v})}>{l}</button>)}</span>
    <button className={'rpSkip'+(r.solo?' on':'')} title="ซ่อนคนไข้และญาติคนอื่น (เจ้าหน้าที่และแพทย์ยังแสดง)" onClick={()=>onChange({solo:!r.solo})}><UserRound size={14}/> เฉพาะคนไข้นี้</button>
    <button className={'rpSkip'+(r.skipWait?' on':'')} title="ช่วงที่รอคิวเล่นเร็วขึ้น 5 เท่า" onClick={()=>onChange({skipWait:!r.skipWait})}><FastForward size={14}/> เร่งช่วงรอ</button>
    <button className="rpExit" onClick={()=>onExit()}>ออก</button>
   </span>
  </div>
  <div className="rpTrack" onClick={seek} title="คลิกเพื่อไปยังช่วงเวลานั้น">
   {steps.map(({st,i})=>{ const tone = stepTone[st.kind] ?? '#1677ff', end = Math.min(st.end,r.to), called = Math.min(st.called,end);
    return <span key={i}>
     {called>st.start && <i className="rpWait" style={{left:pct(st.start),width:`calc(${pct(called)} - ${pct(st.start)})`,background:tone}} title={`${stepText[st.kind].wait} ${Math.round(called-st.start)} นาที`}/>}
     {end>called && <i className="rpServe" style={{left:pct(called),width:`calc(${pct(end)} - ${pct(called)})`,background:tone}} title={`${stepText[st.kind].serve} ${Math.round(end-called)} นาที`}/>}
    </span>; })}
   <em className="rpHead2" style={{left:pct(r.t)}}/>
  </div>
  <div className="rpSteps">{steps.map(({st,i})=><button key={i} className={i===idx?'on':i<idx?'done':''} onClick={()=>onChange({t:st.start+0.01})} title={st.place.where}>
   <i style={{background:stepTone[st.kind] ?? '#1677ff'}}>{i+1}</i><span>{stepText[st.kind].serve}<small>{fmtMin(st.start)}</small></span></button>)}</div>
  <div className="rpFoot"><span><i className="rpWait sw"/>รอ</span><span><i className="rpServe sw"/>รับบริการ / ทำกิจกรรม</span>
   <span className="muted">เล่นถึง {fmtMin(r.to)} {r.to<p.steps[p.steps.length-1].end ? '(เวลาปัจจุบัน)' : '(กลับบ้าน)'}</span>
   <button className="linkBtn dark" onClick={()=>onExit(true)}>อยู่ที่เวลานี้ต่อ</button></div>
 </div>;
}
