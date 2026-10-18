'use client';
import { useEffect, useMemo, useState } from 'react';
import { clinicOpen, fmtMin, opdClinics, patientAt, type PatientState } from '../../lib/patients';
import { dutyLabel, isOff, roomDutyAt } from '../../lib/scene-data';
import { useDemoClock } from '../../lib/use-demo-clock';
import { allStations, applyQueueEvents, basePatients, isLive, pausedUntil, stationById, useQueueEvents, worldKey } from '../../lib/queue';
import { buildingShort } from '../../lib/facility';
import { counterZones, deptScreen, nowStates, screenData, screenDepts, stationScreen, type ScreenData, type StationScreen } from '../../lib/queue-screen';

// Public queue screens. Queue numbers only — no names, no HN — because they hang in public areas.
//  /tv?floor=2..4        one OPD floor: every clinic, its rooms and next numbers
//  /tv?floor=1           OPD floor 1: registration, pharmacy and cashier
//  /tv?dept=<name>       the waiting-area screen of one department or counter group (same as the 3D screen)
//  /tv?station=<id>      the door screen of one exam room or counter
//  /tv                   index of all screens
type Mode = {kind:'index'} | {kind:'floor'; level:number} | {kind:'dept'; name:string} | {kind:'station'; id:string};
export default function TvPage() {
  const { events, settings, visits } = useQueueEvents(); // staff calls appear here the moment they are made
  const [mode,setMode] = useState<Mode|null>(null);
  useEffect(()=>{ const q = new URLSearchParams(window.location.search), f = Number(q.get('floor'));
    setMode(q.get('station') ? {kind:'station',id:q.get('station')!} : q.get('dept') ? {kind:'dept',name:q.get('dept')!} : f>=1 && f<=4 ? {kind:'floor',level:f} : {kind:'index'}); },[]);
  // Door and department screens tick every 2 s so a call shows straight away; the floor board every 10 s.
  const minute = useDemoClock(mode?.kind==='station' || mode?.kind==='dept' ? 2000 : 10000,settings.demoOffset ?? 0);
  const level = mode?.kind==='floor' ? mode.level : 2;
  const world = worldKey(settings);
  const liveData = isLive(settings);
  const base = useMemo(()=>basePatients(settings,visits,events),[world,liveData,liveData?visits:null,liveData?events:null]); // eslint-disable-line react-hooks/exhaustive-deps
  const patients = useMemo(()=>applyQueueEvents(base,events),[base,events]);
  const clinics = useMemo(()=>opdClinics().filter(c=>c.level===level),[level,base]); // base changes with the layout
  if (minute===null || !mode) return <main className="tv"/>;
  const m = Math.floor(minute);
  if (mode.kind==='index') return <TvIndex/>;
  if (mode.kind==='station') { const d = stationScreen(mode.id,patients,nowStates(patients,m),m,events);
    return d ? <StationTv d={d} m={m}/> : <TvMissing text={`ไม่พบจุดบริการ "${mode.id}" หรือถูกปิดใช้งานในหน้าตั้งค่า`}/>; }
  if (mode.kind==='dept') { const d = deptScreen(mode.name,nowStates(patients,m),m);
    return d ? <DeptTv d={d} m={m}/> : <TvMissing text={`ไม่พบแผนก "${mode.name}"`}/>; }
  // The floor with the shared counters (registration, pharmacy, cashier): one panel per counter group.
  const zones = counterZones().filter(z=>z.level===level);
  if (zones.length && !clinics.length) { const now1 = nowStates(patients,m);
    return <main className="tv"><header className="tvHead"><div><h1>{buildingShort(zones[0].buildingId)} ชั้น {level}</h1><p>{zones.map(z=>z.title).join(' · ')} · ไม่แสดงชื่อเพื่อความเป็นส่วนตัว</p></div><strong className="tvClock">{fmtMin(m)}</strong></header>
      <div className="tvGrid">{zones.map(z=>{ const d = screenData(z.level,z.zone,now1,m,z.buildingId); return d ? <DeptPanel key={z.zone} d={d}/> : null; })}</div></main>; }
  const now = patients.map(p=>patientAt(p,m)).filter((s):s is PatientState=>!!s && s.p.flow==='opd');
  const isExam = (s:PatientState) => s.step.kind==='exam' || s.step.kind==='followup';
  const missed = now.filter(s=>s.status==='missed' && s.p.deptWhere.endsWith(`OPD ชั้น ${level}`));
  return <main className="tv">
    <header className="tvHead"><div><h1>OPD ชั้น {level}</h1><p>กรุณารอเรียกตามหมายเลขคิว · ไม่แสดงชื่อเพื่อความเป็นส่วนตัว</p></div><strong className="tvClock">{fmtMin(m)}</strong></header>
    <div className="tvGrid">{clinics.map(c=>{
      const waiting = now.filter(s=>isExam(s) && m<s.step.called && s.status!=='calling' && s.status!=='held' && s.status!=='missed' && s.p.deptWhere.startsWith(c.dept)).sort((a,b)=>a.step.start-b.step.start);
      if (!clinicOpen(c)) return <section key={c.key} className="tvClinic closed"><h2><span className="tvLetter">{c.letter}</span>{c.dept}</h2><p>งดให้บริการวันนี้</p></section>;
      return <section key={c.key} className="tvClinic">
        <h2><span className="tvLetter">{c.letter}</span>{c.dept}</h2>
        {c.rooms.map(room=>{
          if (isOff(`room:${room.id}`)) return <div key={room.id} className="tvRoom off"><span>ห้อง {room.number}</span><em>ปิด</em></div>;
          const serving = now.find(s=>isExam(s) && m>=s.step.called && s.step.place.where.includes(`ห้องตรวจ ${room.number}`));
          const calling = now.find(s=>s.status==='calling' && s.step.manual===`room:${room.id}`);
          const duty = roomDutyAt(room.id,m/60), st = stationById(`room:${room.id}`), paused = st && pausedUntil(st,events,m)!==undefined;
          return <div key={room.id} className={'tvRoom'+(calling?' calling':'')}><span>ห้อง {room.number}</span>
            {calling ? <b className="tvCall">เชิญ {calling.p.queue}</b> : serving ? <b>{serving.p.queue}</b> : <em>{paused ? 'พักชั่วคราว' : duty && duty.status!=='active' ? dutyLabel[duty.status] : '—'}</em>}</div>;
        })}
        <div className="tvNext"><span>คิวถัดไป</span>{waiting.slice(0,8).map(s=><b key={s.p.id}>{s.p.queue}</b>)}{!waiting.length && <em>ไม่มีคิวรอ</em>}</div>
        <small>รอ {waiting.length} คน</small>
      </section>;
    })}</div>
    {missed.length>0 && <footer className="tvMissed">เรียกแล้วยังไม่พบ: {missed.map(s=><b key={s.p.id}>{s.p.queue}</b>)} · กรุณาติดต่อจุดซักประวัติ</footer>}
  </main>;
}

