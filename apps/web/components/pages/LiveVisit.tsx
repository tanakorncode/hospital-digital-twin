'use client';
import { useEffect, useMemo, useState } from 'react';
import { Ban, CheckCircle2, Forward, UserPlus, X } from 'lucide-react';
import { PriorityTag } from '../PriorityIcon';
import { clinicOpen, opdClinics, stepText, triageLevels, type Patient, type PatientState, type StepKind } from '../../lib/patients';
import { actionKey, priorityKeys, priorityText, type QueueSync, type VisitInput } from '../../lib/queue';

// Real patients (live data mode): taking a patient into the queue, sending them on after a step, and cancelling a
// visit made by mistake. The queue number comes from the server; nothing personal is entered here — no name, no HN.
export type VisitControl = Pick<QueueSync,'enterVisit'|'addVisitStep'|'cancelVisit'>;

// One key per intended action, renewed when what is being sent changes: a tap after "no reply" repeats the same
// request (the server returns the first result), a changed form is a new request.
function useActionKey(payload:unknown) {
 const sig = JSON.stringify(payload);
 const [k,setK] = useState(()=>({sig,key:actionKey()}));
 useEffect(()=>{ if (k.sig!==sig) setK({sig,key:actionKey()}); },[sig,k.sig]);
 return {key:k.sig===sig ? k.key : '', renew:()=>setK({sig,key:actionKey()})};
}

export function EnterVisitButton({visits,minute,disabled,QrButton,patients}:{visits:VisitControl;minute:number;disabled?:boolean;patients:Patient[];
 QrButton:(props:{p:Patient;label?:string})=>React.ReactNode}) {
 const [open,setOpen] = useState(false);
 return <>
  <button className="btn" disabled={disabled} onClick={()=>setOpen(true)}><UserPlus size={15}/> รับผู้ป่วยเข้าคิว</button>
  {open && <EnterVisitDialog visits={visits} minute={minute} patients={patients} QrButton={QrButton} onClose={()=>setOpen(false)}/>}
 </>;
}

function EnterVisitDialog({visits,minute,patients,QrButton,onClose}:{visits:VisitControl;minute:number;patients:Patient[];QrButton:(props:{p:Patient;label?:string})=>React.ReactNode;onClose:()=>void}) {
 const clinics = useMemo(()=>opdClinics().filter(clinicOpen),[]);
 const [flow,setFlow] = useState<'opd'|'er'>('opd');
 const [clinicKey,setClinicKey] = useState(clinics[0]?.key ?? '');
 const [priority,setPriority] = useState<VisitInput['priority']>();
 const [triage,setTriage] = useState<number|undefined>();
 const [hn,setHn] = useState('');
 const [idChecked,setIdChecked] = useState(false);
 // The arrival minute is fixed when the form is opened, so a retry sends exactly the same request.
 const [at] = useState(()=>Math.floor(minute));
 const [busy,setBusy] = useState(false);
 const [error,setError] = useState('');
 const [made,setMade] = useState<{id:string; queue:string}|null>(null);
 const c = clinics.find(x=>x.key===clinicKey);
 const withHn = hn.trim() ? {hn:hn.trim()} : {};
 const input:VisitInput = flow==='opd' ? {flow,clinicKey,dept:c?.dept,prefix:c?.letter,priority,at,...withHn} : {flow,priority,triage,at,...withHn};
 const {key,renew} = useActionKey(input);
 useEffect(()=>{ const k = (e:KeyboardEvent)=>{ if (e.key==='Escape') onClose(); }; window.addEventListener('keydown',k); return ()=>window.removeEventListener('keydown',k); },[onClose]);
 const submit = async () => {
  if (busy || !key || (flow==='opd' && !c) || (!!hn.trim() && !idChecked)) return;
  setBusy(true); setError('');
  const r = await visits.enterVisit(input,key);
  setBusy(false);
  if (r.ok && r.visit) setMade({id:r.visit.id,queue:r.visit.queue}); else setError(r.reason ?? 'รับเข้าคิวไม่สำเร็จ');
 };
 const another = () => { setMade(null); setPriority(undefined); setTriage(undefined); setHn(''); setIdChecked(false); renew(); };
 // The QR dialog works from a patient; the new one is on its way from the server — a stand-in is enough for the link.
 const p = made ? patients.find(x=>x.id===made.id) ?? ({id:made.id,queue:made.queue} as Patient) : undefined;
 return <div className="modalBack" onClick={onClose}>
  <div className="moveDialog visitDialog" role="dialog" aria-modal="true" aria-labelledby="visitTitle" onClick={e=>e.stopPropagation()}>
   <header><div><b id="visitTitle">รับผู้ป่วยเข้าคิว</b><small className="muted">เลขคิวออกจากระบบกลาง · ไม่ต้องกรอกชื่อหรือ HN</small></div>
    <button className="iconBtn" aria-label="ปิด" onClick={onClose}><X size={18}/></button></header>
   {made && p ? <div className="visitMade">
    <CheckCircle2 size={28}/><span>รับเข้าคิวแล้ว</span><b className="mvQueue big">{made.queue}</b>
    <small className="muted">{flow==='opd' ? `${c?.dept} · รอซักประวัติ` : 'ห้องฉุกเฉิน · รอคัดแยก'}</small>
    <div className="qrActs"><QrButton p={p} label="แสดง QR บนบัตรคิว"/><button className="btn" onClick={another}><UserPlus size={14}/> รับคนถัดไป</button></div>
   </div> : <>
    <div className="visitRow"><span>ประเภท</span><div className="segBtns">
     <button className={flow==='opd'?'on':''} aria-pressed={flow==='opd'} onClick={()=>setFlow('opd')}>ผู้ป่วยนอก (OPD)</button>
     <button className={flow==='er'?'on':''} aria-pressed={flow==='er'} onClick={()=>setFlow('er')}>ห้องฉุกเฉิน</button></div></div>
    {flow==='opd' ? <div className="visitRow"><span>คลินิก</span>
     <div className="visitClinics">{clinics.map(x=><button key={x.key} className={x.key===clinicKey?'on':''} aria-pressed={x.key===clinicKey} onClick={()=>setClinicKey(x.key)}>
      <b>{x.letter}</b><span>{x.dept}</span><small>ชั้น {x.level}</small></button>)}</div></div>
     : <div className="visitRow"><span>ระดับคัดแยก <small className="muted">(ถ้าทราบ)</small></span><div className="segBtns">
      {triageLevels.map(t=><button key={t.level} className={triage===t.level?'on':''} aria-pressed={triage===t.level} onClick={()=>setTriage(triage===t.level?undefined:t.level)}>{t.level} · {t.name}</button>)}</div></div>}
    <div className="visitRow"><span>HN <small className="muted">(ไม่บังคับ · ผู้ป่วยที่เชื่อม LINE จะเห็นคิวในมือถือและได้แจ้งเตือน)</small></span>
     <span className="visitHn"><input value={hn} maxLength={20} placeholder="เช่น 65-123456" onChange={e=>{ setHn(e.target.value); setIdChecked(false); }}/>
      {hn.trim() && <label className="lineCheck"><input type="checkbox" checked={idChecked} onChange={e=>setIdChecked(e.target.checked)}/> ตรวจบัตรประชาชนแล้ว</label>}</span></div>
    <div className="visitRow"><span>คิวพิเศษ <small className="muted">(ถ้ามี)</small></span><div className="segBtns">
     {priorityKeys.map(k=><button key={k} className={priority===k?'on':''} aria-pressed={priority===k} onClick={()=>setPriority(priority===k?undefined:k)}>
      <PriorityTag p={{key:k,label:priorityText(k)}}/></button>)}</div></div>
    {error && <p className="loginError" role="alert">{error}</p>}
    <footer><button className="btn ghost" onClick={onClose}>ยกเลิก</button>
     <button className="btn" disabled={busy || (flow==='opd' && !c) || (!!hn.trim() && !idChecked)} onClick={()=>void submit()}>{busy?'กำลังออกเลขคิว…':'ออกเลขคิว'}</button></footer>
   </>}
  </div>
 </div>;
}

