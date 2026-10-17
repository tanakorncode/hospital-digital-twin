// Command-centre analytics. Everything here works on counts per service and time — no names, no HN, no clinical
// data — so it can be handed to an AI service or a data warehouse without exposing any patient.
import { fmtDur, fmtMin, opdClinics, patientAt, stepText, type Patient, type PatientState, type StepKind } from './patients';
import { allStations, openReports, stationDoctor, type AssistView, type QueueEvent } from './queue';
import { roomOpenIntervals, roomShifts } from './scene-data';

// One "service" = a clinic (screening → exam → follow-up) or a shared service point (registration, lab, pharmacy…).
export const serviceKeyOf = (s:PatientState) => s.p.flow==='er' && ['triage','treatment','admit'].includes(s.step.kind) ? 'er'
 : s.p.clinicKey && ['screening','exam','followup','labResult'].includes(s.step.kind) ? `clinic:${s.p.clinicKey}` : s.step.kind;
const svcName:Record<string,string> = {registration:'ลงทะเบียน',lab:'ห้องเจาะเลือด',xray:'รังสีวิทยา',pharmacy:'ห้องยา',finance:'การเงิน',er:'ห้องฉุกเฉิน'};
const clinics = {get:(key:string)=>opdClinics().find(c=>c.key===key)}; // live: departments can be added in Settings
export const serviceName = (key:string) => key.startsWith('clinic:') ? clinics.get(key.slice(7))?.dept ?? key : svcName[key] ?? stepText[key as StepKind]?.serve ?? key;
// Stations that serve a service now (rooms only while a doctor is in).
export function serviceStations(key:string, minute:number) {
 const list = key.startsWith('clinic:') ? allStations().filter(st=>st.clinicKey===key.slice(7) && st.kinds.includes('exam'))
  : allStations().filter(st=>st.group===`counter:${key==='er'?'triage':key}`);
 return list.filter(st=>!st.roomId || stationDoctor(st,minute)?.status==='active');
}
const isWaiting = (s:PatientState, m:number) => m<s.step.called && s.status!=='done';
function countWaiting(patients:Patient[], minute:number, keyOf:(s:PatientState)=>string|undefined=serviceKeyOf) {
 const c = new Map<string,number>();
 patients.forEach(p=>{ const s = patientAt(p,minute); if (s && isWaiting(s,minute) && s.step.kind!=='kiosk' && s.p.flow!=='ipd') { const k = keyOf(s); if (k) c.set(k,(c.get(k) ?? 0)+1); } });
 return c;
}

