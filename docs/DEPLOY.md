# Deploy (Docker + HTTPS)

One server, one domain. Caddy terminates HTTPS (automatic certificates) and routes `/socket.io/*`, `/health`, `/line/*` (LINE webhook), `/ingest/*` (HIS) and `/api/*` to the API, everything else to the web app.

```
browser ──HTTPS──▶ caddy ──┬─ /socket.io/*, /health ─▶ api  (NestJS · SQLite on a volume)
                           └─ everything else ───────▶ web  (Next.js standalone)
```

## Requirements
- Linux server with Docker + Docker Compose, ~2 GB RAM, ~3 GB disk for images.
- A DNS name pointing at the server; ports 80 and 443 open (for the certificate).

## First start
```bash
git clone https://github.com/tanakorncode/hospital-digital-twin.git && cd hospital-digital-twin
cp apps/api/.env.example apps/api/.env
#   ADMIN_PASSWORD=…        first administrator (change it after signing in)
#   WEB_ORIGIN=https://queue.example.org
#   INGEST_TOKEN=…          only if an HIS adapter will push data (docs/HIS-INTEGRATION.md)
DOMAIN=queue.example.org docker compose up -d --build
docker compose logs -f api        # "Created administrator …", "Nest application successfully started"
curl https://queue.example.org/health
```
Open `https://queue.example.org`, sign in, then **ตั้งค่า → ผู้ใช้งาน**: change the admin password and create staff accounts.
TV screens: `https://queue.example.org/tv` lists every screen URL.

