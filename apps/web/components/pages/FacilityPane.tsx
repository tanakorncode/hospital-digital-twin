'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArchiveRestore, Building2, ChevronDown, ChevronRight, ChevronUp, History, Layers, MapPin, Pencil, Plus, Search, Trash2, Undo2, X } from 'lucide-react';
import { facility, type BuildingKind, type DepartmentType, type Facility, type FBuilding, type FDepartment, type FFloor, type FGroup, type FPoint, type PointKind } from '../../lib/facility';
import { useFacility } from '../../lib/use-facility';
import { stepText, type StepKind } from '../../lib/patients';
import type { QueueSync } from '../../lib/queue';
import { Select } from '../Select';
import { ConfirmDialog, type Confirm } from './ConfirmDialog';

// Settings → ผังโรงพยาบาล (docs/FACILITY-MODEL-DESIGN.md §7): the whole facility on one page — buildings, floors,
// departments, service groups and their rooms / counters / beds. Two views of the same data: by department (units,
// their groups and where each group is) and by place (buildings › floors › what is on each floor). Edits are a draft
// kept on the server (saved as you go); the server checks it as you go too, and "ดูผลกระทบ" shows what publishing would
// change and what still uses things before it is published as a new version for every screen. Earlier versions can be
// published again from the history.
type Data = Omit<Facility,'version'|'publishedAt'>;
type Sel = {kind:'dept'|'building'|'floor'; id:string; focus?:string} | null;
type Issue = {level:'error'|'warning'; at?:string; message:string};
type Change = {kind:string; id:string; name:string; change:'added'|'changed'|'removed'|'off'|'on'|'retired'};
type Impact = {ok:boolean; issues:Issue[]; changes:Change[]; summary:Record<string,{added:number; changed:number; removed:number}>};
type Version = {version:number; publishedAt:string; publishedBy:string; publishedByName?:string; source:'seed'|'layout'|'publish'|'rollback'; note?:string; summary:Impact['summary']};
type Usage = Record<string,{what:string; count:number}[]>;
type Filter = 'all'|'on'|'off'|'problem'|'retired';
type Api = QueueSync['api'];

const DEPT_TYPES:[DepartmentType,string][] = [['clinic','คลินิกผู้ป่วยนอก'],['service','จุดบริการร่วม'],['emergency','ฉุกเฉิน'],['ward','หอผู้ป่วย'],['diagnostic','ตรวจวินิจฉัย'],['support','หน่วยสนับสนุน']];
const BUILDING_KINDS:[BuildingKind,string][] = [['opd','ผู้ป่วยนอก'],['er','ฉุกเฉิน'],['inpatient','ผู้ป่วยใน'],['diagnostics','ศูนย์การแพทย์ / ตรวจวินิจฉัย'],['support','สนับสนุน'],['other','อื่น ๆ']];
const POINT_KINDS:[PointKind,string][] = [['counter','ช่อง / โต๊ะ (หน้าพื้นที่รอ)'],['room','ห้อง (ตามผนัง)'],['bed','เตียง'],['kiosk','ตู้คิว']];
const NOUNS = ['ห้องตรวจ','ห้อง','ช่องบริการ','ช่อง','เตียง','จุด','โต๊ะ'];
const STEPS:StepKind[] = ['registration','screening','exam','followup','lab','xray','pharmacy','finance','triage','treatment','ward','kiosk'];
const SOURCE_TEXT:Record<Version['source'],string> = {seed:'ผังเริ่มต้น',layout:'ตามหน้าแผนกเดิม',publish:'เผยแพร่',rollback:'ย้อนเวอร์ชัน'};
const CHANGE_TEXT:Record<Change['change'],string> = {added:'เพิ่ม',changed:'แก้ไข',removed:'ลบ',off:'ปิด',on:'เปิด',retired:'เลิกใช้'};
const KIND_TEXT:Record<string,string> = {buildings:'อาคาร',floors:'ชั้น',departments:'แผนก',groups:'กลุ่มบริการ',points:'ห้อง / ช่อง / เตียง',site:'พื้นที่รอบอาคาร'};

const strip = (f:Facility):Data => { const {version:_v, publishedAt:_p, ...d} = f; return structuredClone(d); };
// Same content, whatever order the fields come in (the server sends them back in its own order).
const canon = (v:unknown):unknown => Array.isArray(v) ? v.map(canon) : v && typeof v==='object' ? Object.fromEntries(Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a<b?-1:1).map(([k,x])=>[k,canon(x)])) : v;
const same = (a:unknown, b:unknown) => JSON.stringify(canon(a))===JSON.stringify(canon(b));
const on = (x?:{active:boolean; retiredAt?:string}) => !!x && x.active && !x.retiredAt;
const nowIso = () => new Date().toISOString();
const fmtTime = (iso:string) => new Date(iso).toLocaleString('th-TH',{day:'numeric',month:'short',year:'2-digit',hour:'2-digit',minute:'2-digit'});
function newId(d:Data, prefix:string) {
  const taken = new Set([...d.buildings,...d.floors,...d.departments,...d.groups,...d.points].map(x=>x.id));
  for (;;) { const id = `${prefix}_${Math.random().toString(36).slice(2,8)}`; if (!taken.has(id)) return id; }
}
const floorText = (d:Data, floorId?:string|null) => { if (!floorId) return 'นอกอาคาร'; const f = d.floors.find(x=>x.id===floorId), b = f && d.buildings.find(x=>x.id===f.buildingId);
  return f ? `${b?.shortName || b?.name || ''} ${f.name}`.trim() : '—'; };
const pointText = (g:FGroup|undefined, p:FPoint) => p.name || `${g?.pointNoun ?? ''} ${p.number}`.trim();
const nextLetter = (d:Data) => { const used = new Set(d.departments.map(x=>x.queuePrefix)); for (let i=0;i<26;i++) { const c = String.fromCharCode(65+i); if (!used.has(c)) return c; } return undefined; };
function Mark({text,q}:{text:string; q:string}) {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  return i<0 ? <>{text}</> : <>{text.slice(0,i)}<mark>{text.slice(i,i+q.length)}</mark>{text.slice(i+q.length)}</>;
}
function Switch({value,onChange,disabled,label}:{value:boolean; onChange:(v:boolean)=>void; disabled?:boolean; label:string}) {
  return <label className="switch small" title={label}><input type="checkbox" checked={value} disabled={disabled} onChange={e=>onChange(e.target.checked)} aria-label={label}/><span/><small>{value?'เปิด':'ปิด'}</small></label>;
}