export type FcPoint = {t:number; plan:number; actual?:number; fc?:number; lo?:number; hi?:number};
export type ServiceFc = {key:string; name:string; points:FcPoint[]; now:number; planNow:number; ratio:number; peak:number; peakAt:number; servers:number};
// Nowcast: the usual day's plan for each service, scaled by how far today is running ahead of or behind it right now.
// The adjustment fades over ~90 minutes and the band widens with distance — it is an estimate, shown as one.
export function forecast(base:Patient[], live:Patient[], minute:number, horizon=180, step=15, back=120, keyOf:(s:PatientState)=>string|undefined=serviceKeyOf, nameOf:(k:string)=>string=serviceName, serversOf:(k:string,m:number)=>number=(k,mm)=>serviceStations(k,mm).length) {
 const m = Math.floor(minute), start = Math.max(0,Math.floor((m-back)/step)*step), times:number[] = [];
 for (let t=start; t<=m+horizon; t+=step) times.push(Math.min(t,24*60-1));
 if (!times.includes(m)) times.push(m);
 times.sort((a,b)=>a-b);
 const plan = new Map(times.map(t=>[t,countWaiting(base,t,keyOf)])), actual = new Map(times.filter(t=>t<=m).map(t=>[t,countWaiting(live,t,keyOf)]));
 const keys = new Set<string>(); [...plan.values(),...actual.values()].forEach(c=>c.forEach((_,k)=>keys.add(k)));
 const services:ServiceFc[] = [...keys].map(key=>{
  const now = actual.get(m)?.get(key) ?? 0, planNow = plan.get(m)?.get(key) ?? 0, ratio = Math.max(0.4,Math.min(3,(now+2)/(planNow+2)));
  const points = times.map(t=>{ const p = plan.get(t)?.get(key) ?? 0, pt:FcPoint = {t,plan:p};
   if (t<=m) pt.actual = actual.get(t)?.get(key) ?? 0;
   if (t>=m) { const dt = t-m, r = 1+(ratio-1)*Math.exp(-dt/90), fc = t===m ? now : p*r, w = 0.12+0.12*dt/60;
    pt.fc = fc; pt.lo = Math.max(0,fc*(1-w)-1); pt.hi = fc*(1+w)+1; }
   return pt; });
  const ahead = points.filter(p=>p.t>m && p.t<=m+120 && p.fc!==undefined), peakPt = ahead.reduce((a,p)=>(p.fc ?? 0)>(a?.fc ?? -1)?p:a,ahead[0]);
  return {key,name:nameOf(key),points,now,planNow,ratio,peak:peakPt?.fc ?? now,peakAt:peakPt?.t ?? m,servers:serversOf(key,m)};
 }).filter(s=>s.points.some(p=>(p.plan+(p.actual ?? 0))>0)).sort((a,b)=>b.peak-a.peak);
 const total = times.map(t=>{ const pt:FcPoint = {t,plan:services.reduce((n,s)=>n+(s.points.find(p=>p.t===t)?.plan ?? 0),0)};
  if (t<=m) pt.actual = services.reduce((n,s)=>n+(s.points.find(p=>p.t===t)?.actual ?? 0),0);
  if (t>=m) { const f = services.map(s=>s.points.find(p=>p.t===t)!); pt.fc = f.reduce((n,p)=>n+(p.fc ?? 0),0); pt.lo = f.reduce((n,p)=>n+(p.lo ?? 0),0); pt.hi = f.reduce((n,p)=>n+(p.hi ?? 0),0); }
  return pt; });
 return {times,services,total,minute:m};
}
export type Forecast = ReturnType<typeof forecast>;

// What to do about it — only with the people, rooms and equipment already there (no extra staff, desks, PCs or
// screens): lend a person between services whose staff can cover for each other, move breaks out of the peak,
// tell waiting patients early, and — for management — flag peaks that keep coming back.
export type AdviceKind = 'reassign'|'break'|'notify'|'plan';
export type Advice = {id:string; kind:AdviceKind; title:string; why:string; how:string; tags:string[]; confidence:'สูง'|'ปานกลาง'|'ต่ำ'; from:number; to:number; key:string};
const groupKeyOf = (s:PatientState) => { const k = s.step.kind;
 if ((k==='exam'||k==='followup') && s.p.clinicKey) return `exam:${s.p.clinicKey}`;
 if (k==='screening' && s.p.clinicKey) return `screening:${s.p.clinicKey}`;
 return ['registration','pharmacy','finance','lab','xray'].includes(k) ? `counter:${k}` : undefined; };
const groupName = (g:string) => { const [kind,key] = g.split(':'); const c = clinics.get(key);
 return kind==='exam' ? `ห้องตรวจ${c?.dept ?? ''}` : kind==='screening' ? `ซักประวัติ${c?.dept ?? ''}` : svcName[key] ?? key; };
