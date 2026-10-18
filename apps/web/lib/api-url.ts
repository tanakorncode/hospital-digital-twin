// Where the browser reaches the API (socket.io).
// · On the machine running the demo: the API port directly, over WebSocket.
// · Opened from anywhere else (a phone through ngrok, another PC on the LAN): the page's own origin — Next.js
//   relays socket.io to the API (app/sio/route.ts) — over HTTP long-polling, so one tunnel serves both.
// NEXT_PUBLIC_API_URL, when set, always wins: a URL of a deployed API, or "same-origin" (one domain, reverse proxy).
// Where the browser reaches the API's REST routes (/api/v1 …): the same choices as for the socket. Through a tunnel
// (polling relay) the page's own origin is used — Next relays /api/v1 to the API (next.config.ts rewrites).
export function apiBase():string {
  const env = process.env.NEXT_PUBLIC_API_URL;
  if (env==='same-origin') return '';
  if (env) return env.replace(/\/$/,'');
  if (typeof window!=='undefined' && ['localhost','127.0.0.1','[::1]'].includes(window.location.hostname)) return 'http://localhost:4000';
  return '';
}
// A floor-plan picture uploaded in Settings (served by the API, cached for good).
export const facilityImageUrl = (id:string) => `${apiBase()}/api/v1/facility/images/${encodeURIComponent(id)}`;
export function apiSocket():{url:string; opts:{transports:string[]; path?:string}} {
  const env = process.env.NEXT_PUBLIC_API_URL;
  // "same-origin": deployed behind one reverse proxy that sends /socket.io/ to the API (deploy/Caddyfile).
  if (env==='same-origin') return {url:typeof window==='undefined'?'':window.location.origin,opts:{transports:['websocket','polling']}};
  if (env) return {url:env,opts:{transports:['websocket']}};
  if (typeof window==='undefined' || ['localhost','127.0.0.1','[::1]'].includes(window.location.hostname)) return {url:'http://localhost:4000',opts:{transports:['websocket']}};
  return {url:window.location.origin,opts:{transports:['polling'],path:'/sio'}};
}
