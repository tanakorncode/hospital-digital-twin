'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { BellRing, ChevronLeft, Clock, Keyboard, ListOrdered, MapPin, Navigation, Search, Users, Volume2, VolumeX } from 'lucide-react';
import FloorPlanSvg from '../FloorPlanSvg';
import { AVATAR_NAME, type AvatarState } from './Avatar';
import { KioskAvatar, avatarUrl } from './KioskAvatar';
import { MyQueue, QueueBoard, QueueFeed } from './QueueViews';
import type { Capabilities, KioskClient, PublicPlace, Reply, Turn } from '../../lib/reception/client';
import { speak, speechAvailable, stopSpeaking } from '../../lib/reception/speech';

// The Digital Reception screen (Reception spec §5): a welcome, six large actions, answers that are always shown as
// text (and read aloud with a local voice when there is one), wayfinding with the floor plan, and a member of staff on
// request. Release A: touch and typing only — no microphone, no LLM. After a short pause the screen returns to the
// welcome and the visitor's session ends, so the next person sees nothing of the previous one.
type View = {kind:'menu'} | {kind:'reply'; reply:Reply} | {kind:'directory'} | {kind:'ask'} | {kind:'help'} | {kind:'queue'} | {kind:'myqueue'};
const IDLE_SECONDS = 90, WARN_SECONDS = 15;
const GREETING = `สวัสดีค่ะ ฉันชื่อ${AVATAR_NAME} ผู้ช่วยต้อนรับของโรงพยาบาล มีอะไรให้ช่วยไหมคะ`;
const SUGGEST = ['ห้องยาอยู่ไหน','การเงินอยู่ไหน','เวลาทำการ','ทำบัตรผู้ป่วยใหม่','จอดรถที่ไหน'];