const isCalling = (d:ScreenData) => d.rows.some(r=>r.calling);
// One department / counter group: called numbers take over the panel; otherwise who is inside and who is next.
function DeptPanel({d,big}:{d:ScreenData;big?:boolean}) {
  const calls = d.rows.filter(r=>r.calling).slice(0,2);
  return <section className={'tvPanel'+(big?' big':'')+(calls.length?' calling':'')+(d.closed?' closed':'')}>
    <h2>{d.letter && <span className="tvLetter">{d.letter}</span>}{d.title}</h2>
    {d.closed ? <p className="tvPanelEmpty">งดให้บริการวันนี้</p>
     : calls.length ? <div className={'tvCalls n'+calls.length}>{calls.map(r=><div key={r.queue}><small>เชิญหมายเลข</small><b>{r.queue}</b><span>→ {r.label}</span></div>)}</div>
     : <div className="tvRows">{d.rows.length ? d.rows.map(r=><div key={r.queue}><b>{r.queue}</b><span>{r.label}</span></div>) : <p className="tvPanelEmpty">ยังไม่มีการเรียกคิว</p>}</div>}
    {!d.closed && <div className="tvNext"><span>ถัดไป</span>{d.next.map(q=><b key={q}>{q}</b>)}{!d.next.length && <em>ไม่มีคิวรอ</em>}</div>}
  </section>;
}
function DeptTv({d,m}:{d:ScreenData;m:number}) {
  return <main className={'tv tvSolo'+(isCalling(d)?' calling':'')}>
    <header className="tvHead"><div><h1>{d.letter && <span className="tvLetter">{d.letter}</span>} {d.title}</h1><p>กรุณารอเรียกตามหมายเลขคิว · ไม่แสดงชื่อเพื่อความเป็นส่วนตัว</p></div><strong className="tvClock">{fmtMin(m)}</strong></header>
    <DeptPanel d={d} big/>
  </main>;
}
// Door screen: one huge number (called = flashing), and the next few.
function StationTv({d,m}:{d:StationScreen;m:number}) {
  return <main className={'tv tvDoor'+(d.calling?' calling':'')}>
    <header className="tvHead"><div><h1>{d.letter && <span className="tvLetter">{d.letter}</span>} {d.title}</h1><p>{d.sub}</p></div><strong className="tvClock">{fmtMin(m)}</strong></header>
    <div className="tvDoorMain">
      {d.calling ? <><small>เชิญหมายเลข</small><b>{d.calling}</b><span>เข้ารับบริการได้เลย</span></>
       : d.serving ? <><small>กำลังให้บริการ</small><b>{d.serving}</b></>
       : <><small>{d.note ?? 'ว่าง'}</small><b className="idle">—</b></>}
    </div>
    <div className="tvNext"><span>คิวถัดไป</span>{d.next.map(q=><b key={q}>{q}</b>)}{!d.next.length && <em>ไม่มีคิวรอ</em>}</div>
  </main>;
}
function TvMissing({text}:{text:string}) {
  return <main className="tv"><header className="tvHead"><div><h1>ไม่พบจอนี้</h1><p>{text}</p></div></header><a className="tvBack" href="/tv">ดูรายการจอทั้งหมด</a></main>;
}
// Index: every screen URL, to set up a display (open the link on the TV's browser).
function TvIndex() {
  const depts = screenDepts(), stations = allStations();
  const groups = [...new Set(stations.map(s=>s.section))];
  return <main className="tv tvIndex">
    <header className="tvHead"><div><h1>จอแสดงคิว</h1><p>เปิดลิงก์บนเบราว์เซอร์ของจอทีวีแต่ละจุด</p></div></header>
    <section><h2>จอรวมรายชั้น</h2><div className="tvLinkGrid">{[1,2,3,4].map(f=><a key={f} href={`/tv?floor=${f}`}><b>OPD ชั้น {f}</b><small>{f===1?'ลงทะเบียน · ห้องยา · การเงิน':'ทุกแผนกบนชั้น'}</small></a>)}</div></section>
    <section><h2>จอพื้นที่รอรายแผนก</h2><div className="tvLinkGrid">{depts.map(d=><a key={d.name} href={`/tv?dept=${encodeURIComponent(d.name)}`}><b>{d.letter && <span className="tvLetter sm">{d.letter}</span>}{d.name}</b><small>{d.where}</small></a>)}</div></section>
    <section><h2>จอหน้าห้อง / หน้าช่อง</h2>{groups.map(g=><div key={g} className="tvIdxGroup"><h3>{g}</h3><div className="tvLinkGrid sm">{stations.filter(s=>s.section===g).map(s=><a key={s.id} href={`/tv?station=${encodeURIComponent(s.id)}`}><b>{s.label}</b></a>)}</div></div>)}</section>
  </main>;
}
