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
pnpm --filter api start:dev
```
WebSocket namespace: `/hospital`, events: `flow:update`, `live:snapshot` (on connect) and `live:update`.

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
4. Persist event history and current aggregate state in PostgreSQL.
5. Add RBAC, TLS, rate limits, observability, retention rules, and security review.
6. Validate counts and wait-time metrics with operations staff before pilot.
