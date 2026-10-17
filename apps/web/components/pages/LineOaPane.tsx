'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleDashed, Download, Send, Upload } from 'lucide-react';
import type { QueueSync } from '../../lib/queue';

// Settings → LINE OA (administrators): what is set up (yes/no only), try the chatbot without LINE, and the rich menu —
// drawn here (so Thai text uses the browser's fonts), downloadable, and installed on the OA in one step.
type Api = QueueSync['api'];
type Status = {messaging:boolean; webhook:boolean; oa:boolean; login:boolean; liff:boolean; publicUrl:boolean; contact:boolean; menuTarget:boolean};
type Answer = {text:string; quick:{label:string; uri?:string; text?:string}[]};
const checks:[keyof Status,string,string][] = [
 ['messaging','LINE_CHANNEL_ACCESS_TOKEN','ส่งข้อความ / ติดตั้งเมนู'],['webhook','LINE_CHANNEL_SECRET','รับข้อความจากผู้ป่วย (webhook)'],['oa','LINE_OA_ID','ลิงก์เปิดแชต OA'],
 ['login','LINE_LOGIN_CHANNEL_ID','ยืนยันตัวตนผู้ป่วยด้วย LINE'],['liff','LINE_LIFF_ID','ปุ่มเมนูเปิดหน้าผู้ป่วยในแอป LINE'],['publicUrl','PUBLIC_URL','ลิงก์เส้นทางในคำตอบแชต'],
 ['contact','HOSPITAL_CONTACT','คำตอบ "ติดต่อเจ้าหน้าที่"']];
// Same tiles, same order as the API's rich menu (apps/api/src/line-bot.ts).
const tiles = [['🔢','คิวของฉัน','ลำดับและเวลารอ'],['🗓️','จองคิว','จองล่วงหน้า'],['📅','นัดหมาย','ดู · เลื่อน · ยกเลิก'],
 ['🗺️','แผนที่','ทางไปจุดบริการ'],['🔗','เชื่อมบัญชี','ทำครั้งเดียวที่เคาน์เตอร์'],['☎️','ติดต่อเจ้าหน้าที่','สอบถาม']] as const;
const W = 2500, H = 1686;
const examples = ['คิวถึงไหนแล้ว','ห้องยาอยู่ไหน','อยากจองคิว','ขอเลื่อนนัด','ติดต่อเจ้าหน้าที่'];

function drawMenu(c:HTMLCanvasElement) {
 const g = c.getContext('2d')!, w = Math.floor(W/3), h = Math.floor(H/2), font = getComputedStyle(document.body).fontFamily;
 g.fillStyle = '#0f2340'; g.fillRect(0,0,W,H);
 tiles.forEach(([icon,label,sub],i)=>{
  const x = (i%3)*w, y = Math.floor(i/3)*h, tw = i%3===2 ? W-2*w : w;
  g.fillStyle = i===0 ? '#06c755' : i===4 ? '#1667d9' : '#16305a';
  g.beginPath(); g.roundRect(x+18,y+18,tw-36,h-36,48); g.fill();
  g.textAlign = 'center'; g.fillStyle = '#ffffff';
  g.font = `220px ${font}`; g.fillText(icon,x+tw/2,y+330);
  // Long labels shrink to fit the tile (with a margin), short ones keep the full size.
  const fit = (text:string, size:number, weight='') => { let px = size; do { g.font = `${weight} ${px}px ${font}`; px -= 4; } while (g.measureText(text).width > tw-120 && px > 40); };
  fit(label,128,'bold'); g.fillText(label,x+tw/2,y+560);
  fit(sub,72); g.fillStyle = '#d6e4f5'; g.fillText(sub,x+tw/2,y+690);
 });
}

