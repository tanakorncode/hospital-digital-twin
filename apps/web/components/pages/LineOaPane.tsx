'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarCheck, CalendarPlus, CheckCircle2, CircleDashed, Download, Headset, Link2, MapPinned, Send, Ticket, Upload, type LucideIcon } from 'lucide-react';
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
// Icons: the same line icons as the rest of the system (not emoji, which look different on every phone).
const tiles:[LucideIcon,string,string][] = [[Ticket,'คิวของฉัน','ลำดับและเวลารอ'],[CalendarPlus,'จองคิว','จองล่วงหน้า'],[CalendarCheck,'นัดหมาย','ดู · เลื่อน · ยกเลิก'],
 [MapPinned,'แผนที่','ทางไปจุดบริการ'],[Link2,'เชื่อมบัญชี','ทำครั้งเดียวที่เคาน์เตอร์'],[Headset,'ติดต่อเจ้าหน้าที่','สอบถาม']];
const W = 2500, H = 1686;
const examples = ['คิวถึงไหนแล้ว','ห้องยาอยู่ไหน','อยากจองคิว','ขอเลื่อนนัด','ติดต่อเจ้าหน้าที่'];

// Light and calm, like the rest of the system: white cards on a pale background, one blue for icons and one tile
// filled — "คิวของฉัน", what patients open most. The tap areas are the API's (three columns × two rows), unchanged.
const BLUE = '#1667d9', INK = '#0f2340', MUTED = '#5d7086';
const svgImage = (svg:string, color:string) => new Promise<HTMLImageElement>((res,rej)=>{ const im = new Image();
 im.onload = ()=>res(im); im.onerror = rej; im.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replaceAll('currentColor',color))}`; });
async function drawMenu(c:HTMLCanvasElement, icons:string[]) {
 const g = c.getContext('2d')!, w = Math.floor(W/3), h = Math.floor(H/2), font = getComputedStyle(document.body).fontFamily;
 g.clearRect(0,0,W,H); g.fillStyle = '#eef3f9'; g.fillRect(0,0,W,H);
 const imgs = await Promise.all(icons.map((svg,i)=>svgImage(svg,i===0 ? '#ffffff' : BLUE)));
 tiles.forEach(([,label,sub],i)=>{
  const x = (i%3)*w, y = Math.floor(i/3)*h, tw = i%3===2 ? W-2*w : w, hot = i===0, cx = x+tw/2;
  // the card, with a soft shadow
  g.save(); g.shadowColor = 'rgba(15,35,64,.10)'; g.shadowBlur = 36; g.shadowOffsetY = 10;
  const card = new Path2D(); card.roundRect(x+22,y+22,tw-44,h-44,56);
  if (hot) { const gr = g.createLinearGradient(x,y,x,y+h); gr.addColorStop(0,'#1f74e8'); gr.addColorStop(1,'#1158c4'); g.fillStyle = gr; } else g.fillStyle = '#ffffff';
  g.fill(card); g.restore();
  if (!hot) { g.strokeStyle = '#dbe5f1'; g.lineWidth = 3; g.stroke(card); }
  // the icon in a soft circle
  g.fillStyle = hot ? 'rgba(255,255,255,.18)' : '#e8f1fd';
  g.beginPath(); g.arc(cx,y+h*0.35,128,0,Math.PI*2); g.fill();
  g.drawImage(imgs[i],cx-76,y+h*0.35-76,152,152);
  // label and the line under it; a long label gets smaller to keep a margin
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const fit = (text:string, size:number, weight:string) => { let px = size; do { g.font = `${weight} ${px}px ${font}`; px -= 4; } while (g.measureText(text).width>tw-160 && px>40); };
  fit(label,108,'700'); g.fillStyle = hot ? '#ffffff' : INK; g.fillText(label,cx,y+h*0.68);
  fit(sub,62,'500'); g.fillStyle = hot ? '#d9e7fd' : MUTED; g.fillText(sub,cx,y+h*0.80);
 });
}

export function LineOaPane({api}:{api:Api}) {
 const [st,setSt] = useState<Status|null>(null);
 const [text,setText] = useState('');
 const [chat,setChat] = useState<{me:string; bot:Answer}[]>([]);
 const [msg,setMsg] = useState<{text:string; bad?:boolean}|null>(null);
 const [busy,setBusy] = useState(false);
 const canvas = useRef<HTMLCanvasElement>(null), iconBox = useRef<HTMLDivElement>(null);
 useEffect(()=>{ void api<{ok:boolean} & Status>('line:status',{}).then(r=>{ if (r.ok) setSt(r); }); },[api]);
 // The icons are drawn as SVG on the page (hidden) and painted onto the canvas, after the fonts have loaded.
 useEffect(()=>{ const c = canvas.current, box = iconBox.current; if (!c || !box) return;
  const svgs = [...box.querySelectorAll('svg')].map(el=>{ el.setAttribute('xmlns','http://www.w3.org/2000/svg'); return el.outerHTML; });
  void document.fonts.ready.then(()=>drawMenu(c,svgs)); },[]);
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
  <div ref={iconBox} hidden aria-hidden>{tiles.map(([I],i)=><I key={i} size={24} strokeWidth={1.8}/>)}</div>
  {msg && <p className={'setToast'+(msg.bad?' bad':'')} role="status">{msg.text}</p>}
  <div className="segBtns"><button onClick={()=>void download()}><Download size={14}/> ดาวน์โหลดรูป</button>
   <button className="on" disabled={busy || !st?.messaging || !st?.menuTarget} onClick={()=>void install()}><Upload size={14}/> {busy?'กำลังติดตั้ง…':'ติดตั้งเมนูใน LINE'}</button>
   {(!st?.messaging || !st?.menuTarget) && <small className="muted">ต้องตั้ง LINE_CHANNEL_ACCESS_TOKEN และ LINE_LIFF_ID (หรือ PUBLIC_URL) ก่อน</small>}</div>
 </section>;
}
