'use client';
import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { AlertTriangle, OctagonAlert, Phone, Search } from 'lucide-react';
import { CLEANING_MIN, fmtDur, fmtMin, maskHN, stepText, type Patient } from '../../lib/patients';
import { capacityBoard, unitStateText, type CapFloor, type Unit } from '../../lib/ops';
import type { FloorUnit } from '../HospitalScene';
import { Select } from '../Select';

// For staff coordinating across departments: which beds, exam rooms and stations are free right now,
// building by building — the question that is usually answered by phoning around.
const FloorScene = dynamic(()=>import('../HospitalScene').then(m=>m.FloorScene),{ssr:false,loading:()=><div className="loading">กำลังโหลดผัง…</div>});

type FindKind = 'ward'|'er'|'room'|'station';
const findKinds:[FindKind,string][] = [['ward','เตียงหอผู้ป่วย'],['er','เตียง ER'],['room','ห้องตรวจ'],['station','จุดตรวจ / เอกซเรย์']];
const kindNoun:Record<FindKind,string> = {ward:'เตียง',er:'เตียง ER',room:'ห้องตรวจ',station:'จุด'};
const isKind = (k:FindKind, f:CapFloor, u:Unit) => k==='ward' ? u.kind==='bed' && f.buildingId==='inpatient' : k==='er' ? u.kind==='bed' && f.buildingId==='er' : u.kind===k;
type Fill = 'full-waiting'|'full'|'near'|'ok';
const fillOf = (f:CapFloor):Fill => f.free===0 ? (f.waiting>0?'full-waiting':'full') : f.free===1 && f.total>=4 ? 'near' : 'ok';
function FillBadge({f}:{f:CapFloor}) {
 const k = fillOf(f);
 if (k==='ok') return null;
 const Icon = k==='near' ? AlertTriangle : OctagonAlert, full = f.unitName==='เตียง' ? 'เต็ม' : 'ไม่ว่าง';
 return <span className={'fillBadge '+k} title={k==='full-waiting'?`${full} · ${f.waitingText} ${f.waiting} คน`:undefined}><Icon size={13}/>{k==='full-waiting'?`${full} · รอ ${f.waiting}`:k==='full'?full:'ใกล้เต็ม'}</span>;
}
// Demo internal phone extensions per floor (a real deployment reads them from the hospital directory).
const extPrefix:Record<string,string> = {opd:'2',er:'1',inpatient:'3',diagnostics:'4'};
const extOf = (f:CapFloor) => `${extPrefix[f.buildingId] ?? '9'}${f.level}00`;
const shortBuilding = (name:string) => name.replace(/^อาคาร/,'').replace(/ \(.*\)$/,'');
const legendStates:Record<string,string[]> = {'เตียง':['busy','leaving','boarding','cleaning','free'],'ห้องตรวจ':['busy','free','break','closed']};

