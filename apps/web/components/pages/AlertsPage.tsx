'use client';
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, OctagonAlert, RotateCcw, Send } from 'lucide-react';
import { defaultRules, type Alert, type AlertRule } from '../../lib/ops';
import { fmtMin } from '../../lib/patients';
import { PageGuide } from './PageGuide';

export type Ack = {minute:number; at:string};
const severityLabel = {critical:'วิกฤต',warning:'เฝ้าระวัง'};

export default function AlertsPage({alerts,rules,onRules,acks,onAck,minute,timeNote,onOpenPatient}:{
 alerts:Alert[];rules:AlertRule[];onRules:(r:AlertRule[])=>void;acks:Record<string,Ack>;onAck:(id:string)=>void;minute:number;timeNote:string;onOpenPatient:(id:string)=>void;
}) {
 const [showAcked,setShowAcked] = useState(false);
 const open = alerts.filter(a=>!acks[a.id]), done = alerts.filter(a=>acks[a.id]);
 const setRule = (id:string, patch:Partial<AlertRule>) => onRules(rules.map(r=>r.id===id?{...r,...patch}:r));
 const card = (a:Alert, acked?:Ack) => { const Icon = a.severity==='critical'?OctagonAlert:AlertTriangle;
  return <li key={a.id} className={`alertCard ${a.severity}${acked?' acked':''}`}>
   <span className="sevIcon"><Icon size={18}/></span>
   <div className="alertBody">
    <div className="alertTitle"><span className={'tag '+a.severity}>{severityLabel[a.severity]}</span><b>{a.title}</b></div>
    <p>{a.detail}</p>
    <small className="route"><Send size={12}/> ส่งถึง: {a.route} <em>(จำลอง · ยังไม่ได้ส่งจริง)</em></small>
    {acked && <small className="muted"> · รับทราบแล้ว {fmtMin(acked.minute)}</small>}
   </div>
   <div className="alertActions">
    {a.patientIds.length===1 && <button className="btn ghost" onClick={()=>onOpenPatient(a.patientIds[0])}>ดูบนแผนที่</button>}
    {a.patientIds.length>1 && <button className="btn ghost" onClick={()=>onOpenPatient(a.patientIds[0])}>ดูคนที่รอนานสุด</button>}
    {!acked && <button className="btn" onClick={()=>onAck(a.id)}><CheckCircle2 size={14}/> รับทราบ</button>}
   </div>
  </li>; };
 return <div className="page">
  <div className="pageHead"><h2>การแจ้งเตือน</h2><span className="pageTime">{timeNote}</span></div>
  <PageGuide id="การแจ้งเตือน"/>
  <div className="pageCols">
   <section className="panel">
    <div className="panelHead"><h3>ต้องดำเนินการ ({open.length})</h3><small className="panelMeta">รวมเป็นรายการต่อจุด ไม่เตือนซ้ำรายคน</small></div>
    {open.length ? <ul className="alertList">{open.map(a=>card(a))}</ul> : <p className="emptyState"><CheckCircle2 size={20}/> ไม่มีรายการที่ต้องดำเนินการ ณ เวลานี้</p>}
    {done.length>0 && <button className="linkBtn dark" onClick={()=>setShowAcked(s=>!s)}>{showAcked?'ซ่อน':'แสดง'}รายการที่รับทราบแล้ว ({done.length})</button>}
    {showAcked && <ul className="alertList">{done.map(a=>card(a,acks[a.id]))}</ul>}
   </section>
   <section className="panel">
    <div className="panelHead"><h3>กฎการแจ้งเตือน</h3>
     <button className="linkBtn dark" onClick={()=>onRules(defaultRules)}><RotateCcw size={12}/> ค่าเริ่มต้น</button></div>
    <ul className="ruleList">{rules.map(r=><li key={r.id}>
     <label className="ruleToggle"><input type="checkbox" checked={r.enabled} onChange={e=>setRule(r.id,{enabled:e.target.checked})}/>{r.name}</label>
     {r.threshold!==undefined && <label className="ruleNum">เกิน <input type="number" min={1} value={r.threshold} disabled={!r.enabled}
      onChange={e=>setRule(r.id,{threshold:Math.max(1,Number(e.target.value)||1)})}/> {r.unit}</label>}
     <label className="ruleRoute">ส่งถึง <input value={r.route} disabled={!r.enabled} onChange={e=>setRule(r.id,{route:e.target.value})}/></label>
    </li>)}</ul>
    <p className="note">กฎและการกดรับทราบบันทึกไว้ในเบราว์เซอร์นี้เท่านั้น · การส่งจริง (เช่น LINE กลุ่มหัวหน้าเวร) ต้องต่อระบบส่งข้อความและระบบผู้ใช้ก่อน</p>
   </section>
  </div>
 </div>;
}
