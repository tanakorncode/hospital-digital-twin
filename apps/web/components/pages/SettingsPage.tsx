'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { BellRing, Building2, CalendarClock, Clock, Database, Navigation, Stethoscope, FlaskConical, History, KeyRound, Layers, Minus, Plus, RotateCcw, Search, Sparkles, Trash2, UserCog, X, type LucideIcon } from 'lucide-react';
import { fmtMin, opdClinics, screeningCounters, screeningStationId, type Clinic } from '../../lib/patients';
import { CLINIC_FLOORS, DEFAULT_HOURS, buildingStats, builtInDeptCount, buildings, roomsPerFloor, type CustomDept } from '../../lib/scene-data';
import { BookingAdminPane } from './Booking';
import { ApptAdminPane } from './Appointments';
import { NotificationsPane } from './Notifications';
import { WayfindingAdminPane } from './WayfindingAdmin';
import { DEFAULT_RULES, canDo, isLive, roleText, type AuthUser, type QueueSync, type Role, type UserInput, counterServices, everyStation, modeText, queueGroups, rulesFor, scopeName, type AssistMode, type QueueEvent, type QueueGroup, type QueueRules, type QueueSettings, type SettingsPatch } from '../../lib/queue';

// Settings, one topic at a time (left menu). Rules read as sentences with − / + steppers; several changes are saved
// together from a bar at the bottom. Hospital defaults, per-department overrides and the test clock are separate
// panes, so it is always clear what a change applies to.
type Save = (patch:SettingsPatch, audit:{at:number; scope:string; summary:string; by?:string})=>Promise<{ok:boolean;reason?:string}>;
type Commit = (patch:SettingsPatch, scope:string, summary:string, effect:string)=>Promise<boolean>;
type RuleKey = Exclude<keyof QueueRules,'mode'>;
const rules:{key:RuleKey; title:string; desc:string; unit:string; step:number; min:number; max:number; zero?:string}[] = [
 {key:'stallMin',title:'ไม่ตอบรับ',desc:'แจ้งเมื่อเรียกแล้วไม่มีใครกดต่อ หรือมีคนรอแต่ไม่ได้เรียก นานเกินกว่านี้',unit:'นาที',step:1,min:1,max:60},
 {key:'slowFactor',title:'ช้ากว่าปกติ',desc:'แจ้งเมื่อให้บริการคนหนึ่งนานกว่าค่าเฉลี่ยของจุดนั้นวันนี้กี่เท่า',unit:'เท่า',step:0.5,min:1.5,max:5},
 {key:'cap',title:'เพดานคิวต่อห้อง/ช่อง',desc:'รอได้ไม่เกินกี่คน เกินแล้วเสนอย้ายคนที่มาทีหลังไปห้อง/ช่องอื่นในแผนก',unit:'คน',step:1,min:0,max:200,zero:'ไม่จำกัด'},
 {key:'imbalance',title:'เกลี่ยคิว',desc:'เสนอเกลี่ยเมื่อสองห้อง/ช่องในแผนกเดียวกันมีคนรอต่างกันตั้งแต่',unit:'คน',step:1,min:2,max:50},
];
const modes:{id:AssistMode; hint:string}[] = [{id:'off',hint:'แสดงสถานะอย่างเดียว'},{id:'suggest',hint:'เสนอให้ย้าย เจ้าหน้าที่กดยืนยัน'},{id:'auto',hint:'ย้ายเองทันที กดเลิกทำได้'}];
const valText = (k:keyof QueueRules, v:unknown) => k==='mode' ? modeText[v as AssistMode] : k==='cap' && v===0 ? 'ไม่จำกัด' : String(v);
const ruleName:Record<keyof QueueRules,string> = {mode:'ระดับตัวช่วย',stallMin:'เกณฑ์ไม่ตอบรับ',slowFactor:'เกณฑ์ช้ากว่าปกติ',cap:'เพดานคิว',imbalance:'เกณฑ์เกลี่ยคิว'};
const loadPref = (k:string, d:string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
type Pane = 'hours'|'units'|'assist'|'groups'|'history'|'test'|'data'|'booking'|'appts'|'notify'|'wayfinding'|'users';
const panes:{id:Pane; icon:LucideIcon; title:string; sub:string}[] = [
 {id:'hours',icon:Clock,title:'เวลาให้บริการ',sub:'เวลาเปิด–ปิด OPD'},
 {id:'units',icon:Building2,title:'แผนกและจุดบริการ',sub:'เพิ่มแผนก · เปิด–ปิดห้อง/ช่อง'},
 {id:'assist',icon:Sparkles,title:'ตัวช่วยกระจายคิว',sub:'ค่าของทั้งโรงพยาบาล'},
 {id:'groups',icon:Layers,title:'ปรับรายแผนก',sub:'แผนกที่ต่างจากค่าทั้งโรงพยาบาล'},
 {id:'history',icon:History,title:'ประวัติการเปลี่ยน',sub:'ใครเปลี่ยนอะไร เมื่อไร'},
 {id:'test',icon:FlaskConical,title:'โหมดทดสอบ',sub:'เวลาจำลองสำหรับทดสอบ/สาธิต'},
 {id:'data',icon:Database,title:'ข้อมูลผู้ป่วย',sub:'สาธิต หรือ ผู้ป่วยจริง'},
 {id:'booking',icon:CalendarClock,title:'การจองล่วงหน้า',sub:'กติกาและช่วงเวลาให้จอง'},
 {id:'appts',icon:Stethoscope,title:'นัดแพทย์',sub:'กติกาและตารางออกตรวจ'},
 {id:'notify',icon:BellRing,title:'การแจ้งเตือน',sub:'ข้อความถึงผู้ป่วยทาง LINE'},
 {id:'wayfinding',icon:Navigation,title:'QR นำทาง',sub:'จุดหมายและป้าย QR'},
 {id:'users',icon:UserCog,title:'ผู้ใช้งาน',sub:'บัญชีเจ้าหน้าที่และสิทธิ์'},
];
// What each role may open (the API enforces the same). Offline / not connected: everything except accounts and real data.
const panesFor = (u:AuthUser|null):Pane[] => !u ? ['hours','units','assist','groups','history','test']
 : u.role==='admin' ? ['hours','units','assist','groups','history','test','data','booking','appts','notify','wayfinding','users'] : ['groups','history'];

export default function SettingsPage({settings,save,events,minute,timeNote,focusGroup,user=null,listUsers,saveUser,sync}:{settings:QueueSettings;save:Save;events:QueueEvent[];minute:number;timeNote:string;focusGroup?:string|null;
 user?:AuthUser|null;listUsers?:QueueSync['listUsers'];saveUser?:QueueSync['saveUser'];sync?:Pick<QueueSync,'api'|'bookingRev'|'apptRev'|'features'>}) {
 const allowed = panesFor(user);
 const [pane,setPane] = useState<Pane>(focusGroup || !allowed.includes('hours') ? 'groups' : 'hours');
 const [msg,setMsg] = useState<{text:string;bad?:boolean}|null>(null);
 const [by,setBy] = useState('');
 useEffect(()=>{ setBy(loadPref('hdt.operator','')); },[]);
 useEffect(()=>{ if (focusGroup) setPane('groups'); },[focusGroup]);
 useEffect(()=>{ if (!msg) return; const t = setTimeout(()=>setMsg(null),5000); return ()=>clearTimeout(t); },[msg]);
 const commit:Commit = async (patch, scope, summary, effect) => {
  const res = await save(patch,{at:Math.floor(minute),scope,summary,by:by.trim() || undefined});
  setMsg(res.ok ? {text:`บันทึกแล้ว · ${effect}`} : {text:res.reason ?? 'บันทึกไม่สำเร็จ',bad:true});
  return res.ok;
 };
 const history = events.filter(e=>e.action==='config');
 const custom = Object.keys(settings.groups).length+Object.keys(settings.stations).length;
 const offCount = settings.layout?.off?.length ?? 0;
 const badge:Partial<Record<Pane,string>> = {units:offCount?`ปิด ${offCount}`:'',groups:custom?String(custom):'',history:history.length?String(history.length):'',test:settings.demoOffset?'เปิดอยู่':'',data:isLive(settings)?'จริง':''};
 return <div className="page settingsPage v2">
  <div className="pageHead"><h2>ตั้งค่า</h2><span className="pageTime">{timeNote}</span>
   {user ? <span className="setBy">บันทึกในชื่อ <b>{user.name}</b> · {roleText[user.role]}</span> : <label className="setBy">บันทึกในชื่อ <input value={by} maxLength={40} placeholder="ชื่อ / รหัส" onChange={e=>{ setBy(e.target.value); try { localStorage.setItem('hdt.operator',e.target.value); } catch { /* ignore */ } }}/></label>}</div>
  <div className="setLayout">
   <nav className="setNav" aria-label="หมวดการตั้งค่า">{panes.filter(p=>allowed.includes(p.id)).map(p=>{ const I = p.icon;
    return <button key={p.id} className={(pane===p.id?'on':'')} onClick={()=>setPane(p.id)} aria-current={pane===p.id}>
     <span className={'setIco i-'+p.id}><I size={18}/></span><span className="setNavText"><b>{p.title}</b><small>{p.sub}</small></span>{badge[p.id] && <em className={p.id==='test'?'warn':''}>{badge[p.id]}</em>}</button>; })}</nav>
   <div className="setPane">
    {msg && <p className={'setToast'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}
    {pane==='hours' && <HoursPane settings={settings} commit={commit}/>}
    {pane==='units' && <UnitsPane settings={settings} commit={commit}/>}
    {pane==='assist' && <AssistPane settings={settings} commit={commit}/>}
    {pane==='groups' && <GroupsPane settings={settings} commit={commit} focus={focusGroup ?? null}/>}
    {pane==='history' && <HistoryPane history={history}/>}
    {pane==='test' && <TestPane settings={settings} commit={commit}/>}
    {pane==='data' && <DataPane settings={settings} commit={commit} linking={sync ? {on:!!sync.features.phase2.accountLinking,set:async on=>{
     const r = await sync.api('features:set',{patch:{accountLinking:on}}); setMsg(r.ok ? {text:on?'เปิดการเชื่อมบัญชี LINE แล้ว':'ปิดการเชื่อมบัญชี LINE แล้ว'} : {text:r.reason ?? 'บันทึกไม่สำเร็จ',bad:true}); }} : undefined}/>}
    {pane==='wayfinding' && sync && <WayfindingAdminPane api={sync.api} features={sync.features}
     setFeature={async on=>{ const r = await sync.api('features:set',{patch:{wayfinding:on}}); setMsg(r.ok ? {text:on?'เปิด QR นำทางแล้ว':'ปิด QR นำทางแล้ว'} : {text:r.reason ?? 'บันทึกไม่สำเร็จ',bad:true}); }}/>}
    {pane==='notify' && sync && <NotificationsPane api={sync.api} features={sync.features}
     setFeature={async on=>{ const r = await sync.api('features:set',{patch:{notifications:on}}); setMsg(r.ok ? {text:on?'เปิดการแจ้งเตือนแล้ว':'ปิดการแจ้งเตือนแล้ว'} : {text:r.reason ?? 'บันทึกไม่สำเร็จ',bad:true}); }}/>}
    {pane==='appts' && sync && <ApptAdminPane api={sync.api} rev={sync.apptRev} features={sync.features}
     setFeature={async on=>{ const r = await sync.api('features:set',{patch:{appointments:on}}); setMsg(r.ok ? {text:on?'เปิดระบบนัดแพทย์แล้ว':'ปิดระบบนัดแพทย์แล้ว'} : {text:r.reason ?? 'บันทึกไม่สำเร็จ',bad:true}); }}/>}
    {pane==='booking' && sync && <BookingAdminPane api={sync.api} rev={sync.bookingRev} features={sync.features}
     setFeature={async on=>{ const r = await sync.api('features:set',{patch:{generalBooking:on}}); setMsg(r.ok ? {text:on?'เปิดระบบจองแล้ว':'ปิดระบบจองแล้ว'} : {text:r.reason ?? 'บันทึกไม่สำเร็จ',bad:true}); }}/>}
    {pane==='users' && user && listUsers && saveUser && <UsersPane me={user} listUsers={listUsers} saveUser={saveUser}/>}
   </div>
  </div>
 </div>;
}

function PaneHead({title,scope,icon,children}:{title:string;scope:string;icon:Pane;children?:ReactNode}) {
 const I = panes.find(p=>p.id===icon)!.icon;
 return <header className="paneHead"><span className={'setIco big i-'+icon}><I size={22}/></span><div><h3>{title}</h3>{children && <p>{children}</p>}</div><span className="scopeChip">มีผลกับ · {scope}</span></header>;
}
const showVal = (v:number, step:number, unit:string, zero?:string) => v===0 && zero ? zero : `${step<1 ? v.toFixed(1) : v} ${unit}`;
function Stepper({value,onChange,step,min,max,unit,zero}:{value:number;onChange:(v:number)=>void;step:number;min:number;max:number;unit:string;zero?:string}) {
 const set = (v:number) => onChange(Math.min(max,Math.max(min,Math.round(v/step)*step)));
 return <span className="stepper">
  <button type="button" aria-label="ลด" disabled={value<=min} onClick={()=>set(value-step)}><Minus size={15}/></button>
  <b>{showVal(value,step,unit,zero)}</b>
  <button type="button" aria-label="เพิ่ม" disabled={value>=max} onClick={()=>set(value+step)}><Plus size={15}/></button></span>;
}
// A value that may come from a higher level: plain text + "เปลี่ยน" until this level sets its own.
function Inheritable({own,value,inheritedLabel,onSet,onClear,...st}:{own:boolean;value:number;inheritedLabel:string;onSet:(v:number)=>void;onClear:()=>void;step:number;min:number;max:number;unit:string;zero?:string}) {
 return own ? <span className="valCell"><Stepper value={value} onChange={onSet} {...st}/><button className="linkBtn dark" onClick={onClear}>{inheritedLabel.replace('ตาม','ใช้ค่า')}</button></span>
  : <span className="valCell inherit"><b>{showVal(value,st.step,st.unit,st.zero)}</b><em>{inheritedLabel}</em><button className="btn ghost sm" onClick={()=>onSet(value)}>เปลี่ยน</button></span>;
}
// Changes wait here until saved together.
function SaveBar({count,onCancel,onSave,note}:{count:number;onCancel:()=>void;onSave:()=>void;note?:string}) {
 if (!count) return null;
 return <div className="saveBar"><span><b>มีการเปลี่ยนแปลง {count} รายการ</b>{note && <small>{note}</small>}</span><button className="btn ghost" onClick={onCancel}>ยกเลิก</button><button className="btn" onClick={onSave}>บันทึก</button></div>;
}

function HoursPane({settings,commit}:{settings:QueueSettings;commit:Commit}) {
 const cur = settings.hours ?? DEFAULT_HOURS;
 const [d,setD] = useState(cur);
 useEffect(()=>{ setD(cur); },[cur.opdOpen,cur.opdClose]); // eslint-disable-line react-hooks/exhaustive-deps
 const hh = (h:number) => `${String(h).padStart(2,'0')}:00`;
 const changes = (d.opdOpen!==cur.opdOpen?1:0)+(d.opdClose!==cur.opdClose?1:0);
 // Same split the roster uses: morning from an hour after opening, a lunch hour, afternoon to the last arrival.
 const a = d.opdOpen+1, am = Math.max(1,Math.round((Math.max(2,d.opdClose-a)-1)*4/7));
 const kind = (h:number) => h>=d.opdOpen-2 && h<d.opdOpen ? 'early' : h===a+am ? 'lunch' : h>=a && h<d.opdClose ? 'doc' : h>=d.opdOpen && h<d.opdClose ? 'open' : h>=d.opdClose && h<Math.min(24,d.opdClose+4) ? 'eve' : '';
 return <section className="setCard">
  <PaneHead icon="hours" title="เวลาให้บริการผู้ป่วยนอก (OPD)" scope="ทุกหน้าจอ">ใช้สร้างตารางเวรแพทย์และการมาถึงของผู้ป่วยในตัวจำลอง · ห้องฉุกเฉินเปิด 24 ชั่วโมงเสมอ</PaneHead>
  <div className="hoursPick">
   <label><span>เปิดช่องบริการ</span><select value={d.opdOpen} onChange={e=>{ const v = Number(e.target.value); setD(x=>({opdOpen:v,opdClose:Math.max(x.opdClose,v+4)})); }}>{Array.from({length:8},(_,i)=>5+i).map(h=><option key={h} value={h}>{hh(h)}</option>)}</select></label>
   <span className="hoursArrow">→</span>
   <label><span>รับผู้ป่วยใหม่ถึง</span><select value={d.opdClose} onChange={e=>setD(x=>({...x,opdClose:Number(e.target.value)}))}>{Array.from({length:22-(d.opdOpen+4)+1},(_,i)=>d.opdOpen+4+i).map(h=><option key={h} value={h}>{hh(h)}</option>)}</select></label>
  </div>
  <div className="dayBar">{Array.from({length:24},(_,h)=><i key={h} className={kind(h)} title={hh(h)}>{h%3===0 && <small>{String(h).padStart(2,'0')}</small>}</i>)}</div>
  <div className="dayKey"><span><i className="early"/>คนเริ่มมารอ</span><span><i className="open"/>ช่องบริการเปิด</span><span><i className="doc"/>แพทย์ออกตรวจ</span><span><i className="lunch"/>พักกลางวัน</span><span><i className="eve"/>คลินิกนอกเวลา (บางห้อง)</span></div>
  {settings.hours && <button className="linkBtn dark" onClick={()=>void commit({hours:null},'system','เวลาให้บริการ OPD: กลับเป็นค่าเริ่มต้น 07:00–16:00','ตัวจำลองกลับไปใช้ 07:00–16:00 · คิวที่ทดสอบไว้วันนี้ถูกล้าง')}><RotateCcw size={13}/> กลับเป็นค่าเริ่มต้น 07:00–16:00</button>}
  <SaveBar count={changes} onCancel={()=>setD(cur)} note="ตัวจำลองจะสร้างผู้ป่วยของวันใหม่ · คิวที่เรียก/ย้ายไว้วันนี้จะถูกล้าง"
   onSave={()=>void commit({hours:d},'system',`เวลาให้บริการ OPD: ${hh(cur.opdOpen)}–${hh(cur.opdClose)} → ${hh(d.opdOpen)}–${hh(d.opdClose)}`,`ตัวจำลองใช้เวลา ${hh(d.opdOpen)}–${hh(d.opdClose)}`)}/>
 </section>;
}

function RuleRows({value,onChange,inherited,onClear}:{value:Partial<QueueRules>;onChange:(k:RuleKey,v:number)=>void;inherited?:QueueRules;onClear?:(k:RuleKey)=>void}) {
 return <div className="ruleRows">{rules.map(r=>{ const own = value[r.key]!==undefined, v = (own ? value[r.key] : inherited?.[r.key]) as number;
  return <div key={r.key} className="ruleRow">
   <div className="ruleText"><b>{r.title}</b><small>{r.desc}</small></div>
   {inherited && onClear ? <Inheritable own={own} value={v} inheritedLabel="ตามทั้งโรงพยาบาล" onSet={x=>onChange(r.key,x)} onClear={()=>onClear(r.key)} step={r.step} min={r.min} max={r.max} unit={r.unit} zero={r.zero}/>
    : <Stepper value={v} step={r.step} min={r.min} max={r.max} unit={r.unit} zero={r.zero} onChange={x=>onChange(r.key,x)}/>}
  </div>; })}</div>;
}
function ModePick({value,onChange,inherited}:{value?:AssistMode;onChange:(m:AssistMode|undefined)=>void;inherited?:AssistMode}) {
 return <div className={'modePick'+(inherited?' four':'')}>
  {inherited && <button className={!value?'on':''} onClick={()=>onChange(undefined)}><b>ตามทั้งโรงพยาบาล</b><small>ตอนนี้: {modeText[inherited]}</small></button>}
  {modes.map(m=><button key={m.id} className={value===m.id?'on':''} onClick={()=>onChange(m.id)}><b>{modeText[m.id]}</b><small>{m.hint}</small></button>)}
 </div>;
}

function AssistPane({settings,commit}:{settings:QueueSettings;commit:Commit}) {
 const [d,setD] = useState<QueueRules>(settings.system);
 useEffect(()=>{ setD(settings.system); },[settings.system]);
 const diff = (Object.keys(d) as (keyof QueueRules)[]).filter(k=>d[k]!==settings.system[k]);
 const all = queueGroups(), using = all.filter(g=>!settings.groups[g.id]).length;
 return <section className="setCard">
  <PaneHead icon="assist" title="ตัวช่วยกระจายคิว · ค่าของทั้งโรงพยาบาล" scope={`${using} จาก ${all.length} แผนก/กลุ่ม`}>แผนกที่ตั้งเองไว้ในหมวด "ปรับรายแผนก" ไม่ได้รับผลจากหน้านี้</PaneHead>
  <h4 className="setSub">ระดับการช่วย</h4>
  <ModePick value={d.mode} onChange={m=>m && setD(x=>({...x,mode:m}))}/>
  <h4 className="setSub">เกณฑ์</h4>
  <RuleRows value={d} onChange={(k,v)=>setD(x=>({...x,[k]:v}))}/>
  {JSON.stringify(d)!==JSON.stringify(DEFAULT_RULES) && <button className="linkBtn dark" onClick={()=>setD(DEFAULT_RULES)}><RotateCcw size={13}/> ใช้ค่าเริ่มต้นของระบบ</button>}
  <SaveBar count={diff.length} onCancel={()=>setD(settings.system)} note={`มีผลกับ ${using} กลุ่มที่ใช้ค่าทั้งโรงพยาบาล`}
   onSave={()=>void commit({system:Object.fromEntries(diff.map(k=>[k,d[k]]))},'system',diff.map(k=>`${ruleName[k]}: ${valText(k,settings.system[k])} → ${valText(k,d[k])}`).join(' · '),`มีผลกับ ${using} กลุ่มที่ใช้ค่าทั้งโรงพยาบาล`)}/>
 </section>;
}

function GroupsPane({settings,commit,focus}:{settings:QueueSettings;commit:Commit;focus:string|null}) {
 const groups = queueGroups(); // cached per layout revision
 const [sel,setSel] = useState<string>(focus ?? groups[0].id);
 const [q,setQ] = useState('');
 const [only,setOnly] = useState(false);
 useEffect(()=>{ if (focus) setSel(focus); },[focus]);
 const g = groups.find(x=>x.id===sel)!;
 const own = settings.groups[g.id] ?? {}, eff = rulesFor(settings,g.id);
 const capsOf = (gg:QueueGroup) => Object.fromEntries(gg.stations.map(st=>[st.id,settings.stations[st.id]?.cap])) as Record<string,number|undefined>;
 const [d,setD] = useState<Partial<QueueRules>>(own);
 const [caps,setCaps] = useState<Record<string,number|undefined>>(capsOf(g));
 useEffect(()=>{ setD(settings.groups[sel] ?? {}); setCaps(capsOf(g)); },[sel,settings]); // eslint-disable-line react-hooks/exhaustive-deps
 const isCustom = (gg:QueueGroup) => !!settings.groups[gg.id] || gg.stations.some(st=>settings.stations[st.id]);
 const shown = groups.filter(gg=>(!only || isCustom(gg)) && (!q.trim() || gg.name.includes(q.trim()) || gg.stations.some(st=>st.label.includes(q.trim()))));
 const sections = [...new Set(shown.map(gg=>gg.section))];
 const keys = [...new Set([...Object.keys(own),...Object.keys(d)])] as (keyof QueueRules)[];
 const ruleDiff = keys.filter(k=>own[k]!==d[k]);
 const capDiff = g.stations.filter(st=>settings.stations[st.id]?.cap!==caps[st.id]);
 const summary = (gg:QueueGroup) => { const o = settings.groups[gg.id]; const parts = o ? (Object.keys(o) as (keyof QueueRules)[]).map(k=>`${ruleName[k]} ${valText(k,o[k])}`) : [];
  const sc = gg.stations.filter(st=>settings.stations[st.id]).length; if (sc) parts.push(`เพดานรายห้อง ${sc}`); return parts.join(' · '); };
 const saveAll = () => {
  const patch:SettingsPatch = {};
  if (ruleDiff.length) patch.groups = {[g.id]:Object.fromEntries(ruleDiff.map(k=>[k,d[k] ?? null]))};
  if (capDiff.length) patch.stations = Object.fromEntries(capDiff.map(st=>[st.id,{cap:caps[st.id] ?? null}]));
  const text = [...ruleDiff.map(k=>`${ruleName[k]}: ${d[k]===undefined?'ตามทั้งโรงพยาบาล':valText(k,d[k])}`),...capDiff.map(st=>`เพดาน ${st.label}: ${caps[st.id]===undefined?'ตามแผนก':valText('cap',caps[st.id])}`)].join(' · ');
  void commit(patch,g.id,text,`มีผลกับ ${g.name} เท่านั้น`);
 };
 return <section className="setCard groupsPane">
  <PaneHead icon="groups" title="ปรับรายแผนก / กลุ่มบริการ" scope={g.name}>ใช้เมื่อแผนกใดต้องต่างจากค่าทั้งโรงพยาบาล เช่น ให้ซักประวัติศัลยกรรมย้ายคิวเองได้</PaneHead>
  <div className="grpLayout">
   <aside className="grpList">
    <label className="grpSearch"><Search size={14}/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="ค้นหาแผนก ห้อง หรือช่อง"/></label>
    <label className="switch small"><input type="checkbox" checked={only} onChange={e=>setOnly(e.target.checked)}/><span/><small>เฉพาะที่ตั้งเอง ({groups.filter(isCustom).length})</small></label>
    <div className="grpScroll">{sections.map(sec=><div key={sec}><h5>{sec}</h5>
     {shown.filter(gg=>gg.section===sec).map(gg=><button key={gg.id} className={(gg.id===sel?'on ':'')+(isCustom(gg)?'custom':'')} onClick={()=>setSel(gg.id)}>
      <b>{gg.name}</b><small>{isCustom(gg) ? summary(gg) : 'ตามทั้งโรงพยาบาล'}</small></button>)}</div>)}
     {!shown.length && <p className="muted">ไม่พบ</p>}</div>
   </aside>
   <div className="grpEdit">
    <div className="grpEditHead"><div><b>{g.name}</b><small>{g.stations.length} {g.id.startsWith('exam:')?'ห้องตรวจ':'ช่อง'} · {g.section}</small></div>
     {isCustom(g) && <button className="linkBtn dark" onClick={()=>{ setD({}); setCaps(Object.fromEntries(g.stations.map(st=>[st.id,undefined]))); }}><RotateCcw size={13}/> ล้างค่าเฉพาะแผนกนี้</button>}</div>
    <h4 className="setSub">ระดับการช่วย</h4>
    <ModePick value={d.mode} inherited={settings.system.mode} onChange={m=>setD(x=>{ const n = {...x}; if (m) n.mode = m; else delete n.mode; return n; })}/>
    <h4 className="setSub">เกณฑ์</h4>
    <RuleRows value={d} inherited={settings.system} onChange={(k,v)=>setD(x=>({...x,[k]:v}))} onClear={k=>setD(x=>{ const n = {...x}; delete n[k]; return n; })}/>
    <h4 className="setSub">เพดานคิวรายห้อง/ช่อง <small>เมื่อห้องใดรับได้ต่างจากแผนก เช่น แพทย์ที่ตรวจช้ากว่าปกติ</small></h4>
    <div className="ruleRows">{g.stations.map(st=>{ const v = caps[st.id], groupCap = d.cap ?? settings.system.cap;
     return <div key={st.id} className="ruleRow"><div className="ruleText"><b>{st.label.replace(/^ซักประวัติ .+ (\d+)$/,'ช่อง $1')}</b><small>เพดานคิวของ{st.roomId?'ห้อง':'ช่อง'}นี้</small></div>
      <Inheritable own={v!==undefined} value={v ?? groupCap} inheritedLabel="ตามแผนก" onSet={x=>setCaps(c=>({...c,[st.id]:x}))} onClear={()=>setCaps(c=>({...c,[st.id]:undefined}))} step={1} min={0} max={200} unit="คน" zero="ไม่จำกัด"/></div>; })}</div>
   </div>
  </div>
  <SaveBar count={ruleDiff.length+capDiff.length} onCancel={()=>{ setD(own); setCaps(capsOf(g)); }} onSave={saveAll} note={`มีผลกับ ${g.name} เท่านั้น`}/>
 </section>;
}

function HistoryPane({history}:{history:QueueEvent[]}) {
 const list = history.slice().reverse();
 return <section className="setCard">
  <PaneHead icon="history" title="ประวัติการเปลี่ยนการตั้งค่า" scope="บันทึกของวันนี้">ใช้ตรวจย้อนหลังว่าใครเปลี่ยนอะไร · ระบบจริงต้องผูกกับผู้ใช้ที่ล็อกอิน</PaneHead>
  {list.length ? <ol className="histList">{list.slice(0,100).map(e=><li key={e.id}><time>{fmtMin(e.at)}</time><div><b>{e.reason}</b><small>{scopeName(e.station)} · {e.by ?? 'ไม่ระบุชื่อ'}</small></div></li>)}</ol>
   : <p className="cmdEmpty">ยังไม่มีการเปลี่ยนแปลงวันนี้</p>}
 </section>;
}

function TestPane({settings,commit}:{settings:QueueSettings;commit:Commit}) {
 const [now,setNow] = useState(()=>new Date());
 useEffect(()=>{ const t = setInterval(()=>setNow(new Date()),5000); return ()=>clearInterval(t); },[]);
 const realMin = now.getHours()*60+now.getMinutes(), off = settings.demoOffset ?? 0, shown = ((realMin+off)%1440+1440)%1440;
 const [custom,setCustom] = useState('');
 const setClock = (target:number|null) => target===null
  ? void commit({demoOffset:null},'system','เวลาทดสอบ: กลับไปใช้เวลาจริง','ทุกหน้าจอกลับไปใช้เวลาจริง')
  : void commit({demoOffset:Math.round(target-realMin)},'system',`เวลาทดสอบ: เริ่มที่ ${fmtMin(target)}`,`ทุกหน้าจอแสดงเวลา ${fmtMin(target)} แล้วเดินต่อ`);
 // Suggested times follow the OPD hours, so "busy" really is busy whatever the hours are set to.
 const {opdOpen:o, opdClose:c} = settings.hours ?? DEFAULT_HOURS, span = c-o;
 const picks:[number,string][] = ([[o+1,'เปิดคลินิก'],[o+span*0.3,'ช่วงพีค'],[o+span*0.4,'ช่วงพีค'],[o+span*0.65,'บ่าย'],[c-1,'ใกล้ปิดรับ']] as [number,string][]).map(([h,l])=>[Math.round(h*2)/2,l]);
 // Outside OPD hours there are no outpatients to queue: say so, with a way back to a busy time.
 const opdState = (t:number) => t<(o-2)*60 ? 'closed' : t<o*60 ? 'early' : t<c*60 ? 'open' : t<(c+3)*60 ? 'winding' : 'closed';
 const state = opdState(shown);
 const customMin = custom ? Number(custom.split(':')[0])*60+Number(custom.split(':')[1]) : undefined;
 return <section className="setCard testPane">
  <PaneHead icon="test" title="โหมดทดสอบ · เวลาจำลอง" scope="ทุกหน้าจอที่เชื่อมระบบกลาง">สำหรับทดสอบหรือสาธิตนอกเวลาทำการ · ทุกหน้าจอเริ่มที่เวลาที่เลือกแล้วเดินต่อตามจริง</PaneHead>
  <div className={'testClock'+(off?' on':'')}><div><span>{fmtMin(shown)}</span><small>{off ? `กำลังทดสอบ · เวลาจริง ${fmtMin(realMin)}` : 'ตามเวลาจริง'}</small></div>
   {off!==0 && <button className="btn" onClick={()=>setClock(null)}>กลับไปใช้เวลาจริง</button>}</div>
  {state!=='open' && <div className={'testWarn '+state}><b>{state==='early' ? 'OPD ยังไม่เปิด' : state==='winding' ? 'OPD ปิดรับผู้ป่วยใหม่แล้ว' : 'นอกเวลาให้บริการ OPD'} ({fmtMin(o*60)}–{fmtMin(c*60)})</b>
   <span>{state==='early' ? 'มีเพียงผู้ป่วยที่มารอก่อนเปิด' : state==='winding' ? 'เห็นเฉพาะผู้ที่รอรับบริการให้ครบ' : 'จะเห็นเฉพาะห้องฉุกเฉิน ไม่มีคิวผู้ป่วยนอก'} · ถ้าต้องการทดสอบคิว เลือกเวลาในช่วงให้บริการ</span>
   <button className="btn" onClick={()=>setClock(picks[2][0]*60)}>ไปช่วงพีค {fmtMin(picks[2][0]*60)}</button></div>}
  <h4 className="setSub">เริ่มที่ <small>ตามเวลาให้บริการ {fmtMin(o*60)}–{fmtMin(c*60)}</small></h4>
  <div className="testPicks">{picks.map(([h,l])=><button key={h} onClick={()=>setClock(h*60)}><b>{fmtMin(h*60)}</b><small>{l}</small></button>)}
   <span className={'testCustom'+(customMin!==undefined && opdState(customMin)!=='open'?' warn':'')}><input type="time" value={custom} onChange={e=>setCustom(e.target.value)} aria-label="เวลาที่ต้องการ"/><button className="btn" disabled={!custom} onClick={()=>{ const [h,mm] = custom.split(':').map(Number); setClock(h*60+mm); }}>ใช้เวลานี้</button></span></div>
  {customMin!==undefined && opdState(customMin)!=='open' && <p className="testHint">{fmtMin(customMin)} อยู่นอกเวลาให้บริการ OPD · ตั้งได้ แต่จะไม่มีคิวผู้ป่วยนอก</p>}
  <p className="cmdNote">ลิงก์ที่มี ?hour หรือ ?demoStart ใช้เวลาของลิงก์แทน · ขณะทดสอบ นาฬิกาด้านบนของแดชบอร์ดจะมีป้าย "ทดสอบ"</p>
 </section>;
}

// ---- Patient data: the simulated day, or real patients ----------------------------------------------------------
// Live: the simulation stops; only patients taken into the queue (registration / check-in, or sent by the HIS) appear
// on every console, map, TV board and patient page. Switching back shows the simulated day again; real visits are kept.
function DataPane({settings,commit,linking}:{settings:QueueSettings;commit:Commit;linking?:{on:boolean; set:(on:boolean)=>Promise<void>}}) {
 const live = isLive(settings);
 const [confirm,setConfirm] = useState(false);
 const set = (mode:'demo'|'live') => { setConfirm(false);
  void (mode==='live' ? commit({dataMode:'live'},'system','ข้อมูลผู้ป่วย: ผู้ป่วยจริง','ทุกหน้าจอแสดงเฉพาะผู้ป่วยที่รับเข้าคิว')
   : commit({dataMode:null},'system','ข้อมูลผู้ป่วย: สาธิต','ทุกหน้าจอกลับไปแสดงวันจำลอง')); };
 return <section className="setCard">
  <PaneHead icon="data" title="ข้อมูลผู้ป่วย" scope="ทุกหน้าจอที่เชื่อมระบบกลาง">เลือกว่าคอนโซล แผนที่ จอทีวี และหน้าคิวของผู้ป่วย แสดงวันจำลองหรือผู้ป่วยจริง</PaneHead>
  <div className="modePick two">
   <button className={!live?'on':''} onClick={()=>live && set('demo')} aria-pressed={!live}><b>สาธิต</b><small>ผู้ป่วยจำลองทั้งวัน · สำหรับนำเสนอและฝึกใช้งาน</small></button>
   <button className={live?'on':''} onClick={()=>!live && setConfirm(true)} aria-pressed={live}><b>ผู้ป่วยจริง</b><small>เฉพาะผู้ป่วยที่เจ้าหน้าที่หรือ HIS รับเข้าคิว · เลขคิวออกจากระบบกลาง</small></button>
  </div>
  {confirm && <div className="testWarn"><b>เปลี่ยนเป็นผู้ป่วยจริง?</b>
   <span>ผู้ป่วยจำลองจะหายจากทุกหน้าจอทันที · ช่องบริการที่ยังไม่มีใครเปิดจะไม่เรียกคิวเอง · ควรเปลี่ยนก่อนเริ่มให้บริการ</span>
   <button className="btn ghost" onClick={()=>setConfirm(false)}>ยกเลิก</button><button className="btn" onClick={()=>set('live')}>เปลี่ยนเป็นผู้ป่วยจริง</button></div>}
  {linking && <div className={'bookSwitch'+(linking.on?' on':'')}><div><b>เชื่อมบัญชี LINE ของผู้ป่วย {linking.on?'เปิดอยู่':'ปิดอยู่'}</b>
   <small>ผู้ป่วยขอรหัสในหน้า LINE แล้วยืนยันตัวตนที่เคาน์เตอร์ด้วยบัตรประชาชน (หน้าคิว → เชื่อม LINE) · ต้องตั้งค่า LINE Login ของโรงพยาบาลก่อนใช้จริง</small></div>
   <button className={linking.on?'btn ghost':'btn'} onClick={()=>void linking.set(!linking.on)}>{linking.on?'ปิด':'เปิด'}</button></div>}
  <p className="cmdNote">{live ? 'รับผู้ป่วยเข้าคิวได้ที่หน้าคิว → "รับผู้ป่วยเข้าคิว" · เปลี่ยนกลับเป็นสาธิตได้ รายการผู้ป่วยจริงของวันนี้ยังเก็บไว้'
   : 'ระบบกลางต้องเชื่อมต่ออยู่ · การเปลี่ยนบันทึกในประวัติการเปลี่ยน'}</p>
 </section>;
}

// ---- Departments & service points ----------------------------------------------------------------------------
// Every department, exam room and counter can be switched off (not in use today), and departments can be added on
// the OPD clinic floors. Switches are drafts until saved, like the other panes.
type Unit = {id:string; label:string};
type UnitGroup = {key:string; title:string; units:Unit[]; min:string}; // min: why the last one cannot be switched off
const deptId = (name:string) => `dept:${name}`;
const ROOMS_PER_FLOOR = roomsPerFloor(buildings.find(b=>b.id==='opd')!);
// Same sharing as floorRooms: room k belongs to the department whose band its centre falls in.
const roomShare = (n:number, m:number) => Array.from({length:m},(_,i)=>Array.from({length:n},(_,k)=>k).filter(k=>Math.min(m-1,Math.floor((k+0.5)/n*m))===i).length);
const clinicUnits = (c:Clinic):UnitGroup[] => [
 {key:`rooms:${c.key}`,title:'ห้องตรวจ',units:c.rooms.map(r=>({id:`room:${r.id}`,label:`ห้อง ${r.number}`})),min:'ต้องเปิดอย่างน้อย 1 ห้อง · ถ้าไม่ใช้ทั้งแผนก ให้ปิดแผนก'},
 {key:`screen:${c.key}`,title:'ซักประวัติ',units:Array.from({length:screeningCounters(c)},(_,i)=>({id:screeningStationId(c.key,i),label:`ช่อง ${i+1}`})),min:'ต้องเปิดอย่างน้อย 1 ช่อง · ถ้าไม่ใช้ทั้งแผนก ให้ปิดแผนก'}];
const sharedUnits = ():(UnitGroup & {where:string})[] => counterServices.map(({kind,section})=>{ const list = everyStation().filter(st=>st.group===`counter:${kind}`);
 return {key:kind,title:section,where:`${list[0]?.buildingId==='opd'?'OPD':list[0]?.buildingId==='er'?'ER':'ศูนย์การแพทย์'} ชั้น ${list[0]?.level ?? 1}`,units:list.map(st=>({id:st.id,label:st.label})),min:'บริการนี้ต้องเปิดอย่างน้อย 1 จุด'}; });
type Filter = 'all'|'opd'|'shared'|'off';

function UnitsPane({settings,commit}:{settings:QueueSettings;commit:Commit}) {
 const saved = useMemo(()=>({off:settings.layout?.off ?? [],depts:settings.layout?.depts ?? []}),[settings.layout]);
 const [off,setOff] = useState(()=>new Set(saved.off));
 const [depts,setDepts] = useState<CustomDept[]>(saved.depts);
 const [filter,setFilter] = useState<Filter>('all');
 const [adding,setAdding] = useState(false);
 const [note,setNote] = useState<{id:string;text:string}|null>(null);
 useEffect(()=>{ setOff(new Set(saved.off)); setDepts(saved.depts); },[saved]);
 useEffect(()=>{ if (!note) return; const t = setTimeout(()=>setNote(null),3500); return ()=>clearTimeout(t); },[note]);
 const clinics = opdClinics(), shared = sharedUnits();
 const label = new Map<string,string>([...everyStation().map(st=>[st.id,st.label] as [string,string]),...clinics.map(c=>[deptId(c.dept),`แผนก${c.dept}`] as [string,string])]);
 const toggle = (id:string, group?:UnitGroup) => {
  if (off.has(id)) { setOff(prev=>{ const x = new Set(prev); x.delete(id); return x; }); return; }
  if (group && group.units.filter(u=>!off.has(u.id)).length<=1) { setNote({id:group.key,text:group.min}); return; }
  setOff(prev=>new Set(prev).add(id));
 };
 // Draft vs saved.
 const turnedOff = [...off].filter(id=>!saved.off.includes(id)), turnedOn = saved.off.filter(id=>!off.has(id));
 const added = depts.filter(d=>!saved.depts.some(x=>x.name===d.name)), removed = saved.depts.filter(d=>!depts.some(x=>x.name===d.name));
 const changes = turnedOff.length+turnedOn.length+added.length+removed.length;
 const deptsChanged = added.length+removed.length>0;
 const save = () => {
  // Switches that belonged to a removed department's counters would land on the next one: drop them.
  const keep = [...off].filter(id=>!removed.some(d=>id===deptId(d.name) || id.startsWith(`screen:opd-${d.level}-`) && Number(id.split('-')[2]?.split(':')[0])>=builtInDeptCount(d.level)));
  const name = (id:string) => label.get(id) ?? id;
  const text = [turnedOff.length && `ปิด ${turnedOff.map(name).join(', ')}`,turnedOn.length && `เปิด ${turnedOn.map(name).join(', ')}`,
   added.length && `เพิ่มแผนก ${added.map(d=>`${d.name} (ชั้น ${d.level})`).join(', ')}`,removed.length && `ลบแผนก ${removed.map(d=>d.name).join(', ')}`].filter(Boolean).join(' · ');
  void commit({layout:{off:keep,depts}},'system',text.length>290?text.slice(0,288)+'…':text,
   deptsChanged ? 'แบ่งห้องตรวจใหม่และเริ่มวันจำลองใหม่แล้ว' : 'จุดที่ปิดไม่รับคิวใหม่ · ผู้ที่รออยู่จะถูกเรียกจากห้อง/ช่องอื่นในกลุ่มเดียวกัน');
 };
 // Totals for the summary strip (saved clinics + draft switches).
 const deptsOn = clinics.filter(c=>!off.has(deptId(c.dept))).length;
 const roomUnits = clinics.flatMap(c=>off.has(deptId(c.dept)) ? [] : clinicUnits(c)[0].units), counterUnits = [...clinics.flatMap(c=>off.has(deptId(c.dept)) ? [] : clinicUnits(c)[1].units),...shared.flatMap(g=>g.units)];
 const onOf = (list:Unit[]) => list.filter(u=>!off.has(u.id)).length;
 const isOffAny = (c:Clinic) => off.has(deptId(c.dept)) || clinicUnits(c).some(g=>g.units.some(u=>off.has(u.id)));
 const floorsShown = filter==='shared' ? [] : CLINIC_FLOORS.slice().reverse();
 return <section className="setCard unitsPane">
  <PaneHead icon="units" title="แผนกและจุดบริการ" scope="ทุกหน้าจอ">ปิดจุดที่ไม่ได้ใช้ เช่น ห้องที่ไม่มีแพทย์ออกตรวจ หรือช่องที่ไม่มีเจ้าหน้าที่ · จุดที่ปิดไม่รับคิวใหม่ และไม่แสดงในหน้าเลือกจุด การย้ายคิว และตัวช่วยกระจายคิว</PaneHead>
  <div className="unitStats">
   <div><b>{deptsOn}<small>/{clinics.length}</small></b><span>แผนกเปิด</span></div>
   <div><b>{onOf(roomUnits)}<small>/{roomUnits.length}</small></b><span>ห้องตรวจเปิด</span></div>
   <div><b>{onOf(counterUnits)}<small>/{counterUnits.length}</small></b><span>ช่องบริการเปิด</span></div>
   <button className="btn" onClick={()=>setAdding(true)} disabled={adding}><Plus size={16}/> เพิ่มแผนก</button>
  </div>
  {adding && <AddDept depts={depts} clinics={clinics} onCancel={()=>setAdding(false)} onAdd={d=>{ setDepts(x=>[...x,d]); setAdding(false); setFilter(f=>f==='shared'||f==='off'?'all':f); }}/>}
  <div className="unitFilter" role="tablist">{([['all','ทั้งหมด'],['opd','แผนก OPD'],['shared','จุดบริการร่วม'],['off',`ที่ปิดอยู่ (${off.size})`]] as [Filter,string][]).map(([id,t])=>
   <button key={id} role="tab" aria-selected={filter===id} className={filter===id?'on':''} onClick={()=>setFilter(id)}>{t}</button>)}</div>
  {floorsShown.map(level=>{
   const list = clinics.filter(c=>c.level===level && (filter!=='off' || isOffAny(c))), drafts = filter==='off' ? [] : added.filter(d=>d.level===level);
   if (!list.length && !drafts.length) return null;
   const desc = buildingStats.opd?.floors.find(f=>f.level===level)?.desc;
   return <div key={level} className="unitFloor"><h4 className="setSub">OPD ชั้น {level} <small>{desc}</small></h4>
    {list.map(c=>{ const dOff = off.has(deptId(c.dept)), gone = removed.some(d=>d.name===c.dept);
     return <div key={c.key} className={'uDeptRow'+(dOff?' off':'')+(gone?' gone':'')}>
      <div className="uDeptHead">
       <span className="uDeptLetter">{c.letter}</span>
       <div className="uDeptName"><b>{c.dept}{c.custom && <em className="tagNew">เพิ่มเอง</em>}</b>
        <small>{gone ? 'จะถูกลบเมื่อบันทึก' : dOff ? 'งดให้บริการ · ไม่รับผู้ป่วยใหม่ ไม่แสดงในหน้าคิวและจอทีวี' : clinicUnits(c).map(g=>`${g.title} ${onOf(g.units)}/${g.units.length}`).join(' · ')}</small></div>
       {c.custom && !gone && <button className="iconBtn" title="ลบแผนก" aria-label={`ลบแผนก ${c.dept}`} onClick={()=>setDepts(x=>x.filter(d=>d.name!==c.dept))}><Trash2 size={16}/></button>}
       {gone ? <button className="linkBtn dark" onClick={()=>setDepts(x=>[...x,saved.depts.find(d=>d.name===c.dept)!])}>ไม่ลบ</button>
        : <label className="switch" title={dOff?'เปิดแผนก':'ปิดแผนก'}><input type="checkbox" checked={!dOff} onChange={()=>toggle(deptId(c.dept))}/><span/><small>{dOff?'ปิด':'เปิด'}</small></label>}
      </div>
      {!dOff && !gone && clinicUnits(c).map(g=><UnitChips key={g.key} group={g} off={off} onToggle={toggle} note={note?.id===g.key?note.text:undefined}/>)}
     </div>; })}
    {drafts.map(d=><div key={d.name} className="uDeptRow draft"><div className="uDeptHead"><span className="uDeptLetter"><Plus size={16}/></span>
     <div className="uDeptName"><b>{d.name}<em className="tagNew">ใหม่</em></b><small>ห้องตรวจและช่องซักประวัติจะแบ่งให้หลังบันทึก</small></div>
     <button className="iconBtn" aria-label={`ยกเลิกการเพิ่ม ${d.name}`} onClick={()=>setDepts(x=>x.filter(y=>y.name!==d.name))}><X size={16}/></button></div></div>)}
   </div>; })}
  {filter!=='opd' && (()=>{ const list = shared.filter(g=>filter!=='off' || g.units.some(u=>off.has(u.id)));
   return list.length>0 && <div className="unitFloor"><h4 className="setSub">จุดบริการร่วม <small>ทุกแผนกใช้ร่วมกัน · ปิดได้ทีละช่อง แต่ต้องเหลืออย่างน้อย 1 ช่อง</small></h4>
    {list.map(g=><div key={g.key} className="uDeptRow shared"><div className="uDeptHead"><div className="uDeptName"><b>{g.title}</b><small>{g.where} · เปิด {onOf(g.units)}/{g.units.length}</small></div></div>
     <UnitChips group={g} off={off} onToggle={toggle} note={note?.id===g.key?note.text:undefined} bare/></div>)}</div>; })()}
  {filter==='off' && !off.size && <p className="cmdEmpty">ทุกแผนกและทุกจุดบริการเปิดอยู่</p>}
  <SaveBar count={changes} onCancel={()=>{ setOff(new Set(saved.off)); setDepts(saved.depts); }} onSave={save}
   note={deptsChanged ? 'เพิ่ม/ลบแผนก: ห้องตรวจบนชั้นนั้นจะแบ่งใหม่ และตัวจำลองเริ่มวันใหม่ · คิวที่เรียก/ย้ายไว้วันนี้จะถูกล้าง'
    : 'ผู้ที่รออยู่ที่จุดที่ปิดจะถูกเรียกจากห้อง/ช่องอื่นในกลุ่มเดียวกัน ไม่ต้องย้ายที่นั่ง'}/>
 </section>;
}

function UnitChips({group,off,onToggle,note,bare}:{group:UnitGroup;off:Set<string>;onToggle:(id:string,g:UnitGroup)=>void;note?:string;bare?:boolean}) {
 return <div className={'unitLine'+(bare?' bare':'')}>{!bare && <span className="unitTitle">{group.title}</span>}
  <div className="unitChips">{group.units.map(u=>{ const isOn = !off.has(u.id);
   return <button key={u.id} className={'unitChip'+(isOn?' on':' off')} aria-pressed={isOn} title={isOn?'กดเพื่อปิด':'กดเพื่อเปิด'} onClick={()=>onToggle(u.id,group)}>
    <i/>{u.label}{!isOn && <em>ปิด</em>}</button>; })}</div>
  {note && <p className="unitNote" role="status">{note}</p>}</div>;
}

function AddDept({depts,clinics,onAdd,onCancel}:{depts:CustomDept[];clinics:Clinic[];onAdd:(d:CustomDept)=>void;onCancel:()=>void}) {
 const [name,setName] = useState('');
 const namesOn = (level:number) => [...(buildingStats.opd?.floors.find(f=>f.level===level)?.depts ?? []).slice(0,builtInDeptCount(level)),...depts.filter(d=>d.level===level).map(d=>d.name)];
 const fits = (level:number) => namesOn(level).length<ROOMS_PER_FLOOR && depts.filter(d=>d.level===level).length<3;
 const [level,setLevel] = useState(()=>CLINIC_FLOORS.find(fits) ?? 0);
 const n = name.trim(), taken = !!n && ([...clinics.map(c=>c.dept),...depts.map(d=>d.name)].includes(n));
 const after = level ? [...namesOn(level),n || 'แผนกใหม่'] : [], share = roomShare(ROOMS_PER_FLOOR,after.length), before = roomShare(ROOMS_PER_FLOOR,after.length-1);
 const ok = !!n && !taken && !!level && fits(level);
 return <div className="addDept">
  <div className="addDeptHead"><b>เพิ่มแผนกใหม่</b><button className="iconBtn" aria-label="ปิด" onClick={onCancel}><X size={16}/></button></div>
  <label className="addField"><span>ชื่อแผนก</span><input autoFocus value={name} maxLength={30} placeholder="เช่น ผิวหนัง, จิตเวช, ทันตกรรม" onChange={e=>setName(e.target.value)}
   onKeyDown={e=>{ if (e.key==='Enter' && ok) onAdd({name:n,level}); if (e.key==='Escape') onCancel(); }}/></label>
  {taken && <p className="unitNote">มีแผนกชื่อนี้แล้ว</p>}
  <div className="addField"><span>อยู่ชั้น</span><div className="floorPick">{CLINIC_FLOORS.map(l=>{ const can = fits(l);
   return <button key={l} className={level===l?'on':''} disabled={!can} onClick={()=>setLevel(l)}><b>ชั้น {l}</b><small>{can ? `${namesOn(l).length} แผนก` : 'เต็มแล้ว'}</small></button>; })}</div></div>
  {level>0 && <div className="sharePreview"><small>ห้องตรวจ {ROOMS_PER_FLOOR} ห้องบนชั้น {level} จะแบ่งใหม่เป็น</small>
   <div className="shareBar">{after.map((d,i)=><span key={i} className={i===after.length-1?'new':share[i]<before[i]?'less':''} style={{flex:share[i]}}><b>{d}</b><small>{i<before.length && before[i]!==share[i] ? `${before[i]} → ${share[i]} ห้อง` : `${share[i]} ห้อง`}</small></span>)}</div></div>}
  <div className="addActions"><button className="btn ghost" onClick={onCancel}>ยกเลิก</button><button className="btn" disabled={!ok} onClick={()=>onAdd({name:n,level})}>เพิ่ม</button></div>
 </div>;
}

// ---- Staff accounts (administrators only) -------------------------------------------------------------------
const roleHint:Record<Role,string> = {admin:'ทุกอย่าง รวมการตั้งค่าทั้งโรงพยาบาลและบัญชีผู้ใช้',supervisor:'งานคิว + ปรับการตั้งค่ารายแผนก/รายห้อง',staff:'งานคิวที่จุดบริการ (เรียก พัก ย้าย ปิดงาน)'};
const ROLE_LIST:Role[] = ['staff','supervisor','admin'];
function UsersPane({me,listUsers,saveUser}:{me:AuthUser;listUsers:QueueSync['listUsers'];saveUser:QueueSync['saveUser']}) {
 const [users,setUsers] = useState<AuthUser[]>([]);
 const [msg,setMsg] = useState<{text:string;bad?:boolean}|null>(null);
 const [edit,setEdit] = useState<(UserInput & {isNew?:boolean})|null>(null);
 useEffect(()=>{ void listUsers().then(r=>{ if (r.ok && r.users) setUsers(r.users); else setMsg({text:r.reason ?? 'โหลดรายชื่อไม่สำเร็จ',bad:true}); }); },[listUsers]);
 const submit = async () => {
  if (!edit) return;
  const body:UserInput = edit.isNew ? {username:edit.username,name:edit.name,role:edit.role,password:edit.password} : {id:edit.id,name:edit.name,role:edit.role,active:edit.active,...(edit.password?{password:edit.password}:{})};
  const r = await saveUser(body);
  if (r.ok && r.users) { setUsers(r.users); setEdit(null); setMsg({text:edit.isNew?`สร้างบัญชี ${edit.username} แล้ว`:edit.password?'บันทึกแล้ว · รหัสผ่านใหม่มีผล ผู้ใช้ต้องเข้าสู่ระบบใหม่':'บันทึกแล้ว'}); }
  else setMsg({text:r.reason ?? 'บันทึกไม่สำเร็จ',bad:true});
 };
 const toggleActive = async (u:AuthUser) => { const r = await saveUser({id:u.id,active:!u.active}); if (r.ok && r.users) setUsers(r.users); else setMsg({text:r.reason ?? 'บันทึกไม่สำเร็จ',bad:true}); };
 const fmt = (iso?:string) => iso ? new Date(iso).toLocaleString('th-TH',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : 'ยังไม่เคยเข้าใช้';
 return <section className="setCard usersPane">
  <PaneHead icon="users" title="ผู้ใช้งานและสิทธิ์" scope="บัญชีเจ้าหน้าที่ทั้งหมด">ทุกการเรียกคิว ย้ายคิว และเปลี่ยนการตั้งค่า บันทึกในชื่อบัญชีที่เข้าสู่ระบบ · จอทีวีและหน้าคิวของผู้ป่วยไม่ต้องใช้บัญชี</PaneHead>
  {msg && <p className={'setToast'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}
  <div className="roleKey">{ROLE_LIST.map(r=><div key={r}><span className={'userAva r-'+r}><UserCog size={14}/></span><b>{roleText[r]}</b><small>{roleHint[r]}</small></div>)}</div>
  <div className="usersHead"><h4 className="setSub">บัญชี {users.length} บัญชี</h4>
   <button className="btn" onClick={()=>setEdit({isNew:true,role:'staff',username:'',name:'',password:''})}><Plus size={15}/> เพิ่มผู้ใช้</button></div>
  {edit && <div className="userEdit">
   <div className="userEditGrid">
    {edit.isNew && <label className="addField"><span>ชื่อผู้ใช้ (ใช้เข้าสู่ระบบ)</span><input value={edit.username ?? ''} maxLength={40} placeholder="เช่น nurse.ploy" autoCapitalize="none" onChange={e=>setEdit({...edit,username:e.target.value})}/></label>}
    <label className="addField"><span>ชื่อที่แสดง (บันทึกในประวัติ)</span><input value={edit.name ?? ''} maxLength={60} placeholder="เช่น พย.พลอย ส." onChange={e=>setEdit({...edit,name:e.target.value})}/></label>
    <label className="addField"><span>{edit.isNew?'รหัสผ่าน':'ตั้งรหัสผ่านใหม่ (เว้นว่างถ้าไม่เปลี่ยน)'}</span><input type="password" value={edit.password ?? ''} autoComplete="new-password" placeholder="อย่างน้อย 8 ตัวอักษร" onChange={e=>setEdit({...edit,password:e.target.value})}/></label>
   </div>
   <div className="addField"><span>สิทธิ์</span><div className="floorPick">{ROLE_LIST.map(r=><button key={r} type="button" className={edit.role===r?'on':''} onClick={()=>setEdit({...edit,role:r})}><b>{roleText[r]}</b><small>{roleHint[r]}</small></button>)}</div></div>
   <div className="addActions"><button className="btn ghost" onClick={()=>setEdit(null)}>ยกเลิก</button><button className="btn" onClick={()=>void submit()}>{edit.isNew?'สร้างบัญชี':'บันทึก'}</button></div>
  </div>}
  <div className="usersList">{users.map(u=><div key={u.id} className={'userRow'+(u.active?'':' off')}>
   <span className={'userAva r-'+u.role}><UserCog size={15}/></span>
   <div className="userInfo"><b>{u.name}{u.id===me.id && <em className="tagNew">คุณ</em>}{!u.active && <em className="tagOff">ระงับ</em>}</b><small>@{u.username} · {roleText[u.role]} · เข้าใช้ล่าสุด {fmt(u.lastLogin)}</small></div>
   <button className="btn ghost sm" onClick={()=>setEdit({id:u.id,name:u.name,role:u.role,active:u.active,password:''})}><KeyRound size={14}/> แก้ไข</button>
   {u.id!==me.id && <label className="switch small" title={u.active?'ระงับบัญชี':'เปิดใช้บัญชี'}><input type="checkbox" checked={u.active} onChange={()=>void toggleActive(u)}/><span/><small>{u.active?'ใช้งาน':'ระงับ'}</small></label>}
  </div>)}</div>
 </section>;
}
