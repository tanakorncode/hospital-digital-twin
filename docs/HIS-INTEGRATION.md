# Connecting the HIS

The twin runs on simulated patients until a hospital system sends real data. Integration is **server-to-server**, through two endpoints protected by a shared token. Nothing in the browser talks to the HIS.

```
HIS (e.g. HOSxP) ── read-only query ──▶ adapter (scripts/his-adapter-example.mjs) ──HTTPS + Bearer token──▶ API /ingest/*
```

## 1. Switch ingestion on
In `apps/api/.env`:
```
INGEST_TOKEN=<long random value>   # node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```
Without a token both endpoints answer `503` (off). A wrong token gets `401`.

## 2. Occupancy and service points — `POST /ingest/live`
Aggregated counts only (no names, HN or diagnoses). Partial updates are fine; missing keys keep their last value.
```bash
curl -X POST https://queue.example.org/ingest/live \
  -H "Authorization: Bearer $INGEST_TOKEN" -H "content-type: application/json" \
  -d '{"at":"2026-10-17T10:15:00+07:00",
       "floors":{"opd:1":310,"opd:2":190},
       "servicePoints":{"pharmacy":{"queue":80,"waitMinutes":26,"status":"busy"}}}'
```
| Field | Meaning | Rule |
|---|---|---|
| `at` | when the counts were taken | within 15 min of server time |
| `floors["<building>:<level>"]` | people on that floor now | whole number 0–20000; buildings `opd`, `er`, `inpatient`, `diagnostics`, `support` |
| `servicePoints["<id>"]` | `queue`, `waitMinutes`, `status` | ids `registration`, `screening`, `clinic`, `lab`, `pharmacy`, `finance`, `radiology`; status `normal` · `busy` · `critical` |

While snapshots keep arriving (at least one a minute) the demo feed stays quiet and the dashboard header shows **HIS** as the source.

## 3. Queue actions — `POST /ingest/queue`
For actions that happen in the HIS rather than on a twin console (e.g. registration finished, pharmacy dispensed). Logged with `by: "HIS"` and broadcast to every screen.
```bash
curl -X POST https://queue.example.org/ingest/queue -H "Authorization: Bearer $INGEST_TOKEN" -H "content-type: application/json" \
  -d '{"at":615,"station":"counter:pharmacy:2","action":"done","patientId":"p-0123","step":7,"key":"his-rx-889812"}'
```
- `at`: minutes since midnight · `action`: `open close call recall start hold return done transfer`
- `key`: the HIS's own id for the action — the same key is accepted only once (safe to retry).
- Station ids: open **/tv** for the list, or `allStations()` in `apps/web/lib/queue.ts`.

## 4. What the hospital needs to decide
1. **Which HIS and how to read it** — a read-only database account or the vendor's API; which tables give arrivals, queue position, room assignment and finished steps.
2. **Patient identity mapping** — today patients come from the simulator (`p-0001…`). Real use needs the HIS visit number mapped to a twin patient id at registration (the kiosk issues the slip and the QR link).
3. **Service-point mapping** — HIS clinic / room / counter codes → twin station ids (`room:opd-201`, `counter:pharmacy:2` …).
4. **Data protection** — the adapter sends aggregates and anonymous ids only; agree retention with the hospital's DPO (PDPA).

`apps/api/scripts/his-adapter-example.mjs` is a working starting point: replace `readFromHis()` with the real query.
