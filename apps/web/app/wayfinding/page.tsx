'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChevronLeft, MapPin, Navigation, Search } from 'lucide-react';
import FloorPlanSvg from '../../components/FloorPlanSvg';
import { buildingName, directions, fetchDestination, fetchDestinations, whereText, type Destination } from '../../lib/wayfinding';
import { useFacility } from '../../lib/use-facility';

// What a QR sign in the hospital opens (no sign-in, nothing personal):
//   /wayfinding?at=CODE  "you are here" + where would you like to go
//   /wayfinding?to=CODE  the way to a place (from ?at= when both are given, else from the main entrance)
// Big text, high contrast, a floor plan of the destination floor and step-by-step directions in plain Thai.
export default function WayfindingPage() { return <Suspense fallback={<main className="liff"><p className="liffWait">กำลังโหลด…</p></main>}><Wayfinding/></Suspense>; }

function Wayfinding() {
 useFacility(true); // the hospital's buildings and floors for the plan
 const params = useSearchParams();
 const [list,setList] = useState<Destination[]|null>(null);
 const [error,setError] = useState('');
 const [here,setHere] = useState<Destination|undefined>();
 const [moved,setMoved] = useState('');
 const [to,setTo] = useState<Destination|undefined>();
 const [q,setQ] = useState('');
 useEffect(()=>{ void (async ()=>{
  const r = await fetchDestinations();
  if (!r.ok) { setError(r.code==='FEATURE_DISABLED' ? 'ระบบนำทางยังไม่เปิดใช้งาน · สอบถามจุดประชาสัมพันธ์' : r.reason); return; }
  setList(r.destinations);
  // A retired code on an old sign leads to its replacement, and says so.
  const resolve = async (code:string|null) => { if (!code) return undefined;
   const d = await fetchDestination(code);
   if (!d.ok) return undefined;
   if (d.destination) return d.destination;
   if (d.replacedBy) { setMoved(`จุดนี้ย้ายไปแล้ว — แสดงทางไป ${d.replacedBy.nameTh} แทน`); return d.replacedBy; }
   setMoved('จุดนี้เลิกใช้แล้ว กรุณาสอบถามจุดประชาสัมพันธ์'); return undefined; };
  setHere(await resolve(params.get('at'))); setTo(await resolve(params.get('to')));
 })(); },[params]);
 const pick = (d:Destination|undefined) => { setTo(d); const u = new URL(window.location.href); if (d) u.searchParams.set('to',d.code); else u.searchParams.delete('to'); window.history.replaceState(null,'',u); window.scrollTo(0,0); };
 const shown = useMemo(()=>(list ?? []).filter(d=>d.code!==here?.code && (!q.trim() || d.nameTh.includes(q.trim()) || buildingName(d.buildingId).includes(q.trim()))),[list,here,q]);
 const groups = useMemo(()=>{ const m = new Map<string,Destination[]>(); shown.forEach(d=>m.set(whereText(d),[...(m.get(whereText(d)) ?? []),d])); return [...m.entries()]; },[shown]);
 return <main className="liff wayf">
  <header className="liffHead"><span className="liffLogo"><Navigation size={24}/></span><div><b>นำทางในโรงพยาบาล</b><small>โรงพยาบาลตัวอย่าง</small></div></header>
  {error && <section className="liffCard"><p>{error}</p></section>}
  {moved && <section className="liffCard"><p className="liffPending">{moved}</p></section>}
  {here && <section className="liffCard wayHere"><small>คุณอยู่ที่</small><h1><MapPin size={26}/> {here.nameTh}</h1><p>{whereText(here)}</p></section>}
  {to ? <section className="liffCard">
   {list && <button className="liffBack" onClick={()=>pick(undefined)}><ChevronLeft size={22}/> เลือกที่อื่น</button>}
   <small className="liffNote">ทางไป</small><h1>{to.nameTh}</h1><p className="wayWhere">{whereText(to)}</p>
   <ol className="waySteps">{directions(here,to).map((s,i)=><li key={i}>{s}</li>)}</ol>
   <FloorPlanSvg buildingId={to.buildingId} level={to.level} highlightZone={to.zoneIndex} highlightRoom={to.roomId}
    showLift={!here || here.buildingId!==to.buildingId || here.level!==to.level} height={210}/>
   <small className="liffNote">ผัง{whereText(to)} · ช่องที่ไฮไลต์คือ {to.nameTh}{to.descriptionTh ? ` · ${to.descriptionTh}` : ''}</small>
   <small className="liffNote">ต้องการรถเข็นหรือผู้ช่วย? แจ้งเจ้าหน้าที่ที่จุดประชาสัมพันธ์ได้ทุกชั้น</small>
  </section> : list && <>
   <h2 className="wayAsk">{here ? 'จะไปที่ไหน?' : 'ค้นหาจุดบริการ'}</h2>
   <label className="liffSearch"><Search size={20}/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="เช่น ห้องยา การเงิน ตา" aria-label="ค้นหาจุดหมาย"/></label>
   {groups.map(([place,ds])=><section key={place} className="liffCard"><h2><MapPin size={20}/> {place}</h2>
    <div className="liffChoices">{ds.map(d=><button key={d.code} className="liffChoice small" onClick={()=>pick(d)}><b>{d.nameTh}</b><Navigation size={18}/></button>)}</div></section>)}
   {!groups.length && <section className="liffCard"><p>ไม่พบจุดหมายที่ค้นหา · สอบถามจุดประชาสัมพันธ์</p></section>}
  </>}
  {!list && !error && <p className="liffWait">กำลังโหลด…</p>}
 </main>;
}
