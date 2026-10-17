'use client';
import { apiBase } from '../api-url';

// Digital Reception kiosk ↔ API (apps/api/src/reception.controller.ts). REST only — the kiosk opens no socket, so it
// never holds the live queue. The device credential (from Settings → ตู้ต้อนรับ) stays in this browser's storage; it
// is exchanged for a short kiosk token, renewed while the kiosk is on.
export type PublicPlace = {code:string; nameTh:string; whereTh:string; buildingId:string; level:number; zoneIndex?:number; roomId?:string; landmarkTh?:string};
export type Topic = 'faq'|'steps'|'hours'|'emergency';
export type Action =
 | {type:'show_place'; place:PublicPlace; steps:string[]}
 | {type:'show_answer'; id:string; topic:Topic; questionTh:string}
 | {type:'choose'; options:{kind:'answer'|'place'; id:string; label:string}[]}
 | {type:'show_directory'}
 | {type:'show_menu'}
 | {type:'offer_staff'};
export type Reply = {text:string; intent:string; actions:Action[]; sources:{id:string; title:string}[]; handoff:{required:boolean; reason:string|null}};
export type Turn = {type:'text'; text:string}|{type:'menu'; id:'directory'|'steps'|'hours'|'queue'|'staff'}|{type:'answer'; id:string}|{type:'place'; code:string};
export type Capabilities = {kiosk:{id:string; name:string; at?:PublicPlace}; contact?:string; capabilities:{wayfinding:boolean; speech:boolean; voiceInput:boolean; ai:boolean; generalQueueInfo:boolean}};
type Res<T> = ({ok:true} & T) | {ok:false; code?:string; reason:string};

const KEY = 'reception.kiosk';
export const savedCredential = () => { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } };
export const saveCredential = (c:string) => { try { if (c) localStorage.setItem(KEY,c); else localStorage.removeItem(KEY); } catch { /* storage blocked: ask again next time */ } };

// The kinds of action this kiosk knows; anything else from the server is dropped (spec §9: reject unknown actions).
const KNOWN = new Set(['show_place','show_answer','choose','show_directory','show_menu','offer_staff']);
export const knownActions = (a:unknown):Action[] => Array.isArray(a) ? a.filter((x):x is Action=>!!x && typeof x==='object' && KNOWN.has((x as {type?:string}).type ?? '')) : [];

export class KioskClient {
 private token = '';
 private renew?:ReturnType<typeof setInterval>;
 constructor(private credential:string) {}
 private async call<T>(method:'GET'|'POST', path:string, body?:unknown):Promise<Res<T>> {
  try {
   const r = await fetch(`${apiBase()}/api/reception/v1${path}`,{method,headers:{'content-type':'application/json',...(this.token?{authorization:`Bearer ${this.token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
   const j = await r.json().catch(()=>({})) as Record<string,unknown>;
   return r.ok ? {ok:true,...j} as Res<T> : {ok:false,code:j.code as string|undefined,reason:(j.reason as string) ?? 'ระบบขัดข้อง กรุณาลองใหม่'};
  } catch { return {ok:false,code:'NETWORK',reason:'เชื่อมต่อระบบไม่ได้ กรุณาสอบถามเจ้าหน้าที่'}; }
 }
 // Sign the device in (and keep the token fresh every 10 minutes; a failed renewal signs in again).
 async start():Promise<Res<Capabilities>> {
  const s = await this.call<{token:string}>('POST','/kiosk/session',{credential:this.credential});
  if (!s.ok) return s;
  this.token = s.token;
  clearInterval(this.renew);
  this.renew = setInterval(()=>{ void this.call<{token:string}>('POST','/kiosk/session/refresh').then(async r=>{ if (r.ok) this.token = r.token; else await this.signInAgain(); }); },10*60_000);
  return this.call<Capabilities>('GET','/capabilities');
 }
 private async signInAgain() { const s = await this.call<{token:string}>('POST','/kiosk/session',{credential:this.credential}); if (s.ok) this.token = s.token; }
 stop() { clearInterval(this.renew); }
 // A call that failed because the token ended (restart of the API): sign in again once and retry.
 private async retry<T>(fn:()=>Promise<Res<T>>):Promise<Res<T>> { const r = await fn(); if (!r.ok && r.code==='AUTH_REQUIRED') { await this.signInAgain(); return fn(); } return r; }
 session() { return this.retry(()=>this.call<{sessionId:string; expiresInSeconds:number}>('POST','/sessions')); }
 async turn(sessionId:string, input:Turn):Promise<Res<{response:Reply}>> {
  const r = await this.retry(()=>this.call<{response:Reply}>('POST',`/sessions/${encodeURIComponent(sessionId)}/turns`,{input}));
  return r.ok ? {...r,response:{...r.response,actions:knownActions(r.response?.actions)}} : r;
 }
 help(sessionId:string) { return this.retry(()=>this.call<{requestedAt:string}>('POST',`/sessions/${encodeURIComponent(sessionId)}/help`)); }
 end(sessionId:string) { return this.call('POST',`/sessions/${encodeURIComponent(sessionId)}/end`); }
 places(q='') { return this.retry(()=>this.call<{places:PublicPlace[]}>('GET',`/places${q?`?q=${encodeURIComponent(q)}`:''}`)); }
}