export function ReceptionShell({client,caps}:{client:KioskClient; caps:Capabilities}) {
 const [active,setActive] = useState(false);
 const [sid,setSid] = useState('');
 const [view,setView] = useState<View>({kind:'menu'});
 const [caption,setCaption] = useState(GREETING);
 const [avatar,setAvatar] = useState<AvatarState>('greeting');
 const [busy,setBusy] = useState(false);
 const [error,setError] = useState('');
 const [places,setPlaces] = useState<PublicPlace[]|null>(null);
 const [sound,setSound] = useState(true);
 const [voice,setVoice] = useState(false);
 const [left,setLeft] = useState(IDLE_SECONDS);
 const touched = useRef(Date.now());
 const canSpeak = caps.capabilities.speech && voice;

 // Local voices arrive asynchronously in some browsers.
 useEffect(()=>{ const check = () => setVoice(speechAvailable()); check();
  if (typeof window!=='undefined' && 'speechSynthesis' in window) { window.speechSynthesis.addEventListener('voiceschanged',check); return ()=>window.speechSynthesis.removeEventListener('voiceschanged',check); } },[]);
 const say = useCallback((text:string, after:AvatarState='idle')=>{
  setCaption(text);
  if (sound && canSpeak && speak(text,()=>setAvatar(after))) setAvatar('speaking'); else setAvatar(after);
 },[sound,canSpeak]);

 const reset = useCallback(()=>{
  stopSpeaking();
  if (sid) void client.end(sid);
  setSid(''); setActive(false); setView({kind:'menu'}); setCaption(GREETING); setAvatar('greeting'); setError('');
 },[client,sid]);
 // Back to the welcome after a pause (with a visible countdown at the end).
 useEffect(()=>{ if (!active) return;
  const t = setInterval(()=>{ const s = IDLE_SECONDS-Math.floor((Date.now()-touched.current)/1000); setLeft(s); if (s<=0) reset(); },1000);
  return ()=>clearInterval(t); },[active,reset]);
 const touch = () => { touched.current = Date.now(); setLeft(IDLE_SECONDS); };

 const begin = async () => {
  touch(); setBusy(true); setError('');
  const r = await client.session();
  setBusy(false);
  if (!r.ok) { setError(r.reason); return; }
  setSid(r.sessionId); setActive(true); setView({kind:'menu'}); say(GREETING);
  if (!places) void client.places().then(p=>{ if (p.ok) setPlaces(p.places); });
 };
 const send = async (input:Turn) => {
  touch(); setBusy(true); setError(''); setAvatar('thinking'); stopSpeaking();
  let session = sid;
  let r = await client.turn(session,input);
  // The session ended on the server (idle, restart): start a new one and ask again, once.
  if (!r.ok && r.code==='RESOURCE_NOT_FOUND' && /หมดเวลา/.test(r.reason)) { const s = await client.session(); if (s.ok) { session = s.sessionId; setSid(session); r = await client.turn(session,input); } }
  setBusy(false);
  if (!r.ok) { setError(r.reason); setAvatar('unsure'); return; }
  const reply = r.response;
  const has = (t:string) => reply.actions.some(a=>a.type===t);
  setView(has('show_queue') ? {kind:'queue'} : has('my_queue') ? {kind:'myqueue'} : has('show_directory') && !has('show_place') ? {kind:'directory'} : {kind:'reply',reply});
  say(reply.text, has('show_place') ? 'pointing' : reply.handoff.required || reply.intent==='unknown' ? 'unsure' : 'idle');
 };
 const backToMenu = useCallback(()=>{ setView({kind:'menu'}); setAvatar('idle'); setCaption(GREETING); },[]);
 const callStaff = async () => {
  touch(); setBusy(true);
  const r = await client.help(sid);
  setBusy(false);
  if (!r.ok) { setError(r.reason); return; }
  setView({kind:'help'}); say('แจ้งเจ้าหน้าที่แล้วค่ะ กรุณารอที่ตู้นี้สักครู่ เจ้าหน้าที่จะมาช่วย','thanks');
 };

 if (!active) return <main className="rcp idle" onClick={()=>void begin()}>
  <KioskAvatar state={busy?'thinking':'greeting'} mode={caps.avatar?.mode} url={avatarUrl(caps.avatar?.id)}/>
  <div className="rcpWelcome">
   <h1>สวัสดีค่ะ ยินดีต้อนรับ</h1>
   <p>ฉันชื่อ<b>{AVATAR_NAME}</b> ผู้ช่วยต้อนรับดิจิทัล<br/>ค้นหาจุดบริการ · ขั้นตอนรับบริการ · เวลาทำการ · ข้อมูลคิว · เรียกเจ้าหน้าที่</p>
   <button className="rcpStart" disabled={busy}>{busy?'กำลังเริ่ม…':'แตะเพื่อเริ่มใช้งาน'}</button>
   {error && <p className="rcpError" role="alert">{error}</p>}
   <small>{caps.kiosk.name}{caps.kiosk.at ? ` · ${caps.kiosk.at.nameTh}` : ''} · ตู้นี้ไม่ใช้กล้อง ไม่บันทึกเสียงหรือข้อความที่พิมพ์</small>
  </div>
 </main>;

 const queueOn = caps.capabilities.generalQueueInfo || caps.capabilities.myQueue;
 const page = <main className="rcp" onPointerDown={touch} onKeyDown={touch}>
  <aside className="rcpSide">
   <KioskAvatar state={avatar} mode={caps.avatar?.mode} url={avatarUrl(caps.avatar?.id)}/>
   <span className="rcpNameTag">{AVATAR_NAME} · ผู้ช่วยต้อนรับดิจิทัล</span>
   <p className="rcpCaption" aria-live="polite">{caption}</p>
   <div className="rcpSideActs">
    {caps.capabilities.speech && voice && <button className="rcpSmall" aria-pressed={sound} onClick={()=>{ if (sound) stopSpeaking(); setSound(s=>!s); }}>{sound?<Volume2 size={20}/>:<VolumeX size={20}/>} {sound?'เปิดเสียง':'ปิดเสียง'}</button>}
    <button className="rcpSmall" onClick={reset}>เริ่มใหม่</button>
   </div>
  </aside>
  <section className="rcpMain">
   {error && <p className="rcpError" role="alert">{error}</p>}
   {view.kind!=='menu' && <button className="rcpBack" onClick={()=>{ touch(); setView({kind:'menu'}); setAvatar('idle'); }}><ChevronLeft size={26}/> เมนูหลัก</button>}
   {view.kind==='menu' && <Menu busy={busy} send={send} ask={()=>{ touch(); setView({kind:'ask'}); }} staff={()=>void callStaff()} queueInfo={queueOn}/>}
   {view.kind==='queue' && <QueueBoard myQueue={caps.capabilities.myQueue} openMine={()=>{ touch(); setView({kind:'myqueue'}); say('สแกน QR บนบัตรคิวของคุณที่เครื่องอ่านของตู้ค่ะ'); }} touch={touch}/>}
   {view.kind==='myqueue' && <MyQueue touch={touch} done={backToMenu}/>}
   {view.kind==='ask' && <Ask busy={busy} send={t=>void send({type:'text',text:t})} touch={touch}/>}
   {view.kind==='directory' && <Directory places={places} pick={code=>void send({type:'place',code})} touch={touch}/>}
   {view.kind==='reply' && <ReplyView reply={view.reply} at={caps.kiosk.at} send={send} staff={()=>void callStaff()} busy={busy}/>}
   {view.kind==='help' && <div className="rcpCard rcpHelp"><BellRing size={44}/><h2>แจ้งเจ้าหน้าที่แล้ว</h2><p>กรุณารอที่ตู้นี้สักครู่ เจ้าหน้าที่จะมาช่วยค่ะ</p>
    {caps.contact && <p className="rcpNote">หรือ {caps.contact}</p>}</div>}
  </section>
  {left<=WARN_SECONDS && <div className="rcpIdle" role="alert">ไม่มีการใช้งาน · จะกลับหน้าแรกใน {Math.max(0,left)} วินาที — แตะหน้าจอเพื่อใช้งานต่อ</div>}
 </main>;
 // Queue views read the same public stream as the TV screens — only when an administrator turned them on.
 return queueOn ? <QueueFeed>{page}</QueueFeed> : page;
}