export default function CapacityPage({patients,minute,timeNote,onOpenPatient}:{patients:Patient[];minute:number;timeNote:string;onOpenPatient:(id:string)=>void}) {
 const m = Math.floor(minute);
 const floors = useMemo(()=>capacityBoard(patients,m),[patients,m]);
 const [key,setKey] = useState('inpatient-1');
 const [sel,setSel] = useState<string|null>(null);
 const [dept,setDept] = useState<string|null>(null);
 const [mode,setMode] = useState<'2d'|'3d'>('2d');
 // Ward beds (for admitting) and ER beds answer different questions for different people, so they're separate.
 const [findKind,setFindKind] = useState<FindKind>('ward');
 const [findDept,setFindDept] = useState('');
 const floor = floors.find(f=>f.key===key) ?? floors[0];
 const unit = floor.units.find(u=>u.id===sel);
 const open = (f:CapFloor, unitId?:string) => { setKey(f.key); setSel(unitId ?? null); setDept(findDept && f.depts.includes(findDept) ? findDept : null); };
 // Choosing a type / department in "หาที่ว่าง" also points the map at it: stay on this floor if it has a free match,
 // otherwise go to the floor with the most free matches, and highlight that department.
 const focusFind = (kind:FindKind, d:string) => {
  const match = (f:CapFloor, u:Unit) => isKind(kind,f,u) && (!d || u.dept===d);
  const ranked = floors.filter(f=>f.units.some(u=>match(f,u))).map(f=>({f,free:f.units.filter(u=>match(f,u) && u.state==='free').length})).sort((a,b)=>b.free-a.free);
  if (!ranked.length) return;
  const here = ranked.find(x=>x.f.key===floor.key);
  const target = here && (here.free>0 || ranked[0].free===0) ? here.f : ranked[0].f;
  setKey(target.key); setSel(null); setDept(d && target.depts.includes(d) ? d : null);
 };
 const all = floors.flatMap(f=>f.units.map(u=>({f,u})));
 const deptsOfKind = [...new Set(all.filter(x=>isKind(findKind,x.f,x.u)).map(x=>x.u.dept))];
 const found = all.filter(x=>isKind(findKind,x.f,x.u) && x.u.state==='free' && (!findDept || x.u.dept===findDept));
 const sum = (pred:(u:Unit)=>boolean, f?:(fl:CapFloor)=>boolean) => floors.filter(fl=>!f||f(fl)).reduce((n,fl)=>n+fl.units.filter(pred).length,0);
 const short = (u:Unit) => u.name.replace(/^(เตียง ER|เตียง|ห้องตรวจ|ห้องเอกซเรย์|จุดเจาะเลือด) /,'').replace(/^เตียงกู้ชีพ/,'กู้ชีพ');
 // Beds that are simply occupied show just their number (the mat colour says the rest); others add their state.
 const marks:FloorUnit[] = floor.units.map(u=>({id:u.id,label:u.note && !(u.kind==='bed' && u.state==='busy')?`${short(u)} · ${u.note}`:short(u),lift:u.kind==='bed' && /(-B|2)$/.test(u.name)?0.5:0,state:u.state,at:u.at,mat:u.mat,patientId:u.patient?.p.id,dim:!!dept && u.dept!==dept}));
 const groups = [...new Set(floors.map(f=>f.buildingId))];

 return <div className="page">
  <div className="pageHead"><h2>ผังโรงพยาบาล · เตียงและห้องว่าง</h2><span className="pageTime">{timeNote}</span></div>
  <div className="tileRow">
   <div className="tile"><small>เตียงหอผู้ป่วยว่าง</small><b>{sum(u=>u.state==='free',f=>f.buildingId==='inpatient')}<em> เตียง</em></b><span className="muted">ทำความสะอาดอยู่ {sum(u=>u.state==='cleaning')} · ใช้เวลา {CLEANING_MIN} นาที</span></div>
   <div className="tile"><small>เตียง ER ว่าง</small><b>{sum(u=>u.state==='free',f=>f.buildingId==='er')}<em> เตียง</em></b><span className={sum(u=>u.state==='boarding')?'warnText':'muted'}>ค้างรอเตียงหอผู้ป่วย {sum(u=>u.state==='boarding')} คน</span></div>
   <div className="tile"><small>ห้องตรวจ OPD พร้อมตรวจ</small><b>{sum(u=>u.state==='free',f=>f.buildingId==='opd')}<em> ห้อง</em></b><span className="muted">กำลังตรวจ {sum(u=>u.state==='busy',f=>f.buildingId==='opd')} · แพทย์พัก {sum(u=>u.state==='break')}</span></div>
   <div className="tile"><small>ชั้นที่เต็ม</small><b>{floors.filter(f=>fillOf(f).startsWith('full')).length}<em> ชั้น</em></b><span className="muted">{floors.filter(f=>fillOf(f).startsWith('full')).map(f=>`${shortBuilding(f.buildingName)} ${f.level}`).join(', ') || 'ไม่มี'}</span></div>
  </div>

  <section className="panel findPanel">
   <h3><Search size={15}/> หาที่ว่าง</h3>
   <span className="coordContact"><Phone size={13}/> จัดสรรเตียง: ศูนย์ประสานงานเตียง · เบอร์ภายใน 3000 <small className="muted">(จำลอง)</small></span>
   <div className="segmented small">{findKinds.map(([k,l])=><button key={k} className={findKind===k?'active':''} onClick={()=>{ setFindKind(k); setFindDept(''); focusFind(k,''); }}>{l}</button>)}</div>
   <Select size="sm" value={findDept} onChange={v=>{ setFindDept(v); focusFind(findKind,v); }} aria-label="แผนก" className="selFilter" options={[{value:'',label:'ทุกแผนก'},...deptsOfKind.map(d=>({value:d,label:d}))]}/>
   {/* One row per floor: how many are free there, then each free unit (click floor → open it, click unit → select it). */}
   <div className="foundBox">
    <p className="foundTotal">{found.length ? <>ว่างตอนนี้ <b>{found.length}</b> {kindNoun[findKind]}{findDept?` · ${findDept}`:''}</>
     : <>ไม่มี{kindNoun[findKind]}ว่าง{findDept?`ใน${findDept}`:''} ณ เวลานี้{findKind==='ward'?' · ติดต่อศูนย์ประสานงานเตียง 3000':findKind==='er'?' · ติดต่อหัวหน้าเวร ER 1100':''}</>}</p>
    {floors.map(f=>{ const list = found.filter(x=>x.f.key===f.key).map(x=>x.u); if (!list.length) return null;
     return <div key={f.key} className={'foundRow'+(f.key===floor.key?' on':'')}>
      <button className="foundFloor" onClick={()=>open(f)}>{shortBuilding(f.buildingName)} ชั้น {f.level}</button>
      <span className="foundCount"><b>{list.length}</b> ว่าง</span>
      <div className="foundUnits">{list.map(u=><button key={u.id} className={'foundChip'+(u.id===sel?' on':'')} title={`${u.name} · ${u.dept}`} onClick={()=>open(f,u.id)}>{short(u)}</button>)}</div>
     </div>; })}
   </div>
  </section>

  <section className="panel bedBoard">
   <div className="bedFloors" role="listbox" aria-label="เลือกอาคารและชั้น">{groups.map(g=>{ const list = floors.filter(f=>f.buildingId===g);
    return <div key={g} className="floorGroup"><h4>{list[0].buildingName}</h4>{list.map(f=>{
     const segs = (legendStates[f.unitName] ?? ['busy','free']).map(s=>({s,n:f.units.filter(u=>u.state===s).length})).filter(x=>x.n>0);
     return <button key={f.key} role="option" aria-selected={f.key===floor.key} className={`bedFloorRow fill-${fillOf(f)}`+(f.key===floor.key?' on':'')} onClick={()=>open(f)}>
      <b>ชั้น {f.level}</b><span>{f.inUse}/{f.total} {f.unitName}</span>
      {fillOf(f)!=='ok' && <span className="badgeRow"><FillBadge f={f}/></span>}
      <i className="occBar" aria-hidden>{segs.map(x=><i key={x.s} className={'seg '+x.s} style={{flex:x.n}}/>)}</i>
      <small><em className={f.free===0?'zero':''}>ว่าง {f.free}</em>{f.waiting?` · ${f.waitingText} ${f.waiting}`:''}</small>
     </button>; })}</div>; })}</div>
   <div className="bedStage">
    <FloorScene buildingId={floor.buildingId} level={floor.level} minute={m} patients={patients} units={marks} selected={sel} onSelect={id=>setSel(id||null)} mode={mode}/>
    <div className="bedStageBar">
     <strong>{shortBuilding(floor.buildingName)} ชั้น {floor.level}</strong><FillBadge f={floor}/>
     {floor.depts.length>1 && <div className="chipRow">{floor.depts.map(d=><button key={d} className={'chip'+(dept===d?' on':'')} onClick={()=>setDept(dept===d?null:d)}>{d}</button>)}</div>}
     <div className="bedLegend">{(legendStates[floor.unitName] ?? ['busy','free']).map(s=><span key={s}><i className={'bedSwatch '+s}/>{unitStateText[floor.units[0]?.kind ?? 'bed'][s as Unit['state']]}</span>)}</div>
     <div className="viewSwitch inline">{(['2d','3d'] as const).map(x=><button key={x} className={mode===x?'active':''} onClick={()=>setMode(x)}>{x.toUpperCase()}</button>)}</div>
    </div>
   </div>
   <div className="bedDetail">
    {unit ? <UnitDetail u={unit} f={floor} m={m} onOpen={onOpenPatient}/> : <>
     <h3>{shortBuilding(floor.buildingName)} ชั้น {floor.level}</h3>
     <p className="muted">คลิก{floor.unitName}หรือผู้ป่วยในผังเพื่อดูรายละเอียด</p>
     <dl><dt>{floor.unitName}ว่าง</dt><dd>{floor.units.filter(u=>u.state==='free').map(u=>u.name.replace(/^เตียง /,'')).join(', ') || '—'}</dd>
      {floor.unitName==='เตียง' && floor.buildingId==='inpatient' && <><dt>กลับบ้านวันนี้</dt><dd>{floor.units.filter(u=>u.state==='leaving').map(u=>`${u.name.replace(/^เตียง /,'')} (${fmtMin(u.until!)})`).join(', ') || '—'}</dd></>}
      <dt>{floor.waitingText}</dt><dd>{floor.waiting} คน</dd></dl>
    </>}
    <p className="contact"><Phone size={13}/> เบอร์ภายใน {extOf(floor)} <small className="muted">(จำลอง)</small></p>
    <p className="note">ข้อมูลจากระบบรับ-จำหน่ายผู้ป่วย (ADT), ระบบคิว และตารางเวร · ไม่ต้องกรอกเพิ่ม · ข้อมูลจำลอง</p>
   </div>
  </section>
 </div>;
}

