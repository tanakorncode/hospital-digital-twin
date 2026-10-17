# Deploy (Docker + HTTPS)

One server, one domain. Caddy terminates HTTPS (automatic certificates) and routes `/socket.io/*` and `/health` to the API, everything else to the web app.

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
Restore: stop the API, copy a backup over `hospital.db` on the volume, start again.

## Update
```bash
git pull && docker compose up -d --build     # data stays on the volume
```

## Notes
- Without Docker: `pnpm install && pnpm --filter api build && node apps/api/dist/main` and
  `NEXT_PUBLIC_API_URL=https://api.example.org pnpm --filter web build && pnpm --filter web start` behind any reverse proxy (WebSocket upgrade on `/socket.io/`).
- More than one API server needs a shared database (PostgreSQL) and the socket.io Redis adapter — not needed for one hospital.
- The API image was built and checked; the web image follows the standard Next.js standalone recipe.