function Menu({busy,send,ask,staff,queueInfo}:{busy:boolean; send:(t:Turn)=>Promise<void>; ask:()=>void; staff:()=>void; queueInfo:boolean}) {
 const tiles:[React.ReactNode,string,string,()=>void,boolean?][] = [
  [<Navigation key="n" size={40}/>,'ค้นหาจุดบริการ','ห้องตรวจ ห้องยา การเงิน ห้องแล็บ',()=>void send({type:'menu',id:'directory'})],
  [<ListOrdered key="s" size={40}/>,'ขั้นตอนรับบริการ','มาครั้งแรก · มาตามนัด',()=>void send({type:'menu',id:'steps'})],
  [<Clock key="c" size={40}/>,'เวลาทำการ','แผนกผู้ป่วยนอก · ห้องฉุกเฉิน',()=>void send({type:'menu',id:'hours'})],
  [<Users key="q" size={40}/>,'ข้อมูลคิว',queueInfo?'จำนวนคนรอ · คิวของฉัน':'ยังไม่เปิดให้บริการ',()=>void send({type:'menu',id:'queue'}),!queueInfo],
  [<Keyboard key="k" size={40}/>,'พิมพ์คำถาม','เช่น ห้องยาอยู่ไหน',ask],
  [<BellRing key="b" size={40}/>,'เรียกเจ้าหน้าที่','ให้เจ้าหน้าที่มาที่ตู้นี้',staff],
 ];
 return <div className="rcpTiles">{tiles.map(([icon,title,sub,go,off])=><button key={title} className={'rcpTile'+(off?' off':'')+(title==='เรียกเจ้าหน้าที่'?' staff':'')} disabled={busy} onClick={go}>
  {icon}<b>{title}</b><small>{sub}</small></button>)}</div>;
}

function Ask({busy,send,touch}:{busy:boolean; send:(t:string)=>void; touch:()=>void}) {
 const [text,setText] = useState('');
 return <div className="rcpCard">
  <h2>พิมพ์คำถาม</h2>
  <form className="rcpAsk" onSubmit={e=>{ e.preventDefault(); if (text.trim()) send(text.trim()); }}>
   <input value={text} maxLength={200} autoFocus placeholder="เช่น ห้องยาอยู่ไหน" onChange={e=>{ touch(); setText(e.target.value); }} aria-label="คำถาม"/>
   <button disabled={busy || !text.trim()}>ถาม</button>
  </form>
  <div className="rcpChips">{SUGGEST.map(s=><button key={s} disabled={busy} onClick={()=>send(s)}>{s}</button>)}</div>
  <p className="rcpNote">ตู้นี้ตอบเรื่องการรับบริการและเส้นทาง · ไม่ให้คำแนะนำทางการแพทย์ · ไม่ค้นข้อมูลผู้ป่วย · ข้อความที่พิมพ์ไม่ถูกบันทึก</p>
 </div>;
}