export function LineOaPane({api}:{api:Api}) {
 const [st,setSt] = useState<Status|null>(null);
 const [text,setText] = useState('');
 const [chat,setChat] = useState<{me:string; bot:Answer}[]>([]);
 const [msg,setMsg] = useState<{text:string; bad?:boolean}|null>(null);
 const [busy,setBusy] = useState(false);
 const canvas = useRef<HTMLCanvasElement>(null);
 useEffect(()=>{ void api<{ok:boolean} & Status>('line:status',{}).then(r=>{ if (r.ok) setSt(r); }); },[api]);
 useEffect(()=>{ const c = canvas.current; if (c) void document.fonts.ready.then(()=>drawMenu(c)); },[]);
 const ask = useCallback(async (t:string)=>{ if (!t.trim()) return; const r = await api<{ok:boolean; answer?:Answer}>('line:try',{text:t});
  if (r.ok && r.answer) setChat(c=>[...c.slice(-5),{me:t,bot:r.answer!}]); setText(''); },[api]);
 const png = () => new Promise<Blob>((res,rej)=>canvas.current!.toBlob(b=>b ? res(b) : rej(new Error('no image')),'image/png'));
 const download = async () => { const url = URL.createObjectURL(await png()); const a = document.createElement('a'); a.href = url; a.download = 'line-richmenu.png'; a.click(); URL.revokeObjectURL(url); };
 const install = async () => {
  setBusy(true); setMsg(null);
  const r = await api('line:richmenu',{png:await (await png()).arrayBuffer()});
  setBusy(false);
  setMsg(r.ok ? {text:'ติดตั้งเมนูใน LINE แล้ว · ผู้ใช้จะเห็นเมนูใหม่เมื่อเปิดแชตครั้งถัดไป'} : {text:r.reason ?? 'ติดตั้งไม่สำเร็จ',bad:true});
 };
 return <section className="setCard">
  <h4 className="setSub">การตั้งค่า LINE <small>ตั้งใน apps/api/.env แล้วเริ่ม API ใหม่ · หน้านี้บอกแค่ว่าตั้งแล้วหรือยัง ไม่แสดงค่า</small></h4>
  <div className="oaChecks">{checks.map(([k,name,use])=><span key={k} className={st?.[k]?'on':''}>{st?.[k] ? <CheckCircle2 size={16}/> : <CircleDashed size={16}/>}<b>{name}</b><small>{use}</small></span>)}</div>

  <h4 className="setSub">ลองคุยกับบอท <small>ดูคำตอบได้โดยไม่ต้องมี LINE · บอทไม่ค้นข้อมูลผู้ป่วย เรื่องส่วนตัวจะเป็นปุ่มเปิดหน้าของผู้ป่วยเอง</small></h4>
  <div className="oaChat">
   {chat.map((c,i)=><div key={i} className="oaTurn"><p className="oaMe">{c.me}</p><p className="oaBot">{c.bot.text}</p>
    <div className="oaQuick">{c.bot.quick.map(q=><span key={q.label} title={q.uri ?? `ส่งข้อความ "${q.text}"`}>{q.label}</span>)}</div></div>)}
   <form className="oaInput" onSubmit={e=>{ e.preventDefault(); void ask(text); }}><input value={text} maxLength={200} placeholder="พิมพ์เหมือนผู้ป่วย เช่น ห้องยาอยู่ไหน" onChange={e=>setText(e.target.value)}/>
    <button className="btn" disabled={!text.trim()}><Send size={14}/> ส่ง</button></form>
   <div className="segBtns">{examples.map(x=><button key={x} onClick={()=>void ask(x)}>{x}</button>)}</div>
  </div>

  <h4 className="setSub">Rich menu (เมนูใต้ช่องแชต) <small>6 ปุ่ม · ปุ่มส่วนตัวเปิดหน้าผู้ป่วยในแอป LINE · ขนาด 2500×1686</small></h4>
  <canvas ref={canvas} width={W} height={H} className="oaMenu" aria-label="ภาพเมนู LINE"/>
  {msg && <p className={'setToast'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}
  <div className="segBtns"><button onClick={()=>void download()}><Download size={14}/> ดาวน์โหลดรูป</button>
   <button className="on" disabled={busy || !st?.messaging || !st?.menuTarget} onClick={()=>void install()}><Upload size={14}/> {busy?'กำลังติดตั้ง…':'ติดตั้งเมนูใน LINE'}</button>
   {(!st?.messaging || !st?.menuTarget) && <small className="muted">ต้องตั้ง LINE_CHANNEL_ACCESS_TOKEN และ LINE_LIFF_ID (หรือ PUBLIC_URL) ก่อน</small>}</div>
 </section>;
}
