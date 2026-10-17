// socket.io over HTTP long-polling, relayed to the API, for browsers that reach the demo through a tunnel or from
// another device (see lib/api-url.ts). Only the transport is relayed; the API still validates every command.
const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
export const dynamic = 'force-dynamic';

async function relay(req:Request) {
  const search = new URL(req.url).search;
  const headers:Record<string,string> = {};
  for (const h of ['content-type','cookie']) { const v = req.headers.get(h); if (v) headers[h] = v; }
  const res = await fetch(`${API}/socket.io/${search}`,{method:req.method,headers,body:req.method==='POST'?await req.arrayBuffer():undefined,cache:'no-store'});
  const out = new Headers({'content-type':res.headers.get('content-type') ?? 'text/plain; charset=UTF-8','cache-control':'no-store'});
  const cookie = res.headers.get('set-cookie'); if (cookie) out.set('set-cookie',cookie);
  return new Response(res.body,{status:res.status,headers:out});
}
export { relay as GET, relay as POST };
