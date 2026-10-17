'use client';
import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, LogOut, Plus, ShieldCheck, UserRound } from 'lucide-react';
import { roleText, type AuthUser, type QueueSync } from '../lib/queue';

// Staff sign-in. Shown over the dashboard when the API is reachable and nobody is signed in on this browser.
export function LoginScreen({login}:{login:QueueSync['login']}) {
 const [username,setUsername] = useState('');
 const [password,setPassword] = useState('');
 const [show,setShow] = useState(false);
 const [busy,setBusy] = useState(false);
 const [error,setError] = useState('');
 const first = useRef<HTMLInputElement>(null);
 useEffect(()=>{ first.current?.focus(); },[]);
 const submit = async (e:React.FormEvent) => {
  e.preventDefault(); if (busy) return;
  setBusy(true); setError('');
  const r = await login(username.trim(),password);
  setBusy(false);
  if (!r.ok) { setError(r.reason ?? 'เข้าสู่ระบบไม่สำเร็จ'); setPassword(''); }
 };
 return <div className="loginWrap" role="dialog" aria-modal="true" aria-labelledby="loginTitle">
  <form className="loginCard" onSubmit={submit}>
   <div className="loginBrand"><span><Plus size={30}/></span><div><b>Hospital Digital Twin</b><small>โรงพยาบาลตัวอย่าง</small></div></div>
   <h1 id="loginTitle">เข้าสู่ระบบเจ้าหน้าที่</h1>
   <p className="loginSub">ใช้บัญชีที่ผู้ดูแลระบบสร้างให้ · ทุกการทำรายการบันทึกในชื่อของคุณ</p>
   <label className="loginField"><span>ชื่อผู้ใช้</span>
    <input ref={first} value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={60} required/></label>
   <label className="loginField"><span>รหัสผ่าน</span>
    <span className="loginPass"><input type={show?'text':'password'} value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" maxLength={200} required/>
     <button type="button" aria-label={show?'ซ่อนรหัสผ่าน':'แสดงรหัสผ่าน'} onClick={()=>setShow(v=>!v)}>{show?<EyeOff size={18}/>:<Eye size={18}/>}</button></span></label>
   {error && <p className="loginError" role="alert">{error}</p>}
   <button className="loginBtn" disabled={busy || !username.trim() || !password}>{busy?'กำลังตรวจสอบ…':'เข้าสู่ระบบ'}</button>
   <p className="loginNote"><ShieldCheck size={14}/> จอทีวีและหน้าคิวของผู้ป่วยเปิดได้โดยไม่ต้องเข้าสู่ระบบ</p>
  </form>
 </div>;
}

// Signed-in user in the top bar, with sign-out.
export function UserChip({user,logout}:{user:AuthUser;logout:()=>void}) {
 const [open,setOpen] = useState(false);
 const ref = useRef<HTMLDivElement>(null);
 useEffect(()=>{ if (!open) return; const off = (e:MouseEvent)=>{ if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
  document.addEventListener('mousedown',off); return ()=>document.removeEventListener('mousedown',off); },[open]);
 return <div className="userChip" ref={ref}>
  <button className="userBtn" aria-expanded={open} onClick={()=>setOpen(o=>!o)}><span className={'userAva r-'+user.role}><UserRound size={16}/></span>
   <span className="userTxt"><b>{user.name}</b><small>{roleText[user.role]}</small></span></button>
  {open && <div className="userMenu"><div><b>{user.name}</b><small>@{user.username} · {roleText[user.role]}</small></div>
   <button onClick={()=>{ setOpen(false); logout(); }}><LogOut size={15}/> ออกจากระบบ</button></div>}
 </div>;
}