function UnitDetail({u,f,m,onOpen}:{u:Unit;f:CapFloor;m:number;onOpen:(id:string)=>void}) {
 const s = u.patient;
 return <>
  <h3>{u.name}</h3><p className="muted">{u.dept} · {shortBuilding(f.buildingName)} ชั้น {f.level}</p>
  <p><span className={'bedState '+u.state}>{unitStateText[u.kind][u.state]}</span></p>
  <dl>
   {u.doctor && <><dt>แพทย์เวร</dt><dd>{u.doctor}</dd></>}
   {s && <><dt>ผู้ป่วย</dt><dd>{s.p.queue} · {maskHN(s.p.hn)}</dd>
    <dt>ขั้นตอน</dt><dd>{m<s.step.called?stepText[s.step.kind].wait:stepText[s.step.kind].serve}{u.state==='boarding'?` · รอ ${fmtDur(s.stepWait)}`:''}</dd></>}
   {s?.p.ward && <><dt>นอนโรงพยาบาล</dt><dd>วันที่ {s.p.ward.day}</dd></>}
   {u.until!==undefined && u.state==='leaving' && <><dt>กลับบ้าน</dt><dd>{fmtMin(u.until)} · ว่าง {fmtMin(u.until+CLEANING_MIN)}</dd></>}
   {u.state==='cleaning' && <><dt>พร้อมใช้</dt><dd>{fmtMin(u.until!)}</dd></>}
  </dl>
  {u.state==='free' && <p>{u.kind==='room'?'แพทย์พร้อมรับผู้ป่วย':'พร้อมรับผู้ป่วย'}</p>}
  {s && <button className="btn ghost" onClick={()=>onOpen(s.p.id)}>ดูบนแผนที่หลัก</button>}
 </>;
}
