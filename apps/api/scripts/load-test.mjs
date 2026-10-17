// Load test against a RUNNING API (a test copy — never production data). Uses socket.io-client from apps/web.
//   ADMIN_USERNAME=… ADMIN_PASSWORD=… node scripts/load-test.mjs [--url http://localhost:4000] [--sockets 20] [--bookings 400] [--actions 2000]
// 1. Booking rush: `bookings` concurrent bookings (different HNs) from `sockets` staff connections onto 10 slots whose
//    places add up to fewer than the requests → no slot may end over capacity; successes = places.
// 2. Queue actions: `actions` open/close commands spread over the sockets → latency and throughput.
// Prints p50 / p95 / max latency and a pass/fail line for the capacity check.
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(join(import.meta.dirname, '..', '..', 'web', 'package.json'));
const { io } = require('socket.io-client');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const url = arg('url', 'http://localhost:4000'), SOCKETS = Number(arg('sockets', 20)), BOOKINGS = Number(arg('bookings', 400)), ACTIONS = Number(arg('actions', 2000));
const user = process.env.ADMIN_USERNAME, pass = process.env.ADMIN_PASSWORD;
if (!user || !pass) { console.error('set ADMIN_USERNAME and ADMIN_PASSWORD (an administrator of the TEST database)'); process.exit(2); }
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1) : '-'; };
const connect = () => new Promise((resolve) => { const s = io(`${url}/hospital`, { transports: ['websocket'] }); s.on('connect', () => resolve(s)); });
const ask = (s, ev, body) => new Promise((r) => s.timeout(30000).emit(ev, body, (err, res) => r(err ? { ok: false, reason: 'timeout' } : res)));

const sockets = await Promise.all(Array.from({ length: SOCKETS }, connect));
for (const s of sockets) { const r = await ask(s, 'auth:login', { username: user, password: pass }); if (!r.ok) { console.error('login failed:', r.reason); process.exit(1); } }
const admin = sockets[0];
// Somewhere nobody books: 150 days ahead (inside a 180-day window), a test service.
const d = new Date(Date.now() + 150 * 86400000), day = d.toLocaleDateString('sv-SE'), svc = 'opd-4-2';
await ask(admin, 'features:set', { patch: { generalBooking: true } });
await ask(admin, 'booking:policy:set', { serviceCode: svc, displayName: 'ทดสอบโหลด', enabled: true, advanceDays: 180, maxActivePerPatient: 1 });
const made = await ask(admin, 'booking:slots:create', { serviceCode: svc, from: day, to: day, weekdays: [d.getDay()], start: '08:00', end: '13:00', minutes: 30, capacity: 25 });
const slots = (await ask(admin, 'booking:slots', { serviceCode: svc, date: day })).slots;
const places = slots.reduce((a, s) => a + s.remaining, 0);
console.log(`slots: ${slots.length} (${made.created ?? 0} new), places left: ${places}, booking requests: ${BOOKINGS}`);

// 1. booking rush
const lat = [], outcome = {};
const t0 = performance.now();
await Promise.all(Array.from({ length: BOOKINGS }, async (_, i) => {
  const s = sockets[i % SOCKETS], slot = slots[i % slots.length], t = performance.now();
  const r = await ask(s, 'booking:create', { hn: `99-${String(Date.now()).slice(-5)}${String(i).padStart(4, '0')}`, slotId: slot.id, key: `load-${Date.now()}-${i}` });
  lat.push(performance.now() - t); const k = r.ok ? 'ok' : r.code ?? r.reason; outcome[k] = (outcome[k] ?? 0) + 1;
}));
const t1 = performance.now();
const after = (await ask(admin, 'booking:slots', { serviceCode: svc, date: day })).slots;
const over = after.filter((s) => s.reserved > s.capacity).length, reserved = after.reduce((a, s) => a + s.reserved, 0);
console.log(`booking rush: ${BOOKINGS} in ${((t1 - t0) / 1000).toFixed(2)} s → ${JSON.stringify(outcome)}`);
console.log(`  latency ms p50 ${pct(lat, 50)} · p95 ${pct(lat, 95)} · max ${pct(lat, 100)}`);
console.log(`  capacity check: ${over === 0 && (outcome.ok ?? 0) === places && reserved === slots.reduce((a, s) => a + s.capacity, 0) ? 'PASS' : 'FAIL'} (over-full slots: ${over}, reserved: ${reserved})`);

// 2. queue actions
const qlat = [];
const q0 = performance.now(), base = new Date().getHours() * 60;
await Promise.all(Array.from({ length: ACTIONS }, async (_, i) => {
  const s = sockets[i % SOCKETS], t = performance.now();
  await ask(s, 'queue:command', { at: base + (i % 50) / 100, station: `counter:finance:${(i % 4) + 1}`, action: i % 2 ? 'close' : 'open' });
  qlat.push(performance.now() - t);
}));
const q1 = performance.now();
console.log(`queue actions: ${ACTIONS} in ${((q1 - q0) / 1000).toFixed(2)} s (${(ACTIONS / ((q1 - q0) / 1000)).toFixed(0)}/s) · latency ms p50 ${pct(qlat, 50)} · p95 ${pct(qlat, 95)} · max ${pct(qlat, 100)}`);
sockets.forEach((s) => s.close());
process.exit(0);
