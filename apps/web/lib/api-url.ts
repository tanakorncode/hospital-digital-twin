// Where the browser reaches the API (socket.io).
// · On the machine running the demo: the API port directly, over WebSocket.
// · Opened from anywhere else (a phone through ngrok, another PC on the LAN): the page's own origin — Next.js
//   relays socket.io to the API (app/sio/route.ts) — over HTTP long-polling, so one tunnel serves both.
// NEXT_PUBLIC_API_URL, when set, always wins (a deployed API).
export function apiSocket():{url:string; opts:{transports:string[]; path?:string}} {
  const env = process.env.NEXT_PUBLIC_API_URL;
  if (env) return {url:env,opts:{transports:['websocket']}};
  if (typeof window==='undefined' || ['localhost','127.0.0.1','[::1]'].includes(window.location.hostname)) return {url:'http://localhost:4000',opts:{transports:['websocket']}};
  return {url:window.location.origin,opts:{transports:['polling'],path:'/sio'}};
}
