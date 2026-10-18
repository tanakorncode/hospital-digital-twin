'use client';
import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { Avatar, AVATAR_NAME, type AvatarState } from './Avatar';
import { apiBase } from '../../lib/api-url';

// The kiosk's character as Settings → ตู้ต้อนรับ chose: the 3D model, or the 2D drawing. The 2D one is always the
// safety net — shown while the model loads, and for good (until the page reloads) if this machine has no WebGL, the
// model fails to load, or it cannot keep up.
const Avatar3D = dynamic(()=>import('./Avatar3D'),{ssr:false});
// The default: น้องใจดี made in Meshy (image → model → rig → motions), clips renamed and textures shrunk to ~4.8 MB.
export const DEFAULT_AVATAR_URL = '/avatars/jaidee.glb';
export const DEFAULT_AVATAR_CLIPS = ['Wave','Talk','Point','Think','Bow','Idle'];
export const avatarUrl = (id:string|null|undefined) => id ? `${apiBase()}/api/reception/v1/avatars/${encodeURIComponent(id)}` : DEFAULT_AVATAR_URL;
const webgl = () => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } };

class Guard extends Component<{onError:()=>void; children:ReactNode},{failed:boolean}> {
 state = {failed:false};
 static getDerivedStateFromError() { return {failed:true}; }
 componentDidCatch() { this.props.onError(); }
 render() { return this.state.failed ? null : this.props.children; }
}

export function KioskAvatar({state,mode,url}:{state:AvatarState; mode?:'2d'|'3d'; url?:string}) {
 const [can,setCan] = useState<boolean|null>(null), [ready,setReady] = useState(false), [off,setOff] = useState(false);
 useEffect(()=>{ setCan(webgl()); },[]);
 useEffect(()=>{ setReady(false); setOff(false); },[url]);
 const fail = useCallback(()=>setOff(true),[]), shown = useCallback(()=>setReady(true),[]);
 const use3d = mode!=='2d' && !!url && can===true && !off;
 if (!use3d) return <Avatar state={state}/>;
 return <figure className={'rcpAvatar rcp3d'+(ready?' ready':'')} aria-label={AVATAR_NAME}>
  {!ready && <div className="rcp3dWait"><Avatar state={state}/></div>}
  <Guard onError={fail}><Avatar3D url={url} state={state} onReady={shown} onSlow={fail}/></Guard>
 </figure>;
}