const groupServers = (g:string, m:number) => allStations().filter(st=>st.group===g && (!st.roomId || stationDoctor(st,m)?.status==='active')).length;
// Who can cover for whom, and what a lent person does without a new counter.
const pools:{name:string; match:(g:string)=>boolean; staff:string; task:string}[] = [
 {name:'nurse',match:g=>g.startsWith('screening:'),staff:'พยาบาลซักประวัติ',task:'วัดสัญญาณชีพและซักประวัติเบื้องต้นในพื้นที่รอ ใช้เครื่องวัดแบบพกพา ไม่ต้องตั้งช่องใหม่'},
 {name:'clerk',match:g=>g==='counter:registration'||g==='counter:finance',staff:'เจ้าหน้าที่ลงทะเบียน/การเงิน',task:'ช่วยตรวจสิทธิ์และเอกสารที่หน้าคิว หรือแนะนำการใช้ตู้ Kiosk ไม่ต้องเปิดช่องเพิ่ม'},
];
const per = (peak:number, servers:number) => peak/Math.max(1,servers);
const confOf = (s:ServiceFc):Advice['confidence'] => { const p = s.points.find(x=>x.t===s.peakAt); const w = p && s.peak ? ((p.hi ?? s.peak)-(p.lo ?? s.peak))/Math.max(1,s.peak) : 1; return w<0.5 ? 'สูง' : w<0.9 ? 'ปานกลาง' : 'ต่ำ'; };
const busyWindow = (s:ServiceFc, m:number, limit:number) => { const pts = s.points.filter(p=>p.t>m && p.t<=m+120 && (p.fc ?? 0)/Math.max(1,s.servers)>limit); return pts.length ? [pts[0].t,pts[pts.length-1].t+15] as const : undefined; };
// Break hours of a room = roster hours that are not open hours.
function breakHours(roomId:string) { const room = opdClinics().flatMap(c=>c.rooms).find(r=>r.id===roomId); if (!room) return [];
 const open = roomOpenIntervals(room), out:number[] = [];
 roomShifts(room).forEach(sh=>{ for (let h=sh.from; h<sh.to; h++) if (!open.some(([a,b])=>h*60>=a && h*60<b)) out.push(h); });
 return out; }
