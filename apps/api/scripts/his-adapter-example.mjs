// Example HIS adapter: read counts from the hospital system and push them to the twin every 30 s.
// Replace readFromHis() with a query against the HIS (read-only account, aggregates only — no names / HN).
//   INGEST_URL=https://queue.example.org INGEST_TOKEN=… node scripts/his-adapter-example.mjs
const URL_BASE = process.env.INGEST_URL ?? 'http://localhost:4000';
const TOKEN = process.env.INGEST_TOKEN;
if (!TOKEN) { console.error('set INGEST_TOKEN (same value as the API)'); process.exit(1); }

async function readFromHis() {
  // e.g. SELECT clinic, COUNT(*) FROM ovst WHERE vstdate = CURDATE() AND <waiting> GROUP BY clinic  (HOSxP-style)
  return {
    at: new Date().toISOString(),
    floors: { 'opd:1': 310, 'opd:2': 190, 'opd:3': 150, 'opd:4': 95 },          // people now on each floor
    servicePoints: {                                                            // id → queue / wait / status
      registration: { queue: 35, waitMinutes: 11, status: 'normal' },
      pharmacy: { queue: 80, waitMinutes: 26, status: 'busy' },
    },
  };
}
async function push() {
  const res = await fetch(`${URL_BASE}/ingest/live`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(await readFromHis()) });
  console.log(new Date().toLocaleTimeString('th-TH'), res.status, await res.text());
}
await push();
if (!process.argv.includes('--once')) setInterval(() => push().catch((e) => console.error(e.message)), 30_000);