// After a step: where the doctor / staff send the patient next (added after the steps already ordered).
const nextOpd:StepKind[] = ['lab','xray','followup','pharmacy','finance'];
const nextEr:StepKind[] = ['lab','xray','pharmacy','finance'];
const cancelReasons = ['รับเข้าคิวผิด','ซ้ำกับคิวอื่น','ผู้ป่วยกลับก่อนรับบริการ'];
export function SendOnBar({s,minute,visits,disabled,onMsg}:{s:PatientState;minute:number;visits:VisitControl;disabled?:boolean;onMsg:(text:string,bad?:boolean)=>void}) {
 const [busy,setBusy] = useState(false);
 const [cancel,setCancel] = useState(false);
 const ordered = s.p.steps.slice(s.index+1).filter(x=>x.kind!=='leave');
 const options = s.p.flow==='er' ? nextEr : nextOpd;
 const label = (k:StepKind) => k==='followup' ? 'ฟังผล / พบแพทย์ซ้ำ' : stepText[k].serve;
 const send = async (kind:StepKind) => {
  if (busy) return;
  setBusy(true);
  const r = await visits.addVisitStep(s.p.id,kind,Math.floor(minute),actionKey());
  setBusy(false);
  onMsg(r.ok ? `ส่ง ${s.p.queue} ต่อ: ${label(kind)}` : r.reason ?? 'ส่งต่อไม่สำเร็จ',!r.ok);
 };
 const doCancel = async (reason:string) => {
  setCancel(false); setBusy(true);
  const r = await visits.cancelVisit(s.p.id,reason);
  setBusy(false);
  onMsg(r.ok ? `ยกเลิกคิว ${s.p.queue} แล้ว (${reason})` : r.reason ?? 'ยกเลิกไม่สำเร็จ',!r.ok);
 };
 return <div className="sendOn">
  <span className="sendOnHead"><Forward size={14}/> ส่งต่อ {ordered.length ? <small>ต่อไป: {ordered.map(x=>label(x.kind)).join(' → ')}</small> : <small>ยังไม่มีขั้นต่อไป · เสร็จแล้วผู้ป่วยกลับบ้าน</small>}</span>
  <span className="sendOnBtns">{options.map(k=><button key={k} disabled={disabled || busy} onClick={()=>void send(k)}>+ {label(k)}</button>)}
   <button className="danger" disabled={disabled || busy} onClick={()=>setCancel(c=>!c)}><Ban size={13}/> ยกเลิกคิว</button></span>
  {cancel && <span className="sendOnBtns"><small className="muted">ยกเลิกเพราะ</small>{cancelReasons.map(r=><button key={r} onClick={()=>void doCancel(r)}>{r}</button>)}</span>}
 </div>;
}