export function FacilityPane({api,online,canEdit,head}:{api?:Api; online:boolean; canEdit:boolean; head:ReactNode}) {
  const rev = useFacility();
  const cur = facility();
  const editable = canEdit && online && !!api;
  const [data,setData] = useState<Data>(()=>strip(cur));
  const [base,setBase] = useState(cur.version);
  const [loaded,setLoaded] = useState(false);
  const [saveState,setSaveState] = useState<'idle'|'saving'|'saved'|'error'>('idle');
  const [impact,setImpact] = useState<Impact|null>(null);
  const [view,setView] = useState<'dept'|'place'>('dept');
  const [q,setQ] = useState('');
  const [filter,setFilter] = useState<Filter>('all');
  const [sel,setSel] = useState<Sel>(null);
  const [open,setOpen] = useState<Set<string>>(new Set());
  const [dialog,setDialog] = useState<'impact'|'history'|'addDept'|'addBuilding'|null>(null);
  const [confirm,setConfirm] = useState<Confirm|null>(null);
  const [toast,setToast] = useState('');
  const dirty = !same(data,strip(cur));

  // Start from this administrator's draft (if any), else the published facility.
  useEffect(()=>{ if (!editable || loaded) return;
    void api!('facility:draft:get',{}).then(r=>{ const d = (r as {draft?:{data:Data; baseVersion:number}|null}).draft;
      if (d) { setData(structuredClone(d.data)); setBase(d.baseVersion); } setLoaded(true); }); },[editable,loaded,api]);
  // Nothing edited yet (or just published): follow the published facility.
  const justPublished = useRef(false);
  useEffect(()=>{ if (!dirty || !editable || justPublished.current) { justPublished.current = false; setData(strip(facility())); setBase(facility().version); setImpact(null); } },[rev]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save the draft and check it shortly after each change.
  const timer = useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>{
    if (!editable || !loaded) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(()=>{
      if (!dirty) { setImpact(null); return; }
      setSaveState('saving');
      void api!('facility:draft:save',{data,baseVersion:base}).then(r=>setSaveState(r.ok ? 'saved' : 'error'));
      void api!('facility:impact',{data}).then(r=>{ if (r.ok) setImpact((r as unknown as {impact:Impact}).impact); });
    },700);
    return ()=>{ if (timer.current) clearTimeout(timer.current); };
  },[data,editable,loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = useCallback((fn:(d:Data)=>void)=>{ if (!editable) return; setData(prev=>{ const next = structuredClone(prev); fn(next); return next; }); },[editable]);
  // A change whose result is needed right away (the id of what was added): made once, outside React's updater.
  const apply = (fn:(d:Data)=>string) => { const next = structuredClone(data), id = fn(next); setData(next); return id; };
  const issuesAt = useMemo(()=>{ const m = new Map<string,Issue[]>(); for (const i of impact?.issues ?? []) if (i.at) m.set(i.at,[...(m.get(i.at) ?? []),i]); return m; },[impact]);
  const notify = (t:string) => { setToast(t); setTimeout(()=>setToast(''),3500); };

  // ---- Search and filters ----------------------------------------------------------------------------------------
  const needle = q.trim().toLowerCase();
  const hit = (...texts:(string|undefined)[]) => !needle || texts.some(t=>t?.toLowerCase().includes(needle));
  const groupsOf = (deptId:string) => data.groups.filter(g=>g.departmentId===deptId);
  const pointsOf = (groupId:string) => data.points.filter(p=>p.groupId===groupId).sort((a,b)=>a.number-b.number);
  const problemIn = (deptId:string) => issuesAt.has(deptId) || groupsOf(deptId).some(g=>issuesAt.has(g.id) || pointsOf(g.id).some(p=>issuesAt.has(p.id)));
  const passes = (x:{active:boolean; retiredAt?:string}, problem:boolean) => filter==='retired' ? !!x.retiredAt : x.retiredAt ? false
    : filter==='on' ? x.active : filter==='off' ? !x.active : filter==='problem' ? problem : true;
  const deptRows = data.departments.filter(d=>passes(d,problemIn(d.id))).map(d=>{
    const groups = groupsOf(d.id).filter(g=>filter==='retired' || !g.retiredAt);
    const selfHit = hit(d.name,d.shortName,d.queuePrefix,d.id);
    const shown = groups.filter(g=>selfHit || hit(g.name,g.id) || pointsOf(g.id).some(p=>hit(p.name,p.roomCode,p.id,pointText(g,p))));
    return {d,groups:selfHit ? groups : shown,match:selfHit || shown.length>0};
  }).filter(x=>x.match);
  // Departments start folded (there are many), buildings unfolded; `open` holds the ones flipped from that.
  const toggleOpen = (id:string) => setOpen(s=>{ const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const isOpen = (id:string) => !!needle || (data.buildings.some(b=>b.id===id) ? !open.has(id) : open.has(id));

  const addPoints = addPointsTo, addGroup = addGroupTo;

  // ---- Removing / retiring --------------------------------------------------------------------------------------
  const published = (id:string) => [...cur.buildings,...cur.floors,...cur.departments,...cur.groups,...cur.points].some(x=>x.id===id);
  const removePoints = (d:Data, ids:Set<string>) => { d.points = d.points.filter(p=>!ids.has(p.id)); d.points.forEach(p=>{ if (p.inRoomId && ids.has(p.inRoomId)) delete p.inRoomId; }); };
  const removeGroup = (d:Data, id:string) => { removePoints(d,new Set(d.points.filter(p=>p.groupId===id).map(p=>p.id))); d.groups = d.groups.filter(g=>g.id!==id);
    d.departments.forEach(x=>{ if (x.firstGroupId===id) delete x.firstGroupId; }); };
  // Something already published can be retired (kept for history) — or removed when nothing uses it; a new thing is removed.
  const askRemove = async (what:string, id:string, name:string, remove:()=>void, retire:()=>void, blocked?:string) => {
    const usage = api ? ((await api('facility:usage',{ids:[id]})) as unknown as {usage?:Usage}).usage?.[id] ?? [] : [];
    const isPublished = published(id), facts:ReactNode[] = [];
    if (usage.length) facts.push(<>ใช้อยู่ที่: {usage.map(u=>`${u.what} ${u.count}`).join(' · ')} — ลบไม่ได้ ให้เลิกใช้แทน</>);
    if (blocked) facts.push(blocked);
    facts.push('มีผลเมื่อเผยแพร่ ก่อนหน้านั้นยกเลิกได้');
    setConfirm(isPublished
      ? {title:`เลิกใช้${what} "${name}"`,detail:'เลิกใช้ = ไม่ใช้ต่อ แต่เก็บไว้ในประวัติ การจอง นัด และคิวเดิมยังอ่านได้ · นำกลับมาใช้ได้',facts,action:'เลิกใช้',danger:true,run:retire,
        ...(!usage.length && !blocked ? {alt:{label:'ลบออกจากผัง',run:remove}} : {})}
      : {title:`ลบ${what} "${name}"`,detail:'ยังไม่เคยเผยแพร่ ลบออกจากร่างได้เลย',facts,action:'ลบ',danger:true,run:blocked ? ()=>notify(blocked) : remove});
  };

  // ---- Publishing ------------------------------------------------------------------------------------------------
  const publish = async (note:string) => {
    const r = await api!('facility:publish',{data,baseVersion:base,note});
    if (!r.ok) { notify(r.reason ?? 'เผยแพร่ไม่สำเร็จ'); return false; }
    justPublished.current = true;
    notify(`เผยแพร่เวอร์ชัน ${(r as {version?:number}).version} แล้ว · ทุกหน้าจอใช้ผังใหม่`); setDialog(null); setImpact(null); return true;
  };
  const discard = () => setConfirm({title:'ทิ้งร่างนี้',detail:'กลับไปใช้ผังที่เผยแพร่อยู่',facts:['การแก้ไขทั้งหมดในร่างจะหายไป'],action:'ทิ้งร่าง',danger:true,
    run:async ()=>{ await api?.('facility:draft:discard',{}); setData(strip(facility())); setBase(facility().version); setImpact(null); setSaveState('idle'); }});
  const restart = () => setConfirm({title:'เริ่มร่างใหม่จากเวอร์ชันล่าสุด',detail:`มีผู้เผยแพร่เวอร์ชัน ${cur.version} ระหว่างที่คุณแก้ร่างจากเวอร์ชัน ${base}`,facts:['ร่างนี้จะถูกทิ้ง แล้วเริ่มจากผังล่าสุด'],action:'เริ่มใหม่',
    run:async ()=>{ await api?.('facility:draft:discard',{}); setData(strip(facility())); setBase(facility().version); setImpact(null); }});

  const changes = impact?.changes.length ?? (dirty ? 1 : 0);
  const errors = impact?.issues.filter(i=>i.level==='error').length ?? 0;
  const selDept = sel?.kind==='dept' ? data.departments.find(d=>d.id===sel.id) : undefined;
  const selBuilding = sel?.kind==='building' ? data.buildings.find(b=>b.id===sel.id) : undefined;
  const selFloor = sel?.kind==='floor' ? data.floors.find(f=>f.id===sel.id) : undefined;
  const ctx = {data,update,editable,issuesAt,groupsOf,pointsOf,addPoints,addGroup,removeGroup,removePoints,askRemove,setSel,api,published};

  return <section className="setCard facPane">
    {head}
    {!editable && <p className="facNote">{!canEdit ? 'ดูได้อย่างเดียว · เฉพาะผู้ดูแลระบบแก้ผังได้' : 'ต้องเชื่อมต่อระบบกลางก่อนจึงจะแก้ผังได้'}</p>}
    {editable && base!==cur.version && dirty && <p className="facNote warn"><AlertTriangle size={15}/> ร่างนี้เริ่มจากเวอร์ชัน {base} แต่ผังล่าสุดคือเวอร์ชัน {cur.version} <button className="linkBtn dark" onClick={restart}>เริ่มร่างใหม่จากเวอร์ชันล่าสุด</button></p>}
    <div className="facTop">
      <div className="facViews" role="tablist">{([['dept','ตามแผนก',Layers],['place','ตามสถานที่',Building2]] as const).map(([id,t,I])=>
        <button key={id} role="tab" aria-selected={view===id} className={view===id?'on':''} onClick={()=>setView(id)}><I size={15}/> {t}</button>)}</div>
      <span className="facVersion">เผยแพร่อยู่: เวอร์ชัน {cur.version}{cur.publishedAt ? ` · ${fmtTime(cur.publishedAt)}` : ''}</span>
      {api && canEdit && <button className="btn ghost sm" onClick={()=>setDialog('history')}><History size={14}/> ประวัติ</button>}
    </div>
    <div className="facBody">
      <aside className="facTree">
        <label className="facSearch"><Search size={15}/><input type="text" role="searchbox" value={q} onChange={e=>setQ(e.target.value)} placeholder="ค้นหา แผนก กลุ่ม ห้อง ช่อง เลขห้อง" aria-label="ค้นหาในผัง"/>
          {q && <button className="iconBtn xs" aria-label="ล้างคำค้น" onClick={()=>setQ('')}><X size={14}/></button>}</label>
        <div className="facFilters">{([['all','ทั้งหมด'],['on','เปิด'],['off','ปิด'],['problem',`มีปัญหา${impact?.issues.length ? ` (${new Set(impact.issues.map(i=>i.at)).size})` : ''}`],['retired','เลิกใช้แล้ว']] as [Filter,string][]).map(([id,t])=>
          <button key={id} className={'chip'+(filter===id?' on':'')} onClick={()=>setFilter(id)}>{t}</button>)}</div>
        {view==='dept' ? <ul className="facList">
          {deptRows.map(({d,groups})=>{ const pts = groups.flatMap(g=>pointsOf(g.id)), floors = new Set(groups.map(g=>g.floorId).filter(Boolean));
            return <li key={d.id}>
              <div className={'facNode dept'+(sel?.kind==='dept' && sel.id===d.id ? ' sel' : '')+(on(d)?'':' off')}>
                <button className="facCaret" aria-label={isOpen(d.id)?'ย่อ':'ขยาย'} onClick={()=>toggleOpen(d.id)}>{isOpen(d.id) ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</button>
                <button className="facLabel" onClick={()=>setSel({kind:'dept',id:d.id})}>
                  <i className={'facDot'+(d.retiredAt?' gone':on(d)?' on':'')}/>{d.queuePrefix && <span className="facLetter">{d.queuePrefix}</span>}<b><Mark text={d.name} q={needle}/></b>
                  {problemIn(d.id) && <AlertTriangle size={13} className="facWarn"/>}<small>{floors.size>1 ? `${floors.size} ชั้น · ` : floors.size ? `${floorText(data,[...floors][0])} · ` : ''}{pts.length} จุด</small></button>
              </div>
              {isOpen(d.id) && <ul>{groups.map(g=><li key={g.id}><button className={'facNode group'+(sel?.focus===g.id?' sel':'')+(on(g)?'':' off')} onClick={()=>{ setSel({kind:'dept',id:d.id,focus:g.id}); }}>
                <i className={'facDot'+(g.retiredAt?' gone':on(g)?' on':'')}/><span><Mark text={g.name} q={needle}/></span>{(issuesAt.has(g.id) || pointsOf(g.id).some(p=>issuesAt.has(p.id))) && <AlertTriangle size={12} className="facWarn"/>}
                <small>{floorText(data,g.floorId)} · {pointsOf(g.id).filter(p=>!p.retiredAt).length} {g.pointNoun}</small></button></li>)}</ul>}
            </li>; })}
          {!deptRows.length && <li className="cmdEmpty">ไม่พบ{needle ? ` “${q}”` : 'ในตัวกรองนี้'}</li>}
          {editable && <li><button className="facAdd" onClick={()=>setDialog('addDept')}><Plus size={15}/> เพิ่มแผนก / หน่วยงาน</button></li>}
        </ul> : <ul className="facList">
          {data.buildings.filter(b=>passes(b,false) || filter==='problem').filter(b=>hit(b.name,b.shortName) || data.floors.some(f=>f.buildingId===b.id && (hit(f.name,f.description) || data.groups.some(g=>g.floorId===f.id && hit(g.name))))).map(b=>{
            const floors = data.floors.filter(f=>f.buildingId===b.id && (filter==='retired' || !f.retiredAt)).sort((x,y)=>y.level-x.level);
            return <li key={b.id}>
              <div className={'facNode dept'+(sel?.kind==='building' && sel.id===b.id ? ' sel' : '')+(on(b)?'':' off')}>
                <button className="facCaret" aria-label={isOpen(b.id)?'ย่อ':'ขยาย'} onClick={()=>toggleOpen(b.id)}>{isOpen(b.id) ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</button>
                <button className="facLabel" onClick={()=>setSel({kind:'building',id:b.id})}><i className={'facDot'+(b.retiredAt?' gone':on(b)?' on':'')}/><Building2 size={14}/><b><Mark text={b.name} q={needle}/></b><small>{floors.length} ชั้น</small></button>
              </div>
              {isOpen(b.id) && <ul>{floors.map(f=>{ const here = data.groups.filter(g=>g.floorId===f.id && !g.retiredAt);
                return <li key={f.id}>
                  <button className={'facNode floor'+(sel?.kind==='floor' && sel.id===f.id ? ' sel' : '')+(on(f)?'':' off')} onClick={()=>setSel({kind:'floor',id:f.id})}>
                    <i className={'facDot'+(f.retiredAt?' gone':on(f)?' on':'')}/><b>{f.name}</b><small><Mark text={f.description} q={needle}/></small></button>
                  <ul>{here.map(g=>{ const d = data.departments.find(x=>x.id===g.departmentId);
                    return <li key={g.id}><button className={'facNode group'+(on(g)&&on(d)?'':' off')} onClick={()=>setSel({kind:'dept',id:g.departmentId,focus:g.id})}>
                      <span><Mark text={g.name} q={needle}/></span><small>{pointsOf(g.id).filter(p=>!p.retiredAt).length} {g.pointNoun}</small></button></li>; })}</ul>
                </li>; })}</ul>}
            </li>; })}
          {editable && <li><button className="facAdd" onClick={()=>setDialog('addBuilding')}><Plus size={15}/> เพิ่มอาคาร</button></li>}
        </ul>}
      </aside>
      <div className="facDetail">
        {selDept ? <DeptDetail key={selDept.id} d={selDept} focus={sel?.focus} ctx={ctx}/>
          : selBuilding ? <BuildingDetail key={selBuilding.id} b={selBuilding} ctx={ctx}/>
          : selFloor ? <FloorDetail key={selFloor.id} f={selFloor} ctx={ctx}/>
          : <div className="facEmpty"><MapPin size={28}/><b>เลือกแผนก อาคาร หรือชั้นทางซ้าย</b><span>ค้นหาได้ทั้งชื่อแผนก กลุ่มบริการ ห้อง ช่อง และเลขห้อง</span>
            <span className="muted">{data.buildings.filter(b=>!b.retiredAt).length} อาคาร · {data.floors.filter(f=>!f.retiredAt).length} ชั้น · {data.departments.filter(d=>!d.retiredAt).length} แผนก · {data.groups.filter(g=>!g.retiredAt).length} กลุ่มบริการ · {data.points.filter(p=>!p.retiredAt).length} ห้อง/ช่อง/เตียง</span></div>}
      </div>
    </div>
    {editable && dirty && <div className="saveBar facBar">
      <span><b>ร่าง · {impact ? `${changes} การเปลี่ยน` : 'กำลังตรวจ…'}{errors ? ` · ต้องแก้ ${errors} ข้อ` : ''}</b>
        <small>{saveState==='saving' ? 'กำลังบันทึกร่าง…' : saveState==='error' ? 'บันทึกร่างไม่สำเร็จ' : 'บันทึกร่างแล้ว · ยังไม่มีผลกับหน้าจอใดจนกว่าจะเผยแพร่'}</small></span>
      <button className="btn ghost" onClick={discard}>ทิ้งร่าง</button>
      <button className="btn" onClick={()=>setDialog('impact')}>ดูผลกระทบและเผยแพร่</button>
    </div>}
    {toast && <div className="facToast" role="status">{toast}</div>}
    {dialog==='impact' && <ImpactDialog impact={impact} data={data} onClose={()=>setDialog(null)} onPublish={publish} onShow={(id)=>{ const d = data.departments.find(x=>x.id===id) ?? data.departments.find(x=>data.groups.some(g=>g.departmentId===x.id && (g.id===id || data.points.some(p=>p.groupId===g.id && p.id===id))));
      if (d) setSel({kind:'dept',id:d.id,focus:data.groups.find(g=>g.id===id)?.id ?? data.points.find(p=>p.id===id)?.groupId}); else { const b = data.buildings.find(x=>x.id===id), f = data.floors.find(x=>x.id===id); if (b) setSel({kind:'building',id}); else if (f) setSel({kind:'floor',id}); }
      setDialog(null); }}/>}
    {dialog==='history' && api && <HistoryDialog api={api} current={cur.version} canRollback={editable} onClose={()=>setDialog(null)} onDone={t=>notify(t)}/>}
    {dialog==='addDept' && <AddDeptDialog data={data} onClose={()=>setDialog(null)} onAdd={(fn)=>{ const id = apply(fn); setSel({kind:'dept',id}); setOpen(s=>new Set([...s,id])); setView('dept'); setFilter('all'); setDialog(null); }}/>}
    {dialog==='addBuilding' && <AddBuildingDialog data={data} onClose={()=>setDialog(null)} onAdd={(fn)=>{ const id = apply(fn); setSel({kind:'building',id}); setView('place'); setFilter('all'); setDialog(null); }}/>}
    {confirm && <ConfirmDialog confirm={confirm} onClose={()=>setConfirm(null)}/>}
  </section>;
}

type Ctx = {data:Data; update:(fn:(d:Data)=>void)=>void; editable:boolean; issuesAt:Map<string,Issue[]>; groupsOf:(id:string)=>FGroup[]; pointsOf:(id:string)=>FPoint[];
  addPoints:(d:Data, g:FGroup, n:number, firstCode?:number)=>void; addGroup:(d:Data, deptId:string, floorId:string|null, g:Partial<FGroup>, n:number)=>FGroup;
  removeGroup:(d:Data, id:string)=>void; removePoints:(d:Data, ids:Set<string>)=>void; askRemove:(what:string, id:string, name:string, remove:()=>void, retire:()=>void, blocked?:string)=>void;
  setSel:(s:Sel)=>void; api?:Api; published:(id:string)=>boolean};

function Issues({list}:{list?:Issue[]}) {
  if (!list?.length) return null;
  return <ul className="facIssues">{list.map((i,k)=><li key={k} className={i.level}><AlertTriangle size={13}/> {i.message}</li>)}</ul>;
}
const floorOptions = (d:Data, outdoors=false) => [...(outdoors ? [{value:'',label:'นอกอาคาร',sub:'บนพื้นที่โรงพยาบาล'}] : []),
  ...d.buildings.filter(b=>!b.retiredAt).flatMap(b=>d.floors.filter(f=>f.buildingId===b.id && !f.retiredAt).sort((x,y)=>x.level-y.level).map(f=>({value:f.id,label:`${b.shortName || b.name} ${f.name}`,sub:f.description})))];

// ---- Department -----------------------------------------------------------------------------------------------------
function DeptDetail({d,focus,ctx}:{d:FDepartment; focus?:string; ctx:Ctx}) {
  const {data,update,editable,issuesAt,groupsOf,askRemove,api} = ctx;
  const groups = groupsOf(d.id);
  const set = (fn:(x:FDepartment)=>void) => update(x=>{ const t = x.departments.find(y=>y.id===d.id); if (t) fn(t); });
  const [usage,setUsage] = useState<Usage>({});
  useEffect(()=>{ if (!api) return; void api('facility:usage',{ids:[d.id,...groups.flatMap(g=>ctx.pointsOf(g.id).map(p=>p.id))]}).then(r=>setUsage(((r as unknown as {usage?:Usage}).usage) ?? {})); },[d.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const ref = useRef<HTMLDivElement>(null);
  useEffect(()=>{ if (focus) ref.current?.querySelector(`[data-group="${focus}"]`)?.scrollIntoView({block:'nearest',behavior:'smooth'}); },[focus]);
  const move = (dir:-1|1) => update(x=>{ const i = x.departments.findIndex(y=>y.id===d.id), j = i+dir; if (j<0 || j>=x.departments.length) return; [x.departments[i],x.departments[j]] = [x.departments[j],x.departments[i]]; });
  const prefixTaken = d.queuePrefix && data.departments.some(x=>x.id!==d.id && x.queuePrefix===d.queuePrefix);
  const firstFloor = groups.find(g=>g.floorId)?.floorId ?? floorOptions(data)[0]?.value ?? null;
  const u = usage[d.id];
  return <div className="facCard" ref={ref}>
    <header className="facHead">
      <div><span className="facKind">{DEPT_TYPES.find(t=>t[0]===d.type)?.[1]}</span><h3>{d.name || 'ไม่มีชื่อ'}{d.retiredAt && <em className="tagNew">เลิกใช้แล้ว</em>}</h3>
        <small className="muted">รหัส {d.id} · ไม่เปลี่ยนแม้เปลี่ยนชื่อหรือย้ายที่</small></div>
      <span className="rowActs">
        <button className="iconBtn" title="เลื่อนขึ้น" aria-label="เลื่อนขึ้น" disabled={!editable} onClick={()=>move(-1)}><ChevronUp size={16}/></button>
        <button className="iconBtn" title="เลื่อนลง" aria-label="เลื่อนลง" disabled={!editable} onClick={()=>move(1)}><ChevronDown size={16}/></button>
        {d.retiredAt ? <button className="iconBtn" title="นำกลับมาใช้" aria-label="นำกลับมาใช้" disabled={!editable} onClick={()=>set(x=>{ delete x.retiredAt; })}><ArchiveRestore size={16}/></button>
          : <button className="iconBtn danger" title="เลิกใช้ / ลบแผนก" aria-label="เลิกใช้หรือลบแผนก" disabled={!editable}
            onClick={()=>askRemove('แผนก',d.id,d.name,()=>update(x=>{ x.groups.filter(g=>g.departmentId===d.id).forEach(g=>ctx.removeGroup(x,g.id)); x.departments = x.departments.filter(y=>y.id!==d.id); }),()=>set(x=>{ x.retiredAt = nowIso(); }))}><Trash2 size={16}/></button>}
        <Switch value={d.active} disabled={!editable || !!d.retiredAt} onChange={v=>set(x=>{ x.active = v; })} label={d.active?'ปิดแผนก':'เปิดแผนก'}/>
      </span>
    </header>
    <Issues list={issuesAt.get(d.id)}/>
    {u && <p className="facUsage">ใช้อยู่ที่: {u.map(x=>`${x.what} ${x.count}`).join(' · ')}</p>}
    <div className="facFields">
      <label className="wide"><span>ชื่อแผนก</span><input value={d.name} disabled={!editable} onChange={e=>set(x=>{ x.name = e.target.value; })} maxLength={60}/></label>
      <label><span>ชื่อย่อ (ไม่บังคับ)</span><input value={d.shortName ?? ''} disabled={!editable} onChange={e=>set(x=>{ if (e.target.value) x.shortName = e.target.value; else delete x.shortName; })} maxLength={60}/></label>
      <label><span>อักษรคิว</span><input value={d.queuePrefix ?? ''} disabled={!editable} maxLength={3} aria-invalid={!!prefixTaken}
        onChange={e=>set(x=>{ const v = e.target.value.toUpperCase().replace(/[^A-Z]/g,''); if (v) x.queuePrefix = v; else delete x.queuePrefix; })} placeholder="ไม่ใช้"/>{prefixTaken && <em className="facErr">ซ้ำกับแผนกอื่น</em>}</label>
      <label><span>ประเภท</span><Select value={d.type} disabled={!editable} onChange={v=>set(x=>{ x.type = v; })} options={DEPT_TYPES.map(([value,label])=>({value,label}))} aria-label="ประเภทแผนก"/></label>
      <label className="wide"><span>ผู้ป่วยไปรอที่ไหนก่อน (ขั้นแรก)</span><Select value={d.firstGroupId ?? ''} disabled={!editable} onChange={v=>set(x=>{ if (v) x.firstGroupId = v; else delete x.firstGroupId; })}
        options={[{value:'',label:'ไม่กำหนด'},...data.groups.filter(g=>!g.retiredAt).map(g=>({value:g.id,label:g.name,sub:`${data.departments.find(x=>x.id===g.departmentId)?.name ?? ''} · ${floorText(data,g.floorId)}`}))]} aria-label="ขั้นแรก"/></label>
      <fieldset className="wide facChecks"><legend>รับผู้ป่วย</legend>
        {([['walkIn','หน้างาน (walk-in)'],['booking','จองล่วงหน้า'],['appointments','นัดแพทย์']] as const).map(([k,t])=>
          <label key={k}><input type="checkbox" checked={d.features[k]} disabled={!editable} onChange={e=>set(x=>{ x.features[k] = e.target.checked; })}/> {t}</label>)}</fieldset>
    </div>
    <h4 className="setSub">กลุ่มบริการ <small>ห้อง/ช่องที่ให้บริการขั้นเดียวกันและใช้คิวเดียวกัน · แต่ละกลุ่มอยู่คนละชั้นได้</small></h4>
    {groups.map((g,i)=><GroupCard key={g.id} g={g} first={i===0} last={i===groups.length-1} focused={focus===g.id} usage={usage} ctx={ctx}/>)}
    {editable && !d.retiredAt && <button className="facAdd" onClick={()=>update(x=>{ ctx.addGroup(x,d.id,firstFloor,{name:`กลุ่มบริการใหม่ ${groups.length+1}`},1); })}><Plus size={15}/> เพิ่มกลุ่มบริการ</button>}
  </div>;
}

function GroupCard({g,first,last,focused,usage,ctx}:{g:FGroup; first:boolean; last:boolean; focused:boolean; usage:Usage; ctx:Ctx}) {
  const {data,update,editable,issuesAt,pointsOf,askRemove} = ctx;
  const pts = pointsOf(g.id);
  const set = (fn:(x:FGroup)=>void) => update(x=>{ const t = x.groups.find(y=>y.id===g.id); if (t) fn(t); });
  const setPoint = (id:string, fn:(p:FPoint)=>void) => update(x=>{ const t = x.points.find(p=>p.id===id); if (t) fn(t); });
  const [count,setCount] = useState(1), [code,setCode] = useState('');
  const [editing,setEditing] = useState<string|null>(null);
  const move = (dir:-1|1) => update(x=>{ const mine = x.groups.filter(y=>y.departmentId===g.departmentId), i = mine.findIndex(y=>y.id===g.id), other = mine[i+dir]; if (!other) return;
    const a = x.groups.indexOf(mine[i]), b = x.groups.indexOf(other); [x.groups[a],x.groups[b]] = [x.groups[b],x.groups[a]]; });
  const rooms = data.points.filter(p=>data.groups.find(y=>y.id===p.groupId)?.pointKind==='room' && !p.retiredAt);
  const open = pts.filter(p=>on(p)).length;
  const issues = [...(issuesAt.get(g.id) ?? []),...pts.flatMap(p=>issuesAt.get(p.id) ?? [])];
  return <div className={'facGroup'+(focused?' focus':'')+(on(g)?'':' off')} data-group={g.id}>
    <div className="facGroupHead">
      <input className="facGroupName" value={g.name} disabled={!editable} onChange={e=>set(x=>{ x.name = e.target.value; })} aria-label="ชื่อกลุ่มบริการ" maxLength={60}/>
      {g.retiredAt && <em className="tagNew">เลิกใช้แล้ว</em>}
      <span className="muted facCount">เปิด {open}/{pts.filter(p=>!p.retiredAt).length}</span>
      <span className="rowActs">
        <button className="iconBtn xs" aria-label="เลื่อนขึ้น" title="เลื่อนขึ้น" disabled={!editable || first} onClick={()=>move(-1)}><ChevronUp size={15}/></button>
        <button className="iconBtn xs" aria-label="เลื่อนลง" title="เลื่อนลง" disabled={!editable || last} onClick={()=>move(1)}><ChevronDown size={15}/></button>
        {g.retiredAt ? <button className="iconBtn xs" title="นำกลับมาใช้" aria-label="นำกลับมาใช้" disabled={!editable} onClick={()=>set(x=>{ delete x.retiredAt; })}><ArchiveRestore size={15}/></button>
          : <button className="iconBtn xs" title="เลิกใช้ / ลบกลุ่ม" aria-label="เลิกใช้หรือลบกลุ่ม" disabled={!editable}
            onClick={()=>askRemove('กลุ่มบริการ',g.id,g.name,()=>update(x=>ctx.removeGroup(x,g.id)),()=>set(x=>{ x.retiredAt = nowIso(); }))}><Trash2 size={15}/></button>}
        <Switch value={g.active} disabled={!editable || !!g.retiredAt} onChange={v=>set(x=>{ x.active = v; })} label={g.active?'ปิดกลุ่ม':'เปิดกลุ่ม'}/>
      </span>
    </div>
    <div className="facFields compact">
      <label><span>อยู่ที่</span><Select value={g.floorId ?? ''} disabled={!editable} onChange={v=>set(x=>{ x.floorId = v || null; })} options={floorOptions(data,g.pointKind==='kiosk')} aria-label="ชั้นของกลุ่ม"/></label>
      <label><span>ชนิดจุด</span><Select value={g.pointKind} disabled={!editable} onChange={v=>set(x=>{ x.pointKind = v; })} options={POINT_KINDS.map(([value,label])=>({value,label}))} aria-label="ชนิดจุด"/></label>
      <label><span>คำเรียกจุด</span><input value={g.pointNoun} disabled={!editable} list="facNouns" onChange={e=>set(x=>{ x.pointNoun = e.target.value; })} maxLength={20}/></label>
      <label><span>เปิดอย่างน้อย</span><input type="number" min={0} max={50} value={g.minOpen} disabled={!editable} onChange={e=>set(x=>{ x.minOpen = Math.max(0,Math.min(50,Number(e.target.value)||0)); })}/></label>
      <label className="wide"><span>ให้บริการขั้นตอน</span><Select multiple value={g.steps as StepKind[]} disabled={!editable} onChange={v=>set(x=>{ x.steps = v; })}
        options={STEPS.map(s=>({value:s,label:stepText[s].serve}))} placeholder="ไม่ใช่จุดคิว (เช่น ห้องทำงาน)" aria-label="ขั้นตอนที่ให้บริการ"/></label>
      <label><span>ให้บริการ</span><Select value={g.serves} disabled={!editable} onChange={v=>set(x=>{ x.serves = v; })} options={[{value:'department' as const,label:'ผู้ป่วยของแผนกนี้'},{value:'all' as const,label:'ทุกแผนก (จุดบริการร่วม)'}]} aria-label="ให้บริการใคร"/></label>
      {g.pointKind==='counter' && <label><span>การจัดวาง</span><Select value={g.options?.arrange ?? 'counter'} disabled={!editable} onChange={v=>set(x=>{ x.options = {...x.options,arrange:v}; if (v==='counter') { delete x.options.arrange; if (!Object.keys(x.options).length) delete x.options; } })}
        options={[{value:'counter' as const,label:'เคาน์เตอร์ยาว (นั่งเรียงกัน)'},{value:'booths' as const,label:'โต๊ะแยกกระจายในพื้นที่'}]} aria-label="การจัดวาง"/></label>}
      {g.pointKind==='bed' && g.steps.includes('treatment') && <label><span>รับผู้ป่วยระดับ</span><Select value={(g.options?.triage ?? [1,5]).join('-')} disabled={!editable}
        onChange={v=>set(x=>{ const [a,b] = v.split('-').map(Number); if (a===1 && b===5) { if (x.options) { delete x.options.triage; if (!Object.keys(x.options).length) delete x.options; } } else x.options = {...x.options,triage:[a,b]}; })}
        options={[['1-5','ทุกระดับ'],['1-2','วิกฤต (1–2) เช่น เตียงกู้ชีพ'],['3-5','ไม่วิกฤต (3–5)'],['1-3','1–3']].map(([value,label])=>({value,label}))} aria-label="ระดับคัดแยก"/></label>}
    </div>
    <Issues list={issues}/>
    <div className="facChips">{pts.filter(p=>!p.retiredAt || editing===p.id).map(p=>{ const u = usage[p.id];
      return <span key={p.id} className={'facChip'+(on(p)?' on':'')+(p.floorId?' moved':'')+(issuesAt.has(p.id)?' bad':'')}>
        <button disabled={!editable} onClick={()=>setPoint(p.id,x=>{ x.active = !x.active; })} title={on(p)?'กดเพื่อปิด':'กดเพื่อเปิด'} aria-pressed={on(p)}>
          <i/>{pointText(g,p)}{p.roomCode && !pointText(g,p).includes(p.roomCode) && <small>· {p.roomCode}</small>}{p.floorId && <small>· {floorText(data,p.floorId)}</small>}{u && <small title={u.map(x=>`${x.what} ${x.count}`).join(' · ')}>●</small>}</button>
        {editable && <button className="facChipEdit" aria-label={`แก้ไข ${pointText(g,p)}`} onClick={()=>setEditing(e=>e===p.id?null:p.id)}><Pencil size={12}/></button>}
      </span>; })}</div>
    {editing && (()=>{ const p = pts.find(x=>x.id===editing); if (!p) return null;
      return <div className="facPointEdit">
        <label><span>เลข</span><input type="number" min={0} value={p.number} onChange={e=>setPoint(p.id,x=>{ x.number = Math.max(0,Number(e.target.value)||0); })}/></label>
        <label><span>ชื่อ (ว่าง = {g.pointNoun} {p.number})</span><input value={p.name ?? ''} onChange={e=>setPoint(p.id,x=>{ if (e.target.value) x.name = e.target.value; else delete x.name; })} maxLength={60}/></label>
        <label><span>เลขห้อง/ป้าย</span><input value={p.roomCode ?? ''} onChange={e=>setPoint(p.id,x=>{ const v = e.target.value.trim(); if (v) x.roomCode = v; else delete x.roomCode; })} maxLength={12}/></label>
        <label><span>ชั้น (ถ้าไม่ใช่ชั้นของกลุ่ม)</span><Select value={p.floorId ?? ''} onChange={v=>setPoint(p.id,x=>{ if (v) x.floorId = v; else delete x.floorId; })} options={[{value:'',label:'ชั้นเดียวกับกลุ่ม'},...floorOptions(data)]} aria-label="ชั้นของจุด"/></label>
        {g.pointKind==='bed' && <label><span>อยู่ในห้อง</span><Select value={p.inRoomId ?? ''} onChange={v=>setPoint(p.id,x=>{ if (v) x.inRoomId = v; else delete x.inRoomId; })}
          options={[{value:'',label:'ไม่อยู่ในห้อง (เตียงรวม)'},...rooms.map(r=>({value:r.id,label:pointText(data.groups.find(y=>y.id===r.groupId),r),sub:floorText(data,r.floorId ?? data.groups.find(y=>y.id===r.groupId)?.floorId)}))]} aria-label="ห้องของเตียง"/></label>}
        <span className="rowActs">
          {p.retiredAt ? <button className="btn ghost sm" onClick={()=>setPoint(p.id,x=>{ delete x.retiredAt; })}><Undo2 size={14}/> นำกลับมาใช้</button>
            : <button className="btn ghost sm warnBtn" onClick={()=>askRemove(g.pointNoun,p.id,pointText(g,p),()=>{ update(x=>ctx.removePoints(x,new Set([p.id]))); setEditing(null); },()=>{ setPoint(p.id,x=>{ x.retiredAt = nowIso(); }); setEditing(null); })}><Trash2 size={14}/> เลิกใช้ / ลบ</button>}
          <button className="btn sm" onClick={()=>setEditing(null)}>เสร็จ</button></span>
      </div>; })()}
    {editable && !g.retiredAt && <div className="facAddPoints">
      <span>เพิ่ม</span><input type="number" min={1} max={50} value={count} onChange={e=>setCount(Math.max(1,Math.min(50,Number(e.target.value)||1)))} aria-label="จำนวนที่เพิ่ม"/><span>{g.pointNoun}</span>
      {g.pointKind==='room' && <><span className="muted">เลขห้องเริ่ม</span><input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,''))} placeholder="เช่น 301" aria-label="เลขห้องเริ่มต้น" maxLength={6}/></>}
      <button className="btn ghost sm" onClick={()=>{ update(x=>{ const t = x.groups.find(y=>y.id===g.id)!; ctx.addPoints(x,t,count,code ? Number(code) : undefined); }); setCode(''); }}><Plus size={14}/> เพิ่ม</button>
      <small className="muted">เลขต่อจากตัวสุดท้ายให้เอง</small>
    </div>}
    <datalist id="facNouns">{NOUNS.map(n=><option key={n} value={n}/>)}</datalist>
  </div>;
}

// ---- Building and floor ---------------------------------------------------------------------------------------------
function BuildingDetail({b,ctx}:{b:FBuilding; ctx:Ctx}) {
  const {data,update,editable,issuesAt,askRemove,setSel} = ctx;
  const set = (fn:(x:FBuilding)=>void) => update(x=>{ const t = x.buildings.find(y=>y.id===b.id); if (t) fn(t); });
  const floors = data.floors.filter(f=>f.buildingId===b.id).sort((x,y)=>y.level-x.level);
  const used = data.groups.some(g=>floors.some(f=>f.id===g.floorId)) || data.points.some(p=>floors.some(f=>f.id===p.floorId));
  const num = (v:string, lo:number, hi:number) => Math.max(lo,Math.min(hi,Number(v)||0));
  return <div className="facCard">
    <header className="facHead">
      <div><span className="facKind">อาคาร · {BUILDING_KINDS.find(k=>k[0]===b.kind)?.[1]}</span><h3>{b.name}{b.retiredAt && <em className="tagNew">เลิกใช้แล้ว</em>}</h3><small className="muted">รหัส {b.id}</small></div>
      <span className="rowActs">
        {b.retiredAt ? <button className="iconBtn" title="นำกลับมาใช้" aria-label="นำกลับมาใช้" disabled={!editable} onClick={()=>set(x=>{ delete x.retiredAt; })}><ArchiveRestore size={16}/></button>
          : <button className="iconBtn danger" title={used ? 'ย้ายกลุ่มบริการออกจากอาคารก่อนจึงจะลบได้ · เลิกใช้ได้' : 'เลิกใช้ / ลบอาคาร'} aria-label="เลิกใช้หรือลบอาคาร" disabled={!editable}
            onClick={()=>askRemove('อาคาร',b.id,b.name,()=>{ update(x=>{ x.floors = x.floors.filter(f=>f.buildingId!==b.id); x.buildings = x.buildings.filter(y=>y.id!==b.id); }); setSel(null); },()=>set(x=>{ x.retiredAt = nowIso(); }),
              used ? 'ยังมีกลุ่มบริการอยู่บนชั้นของอาคารนี้ — ย้ายไปที่อื่นก่อนจึงจะลบได้' : undefined)}><Trash2 size={16}/></button>}
        <Switch value={b.active} disabled={!editable || !!b.retiredAt} onChange={v=>set(x=>{ x.active = v; })} label={b.active?'ปิดอาคาร':'เปิดอาคาร'}/>
      </span>
    </header>
    <Issues list={issuesAt.get(b.id)}/>
    <div className="facFields">
      <label className="wide"><span>ชื่ออาคาร</span><input value={b.name} disabled={!editable} onChange={e=>set(x=>{ x.name = e.target.value; })} maxLength={60}/></label>
      <label><span>ชื่อย่อ (ป้าย/จอ)</span><input value={b.shortName} disabled={!editable} onChange={e=>set(x=>{ x.shortName = e.target.value; })} maxLength={60}/></label>
      <label><span>ชนิด (หน้าตาบนแผนที่)</span><Select value={b.kind} disabled={!editable} onChange={v=>set(x=>{ x.kind = v; })} options={BUILDING_KINDS.map(([value,label])=>({value,label}))} aria-label="ชนิดอาคาร"/></label>
      <fieldset className="wide facMap"><legend>ตำแหน่งและขนาดบนแผนที่ (หน่วยแผนที่ · ระยะถัดไปลากบนผังได้)</legend>
        {([['x','ตำแหน่ง X',-200,200],['z','ตำแหน่ง Z',-200,200],['width','กว้าง',3,60],['depth','ลึก',3,60]] as const).map(([k,t,lo,hi])=>
          <label key={k}><span>{t}</span><input type="number" step={0.5} value={b.map[k]} disabled={!editable} onChange={e=>set(x=>{ x.map[k] = num(e.target.value,lo,hi); })}/></label>)}
        <label><span>สี</span><input type="color" value={b.map.color} disabled={!editable} onChange={e=>set(x=>{ x.map.color = e.target.value; })}/></label></fieldset>
    </div>
    <h4 className="setSub">ชั้น <small>บนสุดอยู่บน · เลขชั้นใช้กับป้ายและการนำทาง</small></h4>
    <ul className="facFloors">{floors.map(f=><li key={f.id} className={on(f)?'':'off'}>
      <button className="linkBtn dark" onClick={()=>setSel({kind:'floor',id:f.id})}><b>{f.name}</b></button><span className="muted">{f.description || '—'}</span>
      <small>{data.groups.filter(g=>g.floorId===f.id && !g.retiredAt).length} กลุ่มบริการ</small>
      <Switch value={f.active} disabled={!editable || !!f.retiredAt} onChange={v=>update(x=>{ const t = x.floors.find(y=>y.id===f.id); if (t) t.active = v; })} label={f.active?'ปิดชั้น':'เปิดชั้น'}/></li>)}</ul>
    {editable && <button className="facAdd" onClick={()=>update(x=>{ const top = Math.max(0,...x.floors.filter(f=>f.buildingId===b.id).map(f=>f.level)); x.floors.push({id:newId(x,'f'),buildingId:b.id,level:top+1,name:`ชั้น ${top+1}`,description:'',active:true}); })}><Plus size={15}/> เพิ่มชั้นบนสุด</button>}
  </div>;
}

function FloorDetail({f,ctx}:{f:FFloor; ctx:Ctx}) {
  const {data,update,editable,issuesAt,askRemove,setSel} = ctx;
  const b = data.buildings.find(x=>x.id===f.buildingId);
  const set = (fn:(x:FFloor)=>void) => update(x=>{ const t = x.floors.find(y=>y.id===f.id); if (t) fn(t); });
  const here = data.groups.filter(g=>g.floorId===f.id), visiting = data.points.filter(p=>p.floorId===f.id);
  const [dept,setDept] = useState('');
  const levelTaken = data.floors.some(x=>x.id!==f.id && x.buildingId===f.buildingId && x.level===f.level);
  return <div className="facCard">
    <header className="facHead">
      <div><span className="facKind">{b?.name}</span><h3>{f.name}{f.retiredAt && <em className="tagNew">เลิกใช้แล้ว</em>}</h3><small className="muted">รหัส {f.id}</small></div>
      <span className="rowActs">
        {f.retiredAt ? <button className="iconBtn" title="นำกลับมาใช้" aria-label="นำกลับมาใช้" disabled={!editable} onClick={()=>set(x=>{ delete x.retiredAt; })}><ArchiveRestore size={16}/></button>
          : <button className="iconBtn danger" title={here.length || visiting.length ? 'ย้ายกลุ่มบริการออกจากชั้นก่อนจึงจะลบได้ · เลิกใช้ได้' : 'เลิกใช้ / ลบชั้น'} aria-label="เลิกใช้หรือลบชั้น" disabled={!editable}
            onClick={()=>askRemove('ชั้น',f.id,`${b?.shortName ?? ''} ${f.name}`,()=>{ update(x=>{ x.floors = x.floors.filter(y=>y.id!==f.id); }); setSel(b ? {kind:'building',id:b.id} : null); },()=>set(x=>{ x.retiredAt = nowIso(); }),
              here.length || visiting.length ? 'ยังมีกลุ่มบริการบนชั้นนี้ — ย้ายไปชั้นอื่นก่อนจึงจะลบได้' : undefined)}><Trash2 size={16}/></button>}
        <Switch value={f.active} disabled={!editable || !!f.retiredAt} onChange={v=>set(x=>{ x.active = v; })} label={f.active?'ปิดชั้น':'เปิดชั้น'}/>
      </span>
    </header>
    <Issues list={issuesAt.get(f.id)}/>
    <div className="facFields">
      <label><span>ชื่อชั้น (บนป้าย)</span><input value={f.name} disabled={!editable} onChange={e=>set(x=>{ x.name = e.target.value; })} maxLength={60}/></label>
      <label><span>เลขชั้น</span><input type="number" min={-9} max={99} value={f.level} disabled={!editable} aria-invalid={levelTaken} onChange={e=>set(x=>{ x.level = Math.max(-9,Math.min(99,Math.round(Number(e.target.value)||0))); })}/>{levelTaken && <em className="facErr">มีชั้นนี้แล้ว</em>}</label>
      <label className="wide"><span>คำอธิบาย</span><input value={f.description} disabled={!editable} onChange={e=>set(x=>{ x.description = e.target.value; })} maxLength={120} placeholder="เช่น ห้องตรวจอายุรกรรม"/></label>
    </div>
    <h4 className="setSub">บนชั้นนี้ <small>พื้นที่รอของแต่ละแผนกเรียงตามลำดับแผนก</small></h4>
    <ul className="facFloors">{here.map(g=>{ const d = data.departments.find(x=>x.id===g.departmentId);
      return <li key={g.id} className={on(g)&&on(d)?'':'off'}><button className="linkBtn dark" onClick={()=>setSel({kind:'dept',id:g.departmentId,focus:g.id})}><b>{g.name}</b></button>
        <span className="muted">{d?.name}</span><small>{ctx.pointsOf(g.id).filter(p=>!p.retiredAt).length} {g.pointNoun}</small></li>; })}
      {visiting.map(p=>{ const g = data.groups.find(x=>x.id===p.groupId);
        return <li key={p.id}><button className="linkBtn dark" onClick={()=>g && setSel({kind:'dept',id:g.departmentId,focus:g.id})}><b>{pointText(g,p)}</b></button><span className="muted">ของ {g?.name} (อยู่คนละชั้นกับกลุ่ม)</span></li>; })}
      {!here.length && !visiting.length && <li className="muted">ยังไม่มีกลุ่มบริการบนชั้นนี้</li>}</ul>
    {editable && <div className="facAddPoints">
      <span>วางกลุ่มบริการใหม่ของ</span><Select value={dept} onChange={setDept} options={data.departments.filter(x=>!x.retiredAt).map(x=>({value:x.id,label:x.name}))} placeholder="เลือกแผนก" aria-label="แผนกของกลุ่มใหม่"/>
      <button className="btn ghost sm" disabled={!dept} onClick={()=>{ update(x=>{ ctx.addGroup(x,dept,f.id,{name:`${x.departments.find(y=>y.id===dept)?.name ?? ''} ${f.name}`},1); }); setSel({kind:'dept',id:dept}); }}><Plus size={14}/> วางบนชั้นนี้</button>
    </div>}
  </div>;
}

// ---- Dialogs --------------------------------------------------------------------------------------------------------
function Dialog({title,detail,onClose,children,footer,wide}:{title:string; detail?:string; onClose:()=>void; children:ReactNode; footer:ReactNode; wide?:boolean}) {
  useEffect(()=>{ const k = (e:KeyboardEvent)=>{ if (e.key==='Escape') onClose(); }; window.addEventListener('keydown',k); return ()=>window.removeEventListener('keydown',k); },[onClose]);
  return <div className="modalBack" onClick={onClose}><div className={'moveDialog facDialog'+(wide?' wide':'')} role="dialog" aria-modal="true" aria-label={title} onClick={e=>e.stopPropagation()}>
    <header><div><h3>{title}</h3>{detail && <small className="muted">{detail}</small>}</div><button className="iconBtn" aria-label="ปิด" onClick={onClose}><X size={18}/></button></header>
    <div className="facDialogBody">{children}</div><footer>{footer}</footer></div></div>;
}

function ImpactDialog({impact,data,onClose,onPublish,onShow}:{impact:Impact|null; data:Data; onClose:()=>void; onPublish:(note:string)=>Promise<boolean>; onShow:(id:string)=>void}) {
  // A room / counter by the name people read (the draft's, or the published one's for something removed).
  const pub = facility();
  const label = (c:Change) => { if (c.kind!=='points') return c.name; const p = data.points.find(x=>x.id===c.id) ?? pub.points.find(x=>x.id===c.id), g = p && (data.groups.find(x=>x.id===p.groupId) ?? pub.groups.find(x=>x.id===p.groupId)); return p ? pointText(g,p) : c.name; };
  const [note,setNote] = useState(''), [busy,setBusy] = useState(false);
  const errors = impact?.issues.filter(i=>i.level==='error') ?? [], warnings = impact?.issues.filter(i=>i.level==='warning') ?? [];
  const byKind = new Map<string,Change[]>(); for (const c of impact?.changes ?? []) byKind.set(c.kind,[...(byKind.get(c.kind) ?? []),c]);
  const where = (c:Change) => c.kind==='points' ? (()=>{ const p = data.points.find(x=>x.id===c.id) ?? pub.points.find(x=>x.id===c.id), g = p && (data.groups.find(x=>x.id===p.groupId) ?? pub.groups.find(x=>x.id===p.groupId)); return g ? ` · ${g.name}` : ''; })() : '';
  return <Dialog wide title="ผลกระทบก่อนเผยแพร่" detail="เผยแพร่แล้วทุกหน้าจอ (แผนที่ คิว จอทีวี จอง/นัด ตัวจำลอง) ใช้ผังใหม่ทันที · ย้อนเวอร์ชันได้จากประวัติ" onClose={onClose}
    footer={<><label className="facNoteField"><span>บันทึกสั้น ๆ (ไม่บังคับ)</span><input value={note} onChange={e=>setNote(e.target.value)} maxLength={200} placeholder="เช่น เปิดคลินิกโรคไต ชั้น 4"/></label>
      <button className="btn ghost" onClick={onClose}>กลับไปแก้</button>
      <button className="btn" disabled={!impact || errors.length>0 || !impact.changes.length || busy} onClick={async ()=>{ setBusy(true); await onPublish(note); setBusy(false); }}>{busy ? 'กำลังเผยแพร่…' : 'เผยแพร่'}</button></>}>
    {!impact ? <p className="muted">กำลังตรวจร่าง…</p> : <>
      {errors.length>0 && <div className="facBlock bad"><b>ต้องแก้ก่อนเผยแพร่ ({errors.length})</b><ul>{errors.map((i,k)=><li key={k}>{i.message}{i.at && <button className="linkBtn dark" onClick={()=>onShow(i.at!)}>ไปแก้</button>}</li>)}</ul></div>}
      {warnings.length>0 && <div className="facBlock warn"><b>ควรรู้ ({warnings.length})</b><ul>{warnings.map((i,k)=><li key={k}>{i.message}{i.at && <button className="linkBtn dark" onClick={()=>onShow(i.at!)}>ดู</button>}</li>)}</ul></div>}
      <div className="facBlock"><b>สิ่งที่จะเปลี่ยน ({impact.changes.length})</b>
        {[...byKind].map(([k,list])=><div key={k} className="facChanges"><h5>{KIND_TEXT[k] ?? k}</h5><ul>{list.slice(0,60).map(c=><li key={c.id}><em className={'chg '+c.change}>{CHANGE_TEXT[c.change]}</em> {label(c)}<small className="muted">{where(c)}</small></li>)}
          {list.length>60 && <li className="muted">และอีก {list.length-60} รายการ</li>}</ul></div>)}
        {!impact.changes.length && <p className="muted">ร่างนี้เหมือนผังที่เผยแพร่อยู่</p>}</div></>}
  </Dialog>;
}

function HistoryDialog({api,current,canRollback,onClose,onDone}:{api:Api; current:number; canRollback:boolean; onClose:()=>void; onDone:(t:string)=>void}) {
  const [list,setList] = useState<Version[]|null>(null), [confirm,setConfirm] = useState<Confirm|null>(null);
  const load = useCallback(()=>{ void api('facility:versions',{}).then(r=>setList(((r as unknown as {versions?:Version[]}).versions) ?? [])); },[api]);
  useEffect(load,[load]);
  const total = (s:Version['summary']) => Object.values(s).reduce((n,x)=>n+x.added+x.changed+x.removed,0);
  return <Dialog title="ประวัติการเผยแพร่ผัง" detail="ทุกเวอร์ชันเก็บไว้ทั้งชุด · ย้อนกลับ = เผยแพร่เวอร์ชันเก่าอีกครั้งเป็นเวอร์ชันใหม่" onClose={onClose} footer={<button className="btn ghost" onClick={onClose}>ปิด</button>}>
    {!list ? <p className="muted">กำลังโหลด…</p> : <ul className="facHistory">{list.map(v=><li key={v.version} className={v.version===current?'cur':''}>
      <b>เวอร์ชัน {v.version}</b><span>{SOURCE_TEXT[v.source]}{v.note ? ` · ${v.note}` : ''}</span><small className="muted">{fmtTime(v.publishedAt)} · {v.publishedBy==='system' ? 'ระบบ' : v.publishedByName ?? v.publishedBy} · {total(v.summary)} การเปลี่ยน</small>
      {v.version===current ? <em className="tagNew">ใช้อยู่</em> : canRollback && <button className="btn ghost sm" onClick={()=>setConfirm({title:`ย้อนกลับไปเวอร์ชัน ${v.version}`,detail:'เผยแพร่ผังของเวอร์ชันนั้นอีกครั้งเป็นเวอร์ชันใหม่',
        facts:['ทุกหน้าจอเปลี่ยนตามทันที','ระบบตรวจการอ้างอิงเหมือนการเผยแพร่ปกติ'],action:'ย้อนกลับ',run:async ()=>{ const r = await api('facility:rollback',{version:v.version});
          if (r.ok) { onDone(`ย้อนกลับไปเวอร์ชัน ${v.version} แล้ว (เผยแพร่เป็นเวอร์ชัน ${(r as {version?:number}).version})`); load(); } else onDone(r.reason ?? 'ย้อนกลับไม่สำเร็จ'); }})}><History size={14}/> ย้อนกลับ</button>}
    </li>)}</ul>}
    {confirm && <ConfirmDialog confirm={confirm} onClose={()=>setConfirm(null)}/>}
  </Dialog>;
}

type Template = 'clinic'|'service'|'ward'|'other';
const TEMPLATES:[Template,string,string][] = [['clinic','คลินิกผู้ป่วยนอก','ซักประวัติ (ช่องบริการ) + ห้องตรวจ · รับหน้างาน จอง นัด'],['service','จุดบริการร่วม','ช่องบริการที่ทุกแผนกใช้ เช่น ห้องยา การเงิน เจาะเลือด'],
  ['ward','หอผู้ป่วย','ห้องพัก + เตียง'],['other','หน่วยงานอื่น','ห้อง/สำนักงาน ไม่มีคิว']];
function AddDeptDialog({data,onClose,onAdd}:{data:Data; onClose:()=>void; onAdd:(fn:(d:Data)=>string)=>void}) {
  const [t,setT] = useState<Template>('clinic'), [name,setName] = useState(''), [floor,setFloor] = useState(floorOptions(data)[0]?.value ?? '');
  const [a,setA] = useState(2), [b,setB] = useState(2), [step,setStep] = useState<StepKind>('pharmacy'), [code,setCode] = useState('');
  const taken = data.departments.some(x=>x.name.trim()===name.trim());
  const ok = name.trim() && !taken && floor;
  const add = () => onAdd(d=>{
    const id = newId(d,'d'), n = name.trim(), letter = t==='clinic' ? nextLetter(d) : undefined;
    const dept:FDepartment = {id,name:n,type:t==='clinic' ? 'clinic' : t==='service' ? 'service' : t==='ward' ? 'ward' : 'support',...(letter ? {queuePrefix:letter} : {}),
      features:{booking:t==='clinic',appointments:t==='clinic',walkIn:t==='clinic'},active:true};
    d.departments.push(dept);
    const add = (g:Partial<FGroup>, count:number, firstCode?:number) => { const grp = addGroupTo(d,id,floor,g,0); addPointsTo(d,grp,count,firstCode); return grp; };
    if (t==='clinic') { const s = add({name:`ซักประวัติ${n}`,pointKind:'counter',pointNoun:'ช่องบริการ',steps:['screening'],minOpen:1},a);
      add({name:`ห้องตรวจ${n}`,pointKind:'room',pointNoun:'ห้องตรวจ',steps:['exam','followup'],minOpen:1},b,code ? Number(code) : undefined); dept.firstGroupId = s.id; }
    else if (t==='service') add({name:`${stepText[step].serve} · ${n}`,pointKind:step==='xray' ? 'room' : 'counter',pointNoun:step==='xray' ? 'ห้อง' : 'ช่องบริการ',steps:[step],serves:'all',minOpen:1},a);
    else if (t==='ward') { const rooms = add({name:`ห้อง ${n}`,pointKind:'room',pointNoun:'ห้องพัก',steps:[]},a,code ? Number(code) : undefined), beds = add({name:`เตียง ${n}`,pointKind:'bed',pointNoun:'เตียง',steps:['ward']},0);
      const rp = d.points.filter(p=>p.groupId===rooms.id); for (let i=0;i<b;i++) d.points.push({id:newId(d,'p'),groupId:beds.id,number:i+1,...(rp.length ? {inRoomId:rp[Math.floor(i/2)%rp.length].id} : {}),active:true}); }
    else add({name:`ห้อง ${n}`,pointKind:'room',pointNoun:'ห้อง',steps:[]},a,code ? Number(code) : undefined);
    return id;
  });
  return <Dialog title="เพิ่มแผนก / หน่วยงาน" detail="เลือกแม่แบบ ระบบสร้างกลุ่มบริการและห้อง/ช่องให้ แก้ต่อได้ทุกอย่างหลังเพิ่ม" onClose={onClose}
    footer={<><span className="muted">เพิ่มลงร่าง · มีผลเมื่อเผยแพร่</span><button className="btn ghost" onClick={onClose}>ยกเลิก</button><button className="btn" disabled={!ok} onClick={add}><Plus size={15}/> เพิ่ม</button></>}>
    <div className="facTemplates" role="radiogroup">{TEMPLATES.map(([id,title,sub])=><button key={id} role="radio" aria-checked={t===id} className={t===id?'on':''} onClick={()=>setT(id)}><b>{title}</b><small>{sub}</small></button>)}</div>
    <div className="facFields">
      <label className="wide"><span>ชื่อ</span><input value={name} onChange={e=>setName(e.target.value)} placeholder={t==='clinic' ? 'เช่น คลินิกโรคไต' : t==='service' ? 'เช่น ห้องยา ชั้น 2' : t==='ward' ? 'เช่น หอผู้ป่วยศัลยกรรมกระดูก' : 'เช่น งานเวชระเบียน'} maxLength={60} autoFocus/>{taken && <em className="facErr">มีแผนกชื่อนี้แล้ว</em>}</label>
      <label className="wide"><span>อยู่ที่</span><Select value={floor} onChange={setFloor} options={floorOptions(data)} aria-label="ชั้น"/></label>
      {t==='service' && <label><span>ให้บริการ</span><Select value={step} onChange={setStep} options={(['registration','pharmacy','finance','lab','xray'] as StepKind[]).map(s=>({value:s,label:stepText[s].serve}))} aria-label="ขั้นตอน"/></label>}
      <label><span>{t==='clinic' ? 'ช่องซักประวัติ' : t==='service' ? 'จำนวนช่อง' : t==='ward' ? 'ห้องพัก' : 'จำนวนห้อง'}</span><input type="number" min={1} max={30} value={a} onChange={e=>setA(Math.max(1,Math.min(30,Number(e.target.value)||1)))}/></label>
      {(t==='clinic' || t==='ward') && <label><span>{t==='clinic' ? 'ห้องตรวจ' : 'เตียง'}</span><input type="number" min={1} max={60} value={b} onChange={e=>setB(Math.max(1,Math.min(60,Number(e.target.value)||1)))}/></label>}
      {t!=='service' && <label><span>เลขห้องเริ่ม (ไม่บังคับ)</span><input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,''))} placeholder="เช่น 401" maxLength={6}/></label>}
    </div>
    {t==='clinic' && <p className="muted">อักษรคิว: {nextLetter(data) ?? 'ไม่มีอักษรว่าง (ตั้งเองภายหลัง)'}</p>}
  </Dialog>;
}
// Helpers the dialogs share with the pane (same rules: new ids, numbers after the last one).
function addGroupTo(d:Data, deptId:string, floorId:string|null, g:Partial<FGroup>, n:number):FGroup {
  const group:FGroup = {id:newId(d,'g'),departmentId:deptId,name:g.name ?? 'กลุ่มบริการใหม่',floorId,pointKind:g.pointKind ?? 'counter',pointNoun:g.pointNoun ?? 'ช่องบริการ',
    steps:g.steps ?? [],serves:g.serves ?? 'department',minOpen:g.minOpen ?? 0,...(g.options ? {options:g.options} : {}),active:true};
  d.groups.push(group); addPointsTo(d,group,n);
  return group;
}
function addPointsTo(d:Data, g:FGroup, n:number, firstCode?:number) {
  const max = Math.max(0,...d.points.filter(p=>p.groupId===g.id).map(p=>p.number));
  for (let i=0;i<n;i++) d.points.push({id:newId(d,'p'),groupId:g.id,number:max+i+1,...(firstCode!==undefined ? {roomCode:String(firstCode+i)} : {}),active:true});
}

function AddBuildingDialog({data,onClose,onAdd}:{data:Data; onClose:()=>void; onAdd:(fn:(d:Data)=>string)=>void}) {
  const [name,setName] = useState(''), [short,setShort] = useState(''), [kind,setKind] = useState<BuildingKind>('opd'), [floors,setFloors] = useState(3);
  const ok = name.trim().length>0;
  const add = () => onAdd(d=>{
    // Placed in free ground to the east of the campus (drag-to-place comes later); the size suits a small block.
    const live = d.buildings.filter(b=>!b.retiredAt), right = Math.max(0,...live.map(b=>b.map.x+b.map.width/2)), width = 10, depth = 7;
    const id = newId(d,'b');
    d.buildings.push({id,name:name.trim(),shortName:short.trim() || name.trim(),kind,map:{x:Math.round(right+width/2+4),z:0,width,depth,color:'#e8eef3'},active:true});
    for (let l=1;l<=floors;l++) d.floors.push({id:newId(d,'f'),buildingId:id,level:l,name:`ชั้น ${l}`,description:'',active:true});
    return id;
  });
  return <Dialog title="เพิ่มอาคาร" detail="ระบบวางอาคารในที่ว่างด้านข้าง ปรับตำแหน่งและขนาดได้ในหน้าอาคาร" onClose={onClose}
    footer={<><span className="muted">เพิ่มลงร่าง · มีผลเมื่อเผยแพร่</span><button className="btn ghost" onClick={onClose}>ยกเลิก</button><button className="btn" disabled={!ok} onClick={add}><Plus size={15}/> เพิ่ม</button></>}>
    <div className="facFields">
      <label className="wide"><span>ชื่ออาคาร</span><input value={name} onChange={e=>setName(e.target.value)} placeholder="เช่น อาคารเฉลิมพระเกียรติ" maxLength={60} autoFocus/></label>
      <label><span>ชื่อย่อ</span><input value={short} onChange={e=>setShort(e.target.value)} placeholder="เช่น อาคาร 3" maxLength={60}/></label>
      <label><span>ชนิด</span><Select value={kind} onChange={setKind} options={BUILDING_KINDS.map(([value,label])=>({value,label}))} aria-label="ชนิดอาคาร"/></label>
      <label><span>จำนวนชั้น</span><input type="number" min={1} max={30} value={floors} onChange={e=>setFloors(Math.max(1,Math.min(30,Number(e.target.value)||1)))}/></label>
    </div>
  </Dialog>;
}