export function adviseStaffing(base:Patient[], live:Patient[], minute:number, fc:Forecast):Advice[] {
 const m = Math.floor(minute), out:Advice[] = [];
 const gfc = forecast(base,live,m,120,15,0,groupKeyOf,groupName,groupServers).services;
 // 1. Lend a person within a pool: from a group that will sit nearly idle to one that will run long.
 pools.forEach(pool=>{
  const list = gfc.filter(s=>pool.match(s.key) && s.servers>0);
  const needy = list.filter(s=>per(s.peak,s.servers)>5).sort((a,b)=>per(b.peak,b.servers)-per(a.peak,a.servers));
  const spare = list.filter(s=>s.servers>=2 && per(s.peak,s.servers)<1.5).sort((a,b)=>per(a.peak,a.servers)-per(b.peak,b.servers));
  needy.slice(0,2).forEach((n,i)=>{ const d = spare[i]; if (!d) return; const w = busyWindow(n,m,5) ?? [m,m+60];
   out.push({id:`re-${n.key}-${d.key}`,kind:'reassign',key:n.key,from:w[0],to:w[1],confidence:confOf(n),tags:['ไม่มีค่าใช้จ่าย','ใช้คนที่มีอยู่'],
    title:`ยืม${pool.staff} 1 คนจาก${d.name}ไปช่วย${n.name} ช่วง ${fmtMin(w[0])}–${fmtMin(w[1])}`,
    why:`${n.name}คาดว่ามีคนรอสูงสุด ~${Math.round(n.peak)} คน ต่อ ${n.servers} ช่อง · ${d.name}คาดว่ารอไม่เกิน ~${Math.round(d.peak)} คน ต่อ ${d.servers} ช่อง`,how:pool.task}); });
 });
 // 2. Breaks that fall in a clinic's peak: move them later, or stagger rooms that break at the same hour.
 gfc.filter(s=>s.key.startsWith('exam:') && per(s.peak,Math.max(1,s.servers))>4).forEach(s=>{
  const w = busyWindow(s,m,4); if (!w) return;
  const rooms = allStations().filter(st=>st.group===s.key && st.roomId), clash = new Map<number,string[]>();
  rooms.forEach(st=>breakHours(st.roomId!).filter(h=>h*60<w[1] && (h+1)*60>w[0] && h*60>=m-30).forEach(h=>clash.set(h,[...(clash.get(h) ?? []),st.label.replace('ห้องตรวจ ','')])));
  clash.forEach((list,h)=>out.push({id:`br-${s.key}-${h}`,kind:'break',key:s.key,from:h*60,to:(h+1)*60,confidence:confOf(s),tags:['ไม่มีค่าใช้จ่าย','ทำได้ทันที'],
   title:list.length>1 ? `${s.name}: ห้อง ${list.join(', ')} พักพร้อมกัน ${fmtMin(h*60)}–${fmtMin((h+1)*60)} — สลับให้พักคนละช่วง` : `${s.name}: เลื่อนเวลาพักห้อง ${list[0]} (${fmtMin(h*60)}–${fmtMin((h+1)*60)}) ออกจากช่วงคิวพีค`,
   why:`ช่วง ${fmtMin(w[0])}–${fmtMin(w[1])} คาดว่ามีคนรอสูงสุด ~${Math.round(s.peak)} คน ต่อ ${s.servers} ห้องที่ออกตรวจ`,
   how:list.length>1 ? 'ให้ห้องหนึ่งพักก่อน อีกห้องพักหลัง ห้องตรวจจะไม่ว่างพร้อมกัน' : 'พักหลังช่วงพีค หรือแบ่งพักเป็น 2 ช่วงสั้น ๆ ตามที่แพทย์สะดวก'}));
 });
 // 3. Tell waiting patients early (LINE): they can step away instead of crowding the waiting area.
 fc.services.filter(s=>s.servers>0 && per(s.peak,s.servers)>8).slice(0,2).forEach(s=>{ const w = busyWindow(s,m,8) ?? [m,m+60];
  out.push({id:`nt-${s.key}`,kind:'notify',key:s.key,from:w[0],to:w[1],confidence:confOf(s),tags:['ต้นทุนต่ำ','ข้อความ LINE'],
   title:`แจ้งผู้ป่วยที่รอ${s.name}ว่าคิวแน่นถึง ~${fmtMin(w[1])}`,why:`คาดว่ามีคนรอสูงสุด ~${Math.round(s.peak)} คน (≈${per(s.peak,s.servers).toFixed(1)} คน/จุด)`,
   how:'ส่งข้อความว่าไปทำธุระได้ ระบบจะแจ้งเมื่อเหลือ 3 คิว · ลดความแออัดในพื้นที่รอ ไม่ใช่การเลื่อนนัด'}); });
 // 4. For management: the tightest spot today — if it repeats on other days, revisit the roster (shift times, not headcount).
 const worst = gfc.filter(s=>s.servers>0).sort((a,b)=>per(b.peak,b.servers)-per(a.peak,a.servers))[0];
 if (worst && per(worst.peak,worst.servers)>6) out.push({id:`pl-${worst.key}`,kind:'plan',key:worst.key,from:worst.peakAt,to:worst.peakAt+60,confidence:'ต่ำ',tags:['เชิงนโยบาย','ไม่ต้องทำวันนี้'],
  title:`${worst.name}เป็นคอขวดช่วง ~${fmtMin(worst.peakAt)}`,why:`คาดว่า ≈${per(worst.peak,worst.servers).toFixed(1)} คนต่อจุด สูงสุดของวัน`,
  how:'ถ้าเกิดซ้ำหลายวัน ให้ทบทวนเวลาเข้าเวรหรือเวลานัดหมายช่วงนี้ (ย้ายเวลา ไม่ใช่เพิ่มคน) · ดูแนวโน้มได้ที่เมนูสถิติ'});
 const order:Record<AdviceKind,number> = {reassign:0,break:1,notify:2,plan:3};
 return out.sort((a,b)=>order[a.kind]-order[b.kind]).slice(0,5);
}

