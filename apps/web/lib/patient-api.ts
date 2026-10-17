'use client';
import { apiBase } from './api-url';

// The patient's own API (LIFF pages inside LINE). The app session token lives in this browser only (the LINE in-app
// browser), and goes in the Authorization header — no cookies, so no cross-site request can use it.
const KEY = 'hdt.patientSession';
export const loadSession = () => { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } };
export const saveSession = (t:string) => { try { if (t) localStorage.setItem(KEY,t); else localStorage.removeItem(KEY); } catch { /* private mode */ } };
export type ApiRes<T> = ({ok:true} & T) | {ok:false; code?:string; reason:string};
export async function patientApi<T>(method:'GET'|'POST', path:string, body?:unknown, headers:Record<string,string>={}):Promise<ApiRes<T>> {
 const token = loadSession();
 try {
  const res = await fetch(`${apiBase()}/api/v1/patient${path}`,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),...headers},
   body:method==='POST'?JSON.stringify(body ?? {}):undefined});
  const json = await res.json().catch(()=>({})) as Record<string,unknown>;
  if (res.ok && json.ok!==false) return {ok:true,...json} as ApiRes<T>;
  if (json.code==='AUTH_REQUIRED') saveSession('');
  return {ok:false,code:json.code as string|undefined,reason:(json.reason as string) ?? 'ระบบไม่ตอบสนอง กรุณาลองใหม่'};
 } catch { return {ok:false,code:'NETWORK',reason:'เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'}; }
}
// One key per intended action (a booking): a retry after a lost reply returns the first booking.
export const newKey = () => `l-${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint8Array(8)),b=>b.toString(16).padStart(2,'0')).join('')}`;
