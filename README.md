# Hospital Digital Twin — Starter

A runnable starter for an isometric hospital-campus visualization using Next.js, React Three Fiber, TypeScript, NestJS, Prisma, and WebSocket.

## Scope and data assumptions
- Campus/buildings/rooms/service points are demo geometry and must be replaced with authorized floor plans or surveyed dimensions.
- Patient flow is workflow-based demo data. It is not real-time patient location tracking.
- Never put patient names, HN, diagnosis, or other PHI into scene objects or WebSocket payloads. Use aggregate counts and opaque event IDs.
- `demo` is the default mode; connect a hospital HIS only through an approved integration adapter.

## Run the web app
```bash
pnpm install
pnpm --filter web dev
```
Open http://localhost:3000.

## Run the API
```bash
cp apps/api/.env.example apps/api/.env   # set ADMIN_PASSWORD (first start only)
pnpm --filter api start:dev
```
WebSocket namespace: `/hospital`, events: `flow:update`, `live:snapshot` (on connect) and `live:update`.

### Data and sign-in
- **Storage:** SQLite via Node's built-in `node:sqlite` (Node 22.13+), file `apps/api/data/hospital.db` (git-ignored, override with `DB_PATH`). Queue events are kept per day, settings and users survive restarts.
- **First start:** when the user table is empty the API creates an administrator from `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Without a password it generates one into `apps/api/data/initial-admin.txt` — change it after signing in.
- **Roles:** `staff` (station actions), `supervisor` (+ per-department settings), `admin` (+ hospital-wide settings, service hours, layout, test clock, user accounts). The API checks every action; the audit trail records the signed-in user's name.
- **Public screens:** `/tv` and the patient page `/q/<token>` need no sign-in (read-only, plus the patient's help request).
- **Patient links:** `/q/<token>` tokens are 128-bit random values issued by the API (`ticket:issue`, staff only), valid until 23:59 of the service day. Staff can re-issue a lost slip (older links, including family links, stop working). A family link is a separate read-only token (`ticket:family`, ≤ 12 h, never past the patient's link). A help request must carry the patient's own valid link.
- Sessions last `SESSION_HOURS` (default 12); 5 failed sign-ins in 5 minutes lock that username/address for 5 minutes.

## Realtime feed
The API pushes a `LiveSnapshot` (see `packages/contracts`) every few seconds: aggregate people per floor
(`"buildingId:level"`) and queue / wait / status per service point. No patient-level data.
- Until an HIS adapter exists, `LiveFeedService` in `apps/api/src/live-feed.service.ts` simulates it (`source: "demo"`).
  Replace it with the adapter's output and set `source: "his-adapter"`.
- The dashboard shows live values while its timeline follows the current time; other hours use the demo daily
  profile. If the API is unreachable it shows "ออฟไลน์" and falls back to the demo profile.

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | web | `http://localhost:4000` | API/WebSocket base URL |
| `WEB_ORIGIN` | api | `http://localhost:3000` | Allowed browser origins (comma-separated); any `localhost` port is also allowed for development |
| `DEMO_FEED` | api | on | Set to `off` to disable the simulated feed |
| `DEMO_FEED_MS` | api | `3000` | Simulated feed interval |

## Suggested monorepo
- `apps/web`: Next.js dashboard and 3D scene
- `apps/api`: NestJS API/WebSocket gateway
- `packages/contracts`: shared DTOs and event contracts
- `packages/scene-data`: building and service-point definitions

## Production milestones
1. Replace demo campus coordinates with authorized CAD/BIM/architectural plans.
2. Establish canonical service-point IDs and queue-state mapping with the HIS owner.
3. Add authenticated ingestion adapter, idempotency, timestamp validation, dead-letter handling, and audit logging.
4. Persist event history and current aggregate state (SQLite now; move to PostgreSQL for multi-server deployments).
5. Add TLS, SSO with the hospital directory, per-station authorisation, observability, retention rules, and security review (basic RBAC and sign-in are in place).
6. Validate counts and wait-time metrics with operations staff before pilot.