// Things that look wrong right now (all from counts and staff button presses).
export type Anomaly = {level:'critical'|'warn'; title:string; detail:string};
export function anomalies(fc:Forecast, assist:AssistView, events:QueueEvent[]):Anomaly[] {
 const out:Anomaly[] = [];
 fc.services.filter(s=>s.ratio>=1.5 && s.now>=5).forEach(s=>out.push({level:s.ratio>=2?'critical':'warn',title:`${s.name}: คิวมากกว่าปกติ ${Math.round((s.ratio-1)*100)}%`,detail:`ตอนนี้รอ ${s.now} คน · ปกติช่วงนี้ ~${s.planNow} คน`}));
 assist.health.forEach((h,id)=>{ if (h.state==='stalled') out.push({level:'critical',title:`${allStations().find(x=>x.id===id)?.label}: ไม่ตอบรับ`,detail:h.text}); });
 const help = openReports(events); if (help.length) out.push({level:'warn',title:`ผู้ป่วยขอความช่วยเหลือ ${help.length} เรื่อง`,detail:help.slice(0,3).map(e=>e.reason).join(' · ')});
 if (assist.full.size) out.push({level:'critical',title:`คิวเต็มทุกช่อง ${assist.full.size} กลุ่ม`,detail:'ควรเปิดจุดเพิ่มหรือปรับเพดาน'});
 return out.sort((a,b)=>(a.level==='critical'?0:1)-(b.level==='critical'?0:1));
}

// Shift handover, written from the same aggregates — paste into LINE or the handover book. No patient appears in it.
export function handover(fc:Forecast, live:Patient[], advice:Advice[], found:Anomaly[], from:number):{title:string; lines:string[]}[] {
 const m = fc.minute, states = live.map(p=>patientAt(p,m)).filter((s):s is PatientState=>!!s);
 const arrived = live.filter(p=>p.flow!=='ipd' && p.arrival>=from && p.arrival<=m).length, done = live.filter(p=>p.flow!=='ipd' && p.steps.at(-1)!.start>=from && p.steps.at(-1)!.start<=m).length;
 const waiting = states.filter(s=>isWaiting(s,m) && s.p.flow!=='ipd' && s.step.kind!=='kiosk'), long = waiting.filter(s=>s.stepWait>45);
 const avg = waiting.length ? Math.round(waiting.reduce((n,s)=>n+s.stepWait,0)/waiting.length) : 0;
 const worst = [...fc.services].sort((a,b)=>b.now-a.now).slice(0,3).filter(s=>s.now>0);
 const peak = fc.total.filter(p=>p.t>m && p.fc!==undefined).reduce((a,p)=>(p.fc ?? 0)>(a?.fc ?? -1)?p:a,undefined as FcPoint|undefined);
 return [
  {title:`ภาพรวม ${fmtMin(from)}–${fmtMin(m)} น.`,lines:[`ผู้ป่วยนอก/ฉุกเฉินมาถึง ${arrived} คน · รับบริการครบ ${done} คน`,`ตอนนี้รออยู่ ${waiting.length} คน · รอเฉลี่ย ${fmtDur(avg)} · รอเกิน 45 นาที ${long.length} คน`]},
  {title:'จุดที่คิวหนาแน่น',lines:worst.length ? worst.map(s=>`${s.name}: รอ ${s.now} คน (ปกติ ~${s.planNow}) · ${s.servers} จุดให้บริการ`) : ['ไม่มีจุดที่หนาแน่นผิดปกติ']},
  {title:'เรื่องที่ต้องส่งต่อ',lines:found.length ? found.slice(0,5).map(a=>`${a.title} — ${a.detail}`) : ['ไม่มีเรื่องค้าง']},
  {title:'คาดการณ์ 3 ชั่วโมงข้างหน้า',lines:[peak ? `คนรอรวมสูงสุดประมาณ ${Math.round(peak.lo ?? 0)}–${Math.round(peak.hi ?? 0)} คน ช่วง ${fmtMin(peak.t)} น.` : 'ไม่มีข้อมูลคาดการณ์',
   ...advice.filter(a=>a.kind!=='plan').slice(0,3).map(a=>`แนะนำ: ${a.title}`)]},
 ];
}