function Directory({places,pick,touch}:{places:PublicPlace[]|null; pick:(code:string)=>void; touch:()=>void}) {
 const [q,setQ] = useState('');
 const groups = useMemo(()=>{ const m = new Map<string,PublicPlace[]>();
  (places ?? []).filter(p=>!q.trim() || p.nameTh.includes(q.trim())).forEach(p=>m.set(p.whereTh,[...(m.get(p.whereTh) ?? []),p])); return [...m.entries()]; },[places,q]);
 return <div className="rcpCard">
  <h2>ค้นหาจุดบริการ</h2>
  <label className="rcpSearch"><Search size={24}/><input value={q} onChange={e=>{ touch(); setQ(e.target.value); }} placeholder="พิมพ์ชื่อ เช่น ห้องยา การเงิน" aria-label="ค้นหาจุดบริการ"/></label>
  {places===null ? <p className="rcpNote">กำลังโหลด…</p> : groups.length ? <div className="rcpGroups">{groups.map(([where,list])=><section key={where}><h3><MapPin size={20}/> {where}</h3>
   <div className="rcpPlaces">{list.map(p=><button key={p.code} onClick={()=>pick(p.code)}>{p.nameTh}</button>)}</div></section>)}</div>
   : <p className="rcpNote">ไม่พบจุดบริการที่ค้นหา · กดเรียกเจ้าหน้าที่ได้ที่เมนูหลัก</p>}
 </div>;
}

function ReplyView({reply,at,send,staff,busy}:{reply:Reply; at?:PublicPlace; send:(t:Turn)=>Promise<void>; staff:()=>void; busy:boolean}) {
 const place = reply.actions.find(a=>a.type==='show_place');
 const choose = reply.actions.find(a=>a.type==='choose');
 const offer = reply.actions.some(a=>a.type==='offer_staff');
 const menu = reply.actions.some(a=>a.type==='show_menu');
 return <div className="rcpCard">
  <p className={'rcpAnswer'+(reply.intent==='emergency'?' urgent':'')}>{reply.text}</p>
  {choose && <div className="rcpChoices">{choose.options.map(o=><button key={o.id} disabled={busy} onClick={()=>void send(o.kind==='answer'?{type:'answer',id:o.id}:{type:'place',code:o.id})}>{o.label}</button>)}</div>}
  {place && <PlaceRoute place={place.place} steps={place.steps} at={at}/>}
  {(offer || menu) && <div className="rcpActs">{offer && <button className="rcpStaff" disabled={busy} onClick={staff}><BellRing size={22}/> เรียกเจ้าหน้าที่</button>}
   {menu && <button disabled={busy} onClick={()=>void send({type:'menu',id:'directory'})}><Navigation size={22}/> ค้นหาจุดบริการ</button>}</div>}
  {reply.sources.length>0 && <p className="rcpSource">ที่มา: {reply.sources.map(s=>s.title).join(' · ')}</p>}
 </div>;
}

// The way there, the floor plan, and a QR to take the same route on a phone (the public wayfinding page).
function PlaceRoute({place,steps,at}:{place:PublicPlace; steps:string[]; at?:PublicPlace}) {
 const [qr,setQr] = useState('');
 const url = typeof window==='undefined' ? '' : `${window.location.origin}/wayfinding?to=${encodeURIComponent(place.code)}${at?`&at=${encodeURIComponent(at.code)}`:''}`;
 useEffect(()=>{ if (url) void QRCode.toDataURL(url,{margin:1,width:220}).then(setQr).catch(()=>setQr('')); },[url]);
 return <div className="rcpRoute">
  <div><h2>{place.nameTh}</h2><p className="rcpWhere">{place.whereTh}</p>
   <ol className="rcpSteps">{steps.map((s,i)=><li key={i}>{s}</li>)}</ol>
   <FloorPlanSvg buildingId={place.buildingId} level={place.level} highlightZone={place.zoneIndex} highlightRoom={place.roomId}
    showLift={!at || at.buildingId!==place.buildingId || at.level!==place.level} height={240}/></div>
  {qr && <figure className="rcpQr"><img src={qr} alt="QR เส้นทาง"/><figcaption>สแกนเพื่อดูเส้นทางบนมือถือ</figcaption></figure>}
 </div>;
}