Local trial without a domain: `docker compose up -d --build` → `https://localhost` (Caddy's own certificate; the browser will warn).

## Settings
| Where | Variable | Purpose |
|---|---|---|
| shell | `DOMAIN` | public host name (default `localhost`) |
| shell | `TZ` | hospital time zone (default `Asia/Bangkok`) — the queue day follows it |
| shell | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | optional, `/real-map-3d` only (baked into the web image) |
| `apps/api/.env` | `ADMIN_USERNAME`, `ADMIN_PASSWORD` | first administrator (used only while the user table is empty) |
| `apps/api/.env` | `WEB_ORIGIN` | allowed browser origin(s) |
| `apps/api/.env` | `SESSION_HOURS` | sign-in length (default 12) |
| `apps/api/.env` | `INGEST_TOKEN`, `DEMO_FEED` | HIS ingestion, demo occupancy feed |

## Backups
The database is one SQLite file on the `api-data` volume. Online backup (safe while running), keeps the newest 14:
```bash
docker compose exec api node scripts/backup.mjs          # → /repo/apps/api/data/backups/hospital-YYYY-MM-DD-HH-MM.db
# daily at 02:00 (crontab -e on the server):
0 2 * * * cd /path/to/hospital-digital-twin && docker compose exec -T api node scripts/backup.mjs
# copy backups off the server, e.g.
docker compose cp api:/repo/apps/api/data/backups ./backups
```
Check a backup / restore (the replaced database is kept as `hospital.db.before-restore-<time>`; a damaged backup is refused):
```bash
docker compose exec api node scripts/restore.mjs data/backups/<file>.db            # check only
docker compose stop api
docker compose run --rm api node scripts/restore.mjs data/backups/<file>.db --yes  # restore
docker compose start api
```
Rehearse a restore before going live, and copy backups off the server (they contain HNs — restrict and encrypt them).
Monitoring: `GET /health` → `{ ok, schema, messages: { waiting, failed24h } }`. Load test (test database only):
`ADMIN_USERNAME=… ADMIN_PASSWORD=… node apps/api/scripts/load-test.mjs`. Pilot checklist: [PILOT-READINESS.md](PILOT-READINESS.md).

## Update
```bash
git pull && docker compose up -d --build     # data stays on the volume
```

## Notes
- Without Docker: `pnpm install && pnpm --filter api build && node apps/api/dist/main` and
  `NEXT_PUBLIC_API_URL=https://api.example.org pnpm --filter web build && pnpm --filter web start` behind any reverse proxy (WebSocket upgrade on `/socket.io/`).
- More than one API server needs a shared database (PostgreSQL) and the socket.io Redis adapter — not needed for one hospital.
- The API image was built and checked; the web image follows the standard Next.js standalone recipe.

## LINE Official Account (optional)
Patients can get "ถึงคิวแล้ว" messages in LINE even with the page closed.
1. In the LINE Developers console create a **Messaging API** channel for the hospital's OA.
2. `apps/api/.env`: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` (long-lived), `LINE_OA_ID` (e.g. `@123abcde`), then restart the API.
3. Webhook URL: `https://<domain>/line/webhook` → **Use webhook: on**; turn off the OA's auto-reply messages.
4. On the patient page, **แจ้งเตือน → รับแจ้งเตือนทาง LINE** opens the OA chat with a 6-digit code typed in; sending it links that LINE user to the queue until the end of the day. Messages: called / called again, moved to another point, help request taken on. Queue number and place only — no names or HN. "หยุด" in the chat stops it; re-issuing the slip ends it too.

## Patient pages inside LINE (LIFF) and account linking (optional)
Patients open `https://<domain>/liff` from the OA's rich menu, sign in with LINE, and link their LINE account to their
hospital record once, at the counter.
1. In the same LINE Developers provider create a **LINE Login** channel; add a **LIFF app**: endpoint URL
   `https://<domain>/liff`, size *Full*, scope `openid` (no profile, no email needed).
2. `apps/api/.env`: `LINE_LOGIN_CHANNEL_ID` (the LINE Login channel id) and `LINE_LIFF_ID`, then restart the API. The API
   checks every ID token with LINE (issuer, audience = this channel, expiry) — the LINE user id is never taken from the page.
3. Settings → **ข้อมูลผู้ป่วย** → switch on *เชื่อมบัญชี LINE ของผู้ป่วย*.
4. Linking: the patient taps **ขอรหัสเชื่อมบัญชี** and shows the QR (or the 8-character code); at the counter, Queue →
   **เชื่อม LINE**: scan, check the ID card as at registration, type the HN, confirm. A new phone replaces the old link.
   Staff can look up a patient's link status and end a link with a reason.
- Testing without LINE: `PATIENT_DEV_LOGIN=on` (and no `LINE_LIFF_ID`) shows a test sign-in on `/liff` as a made-up LINE
  user. It is refused when `NODE_ENV=production` (the Docker image) — never use it with real patients.

## Messages to patients (optional)
Settings → **การแจ้งเตือน** → switch on. Patients with a linked LINE account get: booking confirmed / cancelled, a new
appointment, a reminder at 18:00 the day before, an appointment moved / cancelled, a move request not approved, check-in
done, and being called / moved / helped in the queue. Messages carry dates, times, codes and places only — no name, HN,
clinic or doctor. They are sent by a worker inside the API from a durable queue: retried on network errors, 429 and 5xx
(5 attempts, backoff), with LINE's retry key so a retry is never delivered twice. Failed ones are listed on the same
page with **ส่งใหม่**. Needs `LINE_CHANNEL_ACCESS_TOKEN` (see *LINE Official Account* above); without it messages are
recorded as skipped.

## LINE chatbot and rich menu (optional)
- The webhook answers patients' messages: "คิว", "จองคิว", "นัด/เลื่อนนัด", "เชื่อมบัญชี", "ติดต่อเจ้าหน้าที่" and "…อยู่ไหน"
  (from the wayfinding places: floor, landmark, route link). Personal things are buttons that open the patient's own LIFF
  pages — the bot never looks anyone up. New friends get a welcome message.
- `apps/api/.env`: `PUBLIC_URL` (the hospital's address, for links) and `HOSPITAL_CONTACT` (the answer to "ติดต่อเจ้าหน้าที่").
- Settings → **LINE OA**: what is set up (yes/no), try the bot without LINE, and the 6-button rich menu — drawn in the
  browser, downloadable, and **ติดตั้งเมนูใน LINE** installs it as everyone's default (needs `LINE_CHANNEL_ACCESS_TOKEN` and
  `LINE_LIFF_ID`). Installing again replaces the system's previous menu; menus made by hand in the OA Manager are left alone.
