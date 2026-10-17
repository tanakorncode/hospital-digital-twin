# Phase 2 — Implementation Plan (Stage 0: Repository discovery)

สถานะ: ผลการสำรวจ repo จริง ณ commit `a74e0b2` (2026-10-17) · อ้างอิง [Hospital-Digital-Twin-Phase-2-Implementation-Ready.md](Hospital-Digital-Twin-Phase-2-Implementation-Ready.md) (ฉบับล่าสุด) และ [Hospital-Digital-Twin-Phase-2-Spec.md](Hospital-Digital-Twin-Phase-2-Spec.md)
เป้าหมายที่ตกลงแล้ว: **เตรียมนำร่องใช้จริง** (pilot-ready) ไม่ใช่เดโม

รอบนี้ไม่ได้แก้โค้ด schema หรือเทสต์ใด ๆ — สร้างเฉพาะไฟล์นี้
คำว่า **UNVERIFIED** = ยืนยันจากโค้ดไม่ได้ ต้องถามโรงพยาบาลหรือทดสอบจริง

---

## 1. ข้อเท็จจริงของ repo

### 1.1 โครงสร้างและคำสั่ง
| เรื่อง | ข้อเท็จจริง | ที่มา |
|---|---|---|
| Monorepo | pnpm workspace: `apps/web`, `apps/api`, `packages/contracts` | `package.json` |
| คำสั่ง | `pnpm dev`, `pnpm test` (node:test ผ่าน tsx), `pnpm typecheck` | `package.json:5-9` |
| Runtime | Node ≥ 22.13 (ต้องมี `node:sqlite`), เครื่อง dev = v24.21.0, CI = Node 24 | `package.json:15`, `.github/workflows/ci.yml` |
| CI | GitHub Actions: install → typecheck → test | `.github/workflows/ci.yml` |
| API | NestJS 10 + socket.io 4, ไม่มี ORM / validation library | `apps/api/package.json` |
| Contracts | `packages/contracts/src/index.ts` มี type ของ live feed และ QueueEvent แต่ **ไม่มี app ไหน import** (api และ web ประกาศ type ซ้ำเอง) | `packages/contracts/src/index.ts`, `apps/api/src/queue.service.ts:4` |

### 1.2 Baseline tests (รันจริงรอบนี้)
- `pnpm typecheck` → ผ่านทั้ง web และ api
- `pnpm test` → **API 30/30, Web 16/16 = 46/46 ผ่าน**
- ไฟล์: `apps/api/test/{auth,ingest,line,queue,tickets}.test.ts`, `apps/web/test/{queue,simulation}.test.ts`

### 1.3 ฐานข้อมูล
- SQLite ไฟล์เดียวผ่าน `node:sqlite` (`DatabaseSync`, **synchronous**), `PRAGMA journal_mode = WAL`, `foreign_keys = ON` — `apps/api/src/db.service.ts:17-20`
- **ไม่มีระบบ migration**: แต่ละ service รัน `CREATE TABLE IF NOT EXISTS` ใน constructor
- ตารางที่มี:

| ตาราง | สร้างที่ | ใช้ทำอะไร |
|---|---|---|
| `queue_events (day, seq, id, body JSON)` | `db.service.ts:21-23` | log การกระทำกับคิว รายวัน (append-only ยกเว้นตอน reset) |
| `kv` | `db.service.ts:24` | settings (`queue.settings`) |
| `users`, `sessions` | `db.service.ts:25-38` | บัญชีเจ้าหน้าที่ / session (เก็บ SHA-256 ของ token) |
| `tickets` | `tickets.service.ts:24-35` | **ลิงก์หน้าคิวผู้ป่วย `/q/<token>`** (ไม่ใช่บัตรคิว) |
| `line_codes`, `line_links` | `line.service.ts:33-39` | รหัส 6 หลัก / การผูก LINE userId กับลิงก์ของวันนั้น |

- Transaction: `DatabaseSync` ไม่มี helper transaction แต่ใช้ `db.exec('BEGIN IMMEDIATE')` / `COMMIT` / `ROLLBACK` ได้ และเพราะ API เป็น synchronous ในโปรเซสเดียว คำสั่งเขียนทั้งหมดจึงทำทีละคำสั่งอยู่แล้ว (ไม่มี interleave ระหว่าง `await`) — ความเสี่ยงจองเกินโควตาจะเกิดเฉพาะเมื่อมีหลายโปรเซสหรือมี `await` คั่นกลาง transaction
- `busy_timeout` ยังไม่ได้ตั้ง (ไม่จำเป็นเมื่อมี writer โปรเซสเดียว แต่ต้องตั้งถ้า backup/สคริปต์อื่นเขียนพร้อมกัน)
- Backup: `apps/api/scripts/backup.mjs` ใช้ `VACUUM INTO` เก็บ 14 ชุด — **ยังไม่เคยทดสอบ restore** (UNVERIFIED)

### 1.4 Queue engine — ลำดับการสร้างคิวจริง
**ไม่มีการ "สร้างคิว" บนเซิร์ฟเวอร์เลย** นี่คือข้อค้นพบที่สำคัญที่สุด

1. คนไข้ทั้งหมดถูกสร้างใน **browser** โดย `generatePatients('demo-day')` (`apps/web/lib/patients.ts:180`) — สุ่มแบบ deterministic ทั้งวัน รวมเลขคิว (`patients.ts:366`), HN, ขั้นตอนทั้งหมดล่วงหน้า (registration → screening → exam → lab → … → pharmacy)
2. ทุกหน้าจอสร้างชุดเดียวกันเอง: dashboard (`HospitalDashboard.tsx:224`), TV (`app/tv/page.tsx:25`), หน้าผู้ป่วย (`app/q/[token]/page.tsx:40`)
3. เซิร์ฟเวอร์เก็บแค่ **คำสั่งที่ทำกับคนไข้เหล่านั้น** (`call/recall/start/hold/return/done/transfer/report/resolve…`) ผ่าน `QueueService.apply` (`queue.service.ts:59-86`)
4. Browser นำ log มาซ้อนทับผลจำลองด้วย `applyQueueEvents` (`apps/web/lib/queue.ts:82`)
5. `POST /ingest/queue` จาก HIS ส่งได้เฉพาะคำสั่งกับ `patientId` ที่มีอยู่แล้ว (`ingest.controller.ts:13,36-46`)

ผลคือ:
- **ไม่มีคำสั่ง "รับคนไข้เข้าคิว"** — คนไข้จริงหรือคนไข้ที่จองไว้เข้าระบบไม่ได้
- ขั้นตอนของคนไข้ถูก "รู้ล่วงหน้า" ทั้งวัน ซึ่งไม่จริงกับคนไข้จริง (แพทย์สั่ง lab/x-ray ระหว่างตรวจ)
- ถ้าเปลี่ยนเวลาให้บริการ/แผนก log ของวันถูกล้าง เพราะผลจำลองเปลี่ยน (`queue.service.ts:116-127`) — ยอมรับไม่ได้เมื่อเป็นข้อมูลจริง

Idempotency ที่มีอยู่: `key` ของคำสั่ง (กันตัวช่วยอัตโนมัติหลายจอทำซ้ำ, `queue.service.ts:69`), กันเรียกคนไข้คนเดียวกันสองจุด (`:79-84`), client dedupe ด้วย `id` (`apps/web/lib/queue.ts:429`)

### 1.5 ตัวตน / RBAC / audit
- เจ้าหน้าที่: 3 role `staff < supervisor < admin` (`flow.gateway.ts:12-20`), scrypt, ล็อกเมื่อผิด 5 ครั้ง/5 นาที (`auth.service.ts:12-13`), session 12 ชม.
- **ไม่มีสิทธิ์ราย "หน่วยบริการ"** — staff ทุกคนสั่งได้ทุกจุด
- **ไม่มีตัวตนผู้ป่วย**: `patientId` คือ id ของคนไข้จำลอง (`p-0001`, `e-0001`, `w-201`) ตรวจรูปแบบที่ `flow.gateway.ts:92`
- สิทธิ์ผู้ป่วย = ถือลิงก์ `tickets` ที่เจ้าหน้าที่ออก (128-bit, หมดอายุสิ้นวัน, ออกใหม่แล้วลิงก์เก่าใช้ไม่ได้) — `tickets.service.ts`
- Audit: `by` ในทุก queue event ถูก override ด้วยชื่อผู้ล็อกอิน (`flow.gateway.ts:135`), settings มี event `config` ในวันเดียวกัน — **ไม่มี audit ของการแก้ผู้ใช้** (UNVERIFIED ว่าพอสำหรับโรงพยาบาลไหม)

### 1.6 Socket.IO
- namespace `/hospital`; on connect ส่ง `auth:me`, `features`, `flow:snapshot`, `live:snapshot`, `queue:events`, `queue:settings` ให้**ทุกการเชื่อมต่อรวมถึงที่ไม่ได้ล็อกอิน** (`flow.gateway.ts:46-56`)
- ทุก event ที่สำเร็จ broadcast ด้วย `server.emit` ไปทุกคน (`flow.gateway.ts:137,149`, `ingest.controller.ts:43`)
- ไม่มี room ต่อผู้ป่วย / ต่อหน่วยบริการ
- Rate limit ต่อ socket: command 120/10 วิ, public 20/นาที, login 10/นาที (`flow.gateway.ts:24`)

### 1.7 LINE
- มี: webhook ตรวจลายเซ็น HMAC (`line.service.ts:61-66`, `line.controller.ts`), ผูกด้วยรหัส 6 หลัก 15 นาที, push เมื่อ call/recall/transfer/รับเรื่อง, "หยุด" = ยกเลิก
- การผูกมีอายุ **เท่าลิงก์ของวันนั้น** (ผูกกับ `ticket`) ไม่ใช่การผูกบัญชีถาวร
- **ไม่มี**: LIFF, ตรวจ LIFF ID token, Rich menu, chatbot intent อื่น, retry/dedupe ของการส่ง (ยิง `fetch` ตรงในขณะประมวลผลคำสั่ง, `line.service.ts:106-113`)

### 1.8 หน้าที่ต้องไม่เสีย (non-regression)
`/` (dashboard ทุกหน้า), `/tv` (index, `?floor`, `?dept`, `?station`), `/q/<token>`, `/real-map`, `/real-map-3d`, `POST /ingest/live|queue`, `POST /line/webhook`, `GET /health`, backup script, Docker/Caddy

---

## 2. ความเสี่ยงที่พบในเฟส 1 (ต้องแก้ก่อนใช้ข้อมูลจริง)

| # | ความเสี่ยง | ที่มา | ทำไมสำคัญเมื่อเป็นข้อมูลจริง |
|---|---|---|---|
| R1 | หน้าสาธารณะ (TV, `/q`) **คำนวณคนไข้ทุกคนใน browser** | `tv/page.tsx:25`, `q/[token]/page.tsx:40` | ถ้าคนไข้มาจากเซิร์ฟเวอร์ จอสาธารณะจะได้ HN/ข้อมูลของทุกคน → ละเมิด PDPA ต้องให้เซิร์ฟเวอร์ส่งเฉพาะ "projection" ที่จำเป็น |
| R2 | `queue:events` ส่งให้ socket ที่ไม่ล็อกอิน มี `by` (ชื่อเจ้าหน้าที่), เหตุผล, `patientId` | `flow.gateway.ts:54,137` | ใครเปิด socket ก็ดู log ทั้งวันได้ |
| R3 | ไม่มีคำสั่งรับคนไข้เข้าคิว / ขั้นตอนรู้ล่วงหน้า | §1.4 | เชื่อม booking/check-in/HIS จริงไม่ได้ |
| R4 | เปลี่ยนเวลา/แผนกแล้วล้าง log ของวัน | `queue.service.ts:116-127` | ข้อมูลจริงหาย |
| R5 | ไม่มีสิทธิ์รายหน่วยบริการ | `flow.gateway.ts:19-20` | สเปกต้องการจำกัด staff ตามหน่วย |
| R6 | การส่ง LINE ไม่มี retry/คิวงาน | `line.service.ts:106-113` | ข้อความหายเงียบ |
| R7 | ไม่มี migration | §1.3 | เปลี่ยน schema ตารางเดิมไม่ได้อย่างปลอดภัย |
| R8 | restore ยังไม่เคยทดสอบ | `scripts/backup.mjs` | สเปกข้อ 15 |
| R9 | **บั๊กเฟส 1:** Caddy ไม่ส่ง `/line/*` และ `/ingest/*` ไป API (ตกไปที่ web → 404) | `deploy/Caddyfile:7-10` | LINE webhook และ HIS ingest ใช้ไม่ได้เมื่อ deploy ผ่าน Caddy — แก้เป็นงานแรกของขั้น 2.0 |

---

## 3. Mapping: สเปก → ของที่มี → ช่องว่าง → สิ่งที่เสนอ

| ฟีเจอร์ในสเปก | ที่มีอยู่ | ช่องว่าง | ข้อเสนอ |
|---|---|---|---|
| Queue Engine "createTicket" | log คำสั่งกับคนไข้จำลอง | ไม่มีการเพิ่มคนไข้ | **Visit model บนเซิร์ฟเวอร์** (§4.1) + action `enter` |
| Queue Ticket | — (`tickets` = ลิงก์) | ชื่อชน | เรียกของใหม่ว่า `visits` / เลขคิว; คง `tickets` = access link |
| patient_profiles | — | ทั้งหมด | ตารางใหม่ ใช้ `external_patient_id` (HN จาก HIS) เมื่อเชื่อม |
| line_patient_links | `line_links` (ต่อวัน) | ไม่ถาวร ไม่ verify | ตารางใหม่แยก; คง `line_links` สำหรับแจ้งเตือนรายวันจากบัตรคิว |
| LIFF token verify | — | ทั้งหมด | `POST /patient/line/session` ตรวจ ID token กับ LINE (verify endpoint) แล้วออก patient session |
| Booking / slots / quota | — | ทั้งหมด | ตารางใหม่ตามสเปก §6 (ตัด `domain_events` ออกในรอบแรก) |
| Appointment / schedule | live feed `duty` (แพทย์ประจำห้อง) | ไม่มีตารางนัด | ตารางใหม่; แพทย์ = `provider_code` จาก HIS (UNVERIFIED) |
| Check-in | — | ทั้งหมด | `check_in_records` + `enter` ใน queue log แบบ idempotent (`source_type+source_id` unique) |
| Notification worker | push ตรง | retry/dedupe | `notification_jobs` + worker ใน process (setInterval) ส่งหลัง commit |
| RBAC รายหน่วย | 3 role | ขอบเขตหน่วย | เพิ่ม `user_units` (ว่าง = ทุกหน่วย เพื่อไม่ทำให้ของเดิมเสีย) |
| Audit | `by` ใน queue event | booking/appointment/override | ตาราง `audit_log` กลาง (actor, action, resource, reason, at) |
| REST `/api/v1/...` | Socket.IO เป็นหลัก, REST เฉพาะ ingest/line/health | convention | **ผู้ป่วย/LIFF ใช้ REST** (ง่ายกับ idempotency header, cache, LIFF) · เจ้าหน้าที่คงใช้ socket ตามเดิม + REST สำหรับ admin ใหม่ |
| Wayfinding destinations | `deptDirectory`, `findDepts` ใน `apps/web/lib/scene-data.ts`; หน้า `/real-map` | ไม่มี public destination code | ตาราง `destinations` (code → อาคาร/ชั้น/map node) + หน้า `/wayfinding?to=` |
| Feature flags | `features` event (`line`) | ทีละฟีเจอร์ | ขยาย `features` + ค่าใน settings |
| Migration | `CREATE IF NOT EXISTS` | versioning | `schema_migrations` + ไฟล์ SQL เรียงเลข รันตอนเริ่ม (§5) |

---

## 4. การออกแบบที่เสนอ (ยังไม่ implement)

### 4.1 Visit model — แกนที่ต้องทำก่อนทุกอย่าง
เพิ่มแนวคิด **visit** = การมารับบริการหนึ่งครั้งของคนไข้จริง เก็บบนเซิร์ฟเวอร์:

```
visits(id, day, queue_number, patient_profile_id NULL, source_type, source_id,
       flow, clinic_key, priority, status, current_step, created_at, ...)
queue_counters(day, prefix, last_no)   -- ออกเลขคิวแบบ atomic
```

- queue log ได้ action ใหม่ `enter` (รับเข้าคิว) และ `step` (เพิ่มขั้นตอนถัดไป เช่น แพทย์ส่ง lab) — ขั้นตอนไม่ต้องรู้ล่วงหน้า
- **โหมดข้อมูล** ใน settings: `demo` (เหมือนเดิมทุกอย่าง) / `live` (ไม่มีคนไข้จำลอง ใช้ visits เท่านั้น) / `mixed` (ทั้งสอง สำหรับซ้อมกับเจ้าหน้าที่)
- Web: `generatePatients` ใช้เฉพาะโหมด demo; โหมด live สร้าง `Patient[]` จาก visits + log ด้วยตัวแปลงตัวเดียว เพื่อให้แผนที่ 3D, คอนโซล, TV ใช้ type `Patient` เดิมได้
- เวลาคาดการณ์ (ETA) ในโหมด live คำนวณจากคิวจริงข้างหน้า × เวลาให้บริการเฉลี่ยของจุดนั้น (มีฟังก์ชันคล้ายกันใน `apps/web/lib/queue.ts` `serviceMinutes`)

### 4.2 Projection สำหรับหน้าสาธารณะ (แก้ R1, R2)
- TV ได้รับเฉพาะ `{queue_number, station, status}` ของจุดที่แสดง — ไม่มี HN, ชื่อ, `by`
- `/q/<token>` และ LIFF ได้รับเฉพาะ visit ของตัวเอง + จำนวนคิวก่อนหน้า + ETA
- socket ที่ไม่ล็อกอินไม่ได้รับ `queue:events` เต็มอีกต่อไป (ในโหมด live; โหมด demo คงพฤติกรรมเดิมเพื่อไม่ให้ Phase 1 เสีย)

### 4.3 Booking → Check-in → Queue
```
POST /bookings (Idempotency-Key) ─ BEGIN IMMEDIATE ─ UPDATE slot ... WHERE reserved<capacity ─ INSERT booking ─ COMMIT
                                                                                   └→ notification_jobs (ใน transaction เดียวกัน)
check-in (Kiosk สแกน / เจ้าหน้าที่ / LIFF + ตำแหน่ง?) ─ BEGIN ─ check_in_records UNIQUE(source_type, source_id)
                                                     ─ queue_counters +1 ─ INSERT visit ─ append queue_event 'enter' ─ COMMIT
                                                     └→ broadcast หลัง commit
```
- เพราะ visit และ queue log อยู่ใน DB เดียวกัน **check-in เป็น transaction เดียว** ไม่มีปัญหา timeout ระหว่าง booking กับ queue engine (สเปก §7.4) ในโหมดที่ queue อยู่ในระบบนี้
- ถ้าภายหลัง HIS เป็นเจ้าของเลขคิว: เพิ่ม adapter แบบสเปก §7.4 (lookup ก่อน retry) — UNVERIFIED ว่า HIS มี API นี้
- ลำดับคิวของคนที่จอง: อิงเวลาช่วงที่จอง (ไม่ใช่เวลามาถึง) — กติกาสุดท้ายรอโรงพยาบาล

### 4.4 ตัวตนผู้ป่วยและการผูก LINE
1. LIFF ส่ง ID token → API ตรวจกับ LINE → ได้ `line_subject` → ออก patient session (เก็บ hash เหมือน staff)
2. ยังไม่ผูก → เลือกวิธียืนยัน (รอโรงพยาบาลเลือก):
   - **ก. เจ้าหน้าที่ช่วยยืนยัน** (แนะนำสำหรับนำร่อง): ผู้ป่วยแสดง QR ผูกบัญชีในหน้า LIFF → เจ้าหน้าที่สแกนที่เคาน์เตอร์ ตรวจบัตรประชาชนตามกระบวนการเดิม → ผูก ไม่มีค่า SMS ไม่ต้องรอ HIS
   - ข. OTP ไปเบอร์ที่ลงทะเบียนใน HIS (ต้องมีผู้ให้บริการ SMS และ HIS API)
   - ค. ThaID / ระบบยืนยันตัวตนภาครัฐ (UNVERIFIED ว่าโรงพยาบาลเข้าร่วมได้)
3. ตัวเลือกเสริม: ผูกจากบัตรคิววันนี้ — สแกน QR บัตรคิว (เจ้าหน้าที่ตรวจตัวตนแล้วตอนลงทะเบียน) แล้วเลือก "จำบัญชีนี้" → ผูกถาวร ใช้กลไก `tickets` ที่มีอยู่

### 4.5 Notification
- `notification_jobs` insert ใน transaction เดียวกับการเปลี่ยนสถานะ (= outbox แบบง่าย ไม่ต้องมี `domain_events` แยก)
- worker ใน process API อ่านงานที่ถึงเวลา → ส่ง → `SENT`/`RETRY` (backoff + jitter, สูงสุด 5 ครั้ง)/`FAILED`
- ข้อความ: เลขคิว + ที่ไป หรือ "มีการยืนยันการจอง เปิดดูรายละเอียด" — ไม่มีชื่อ/HN/อาการ (เหมือนเฟส 1)
- ย้ายการแจ้งเตือนคิวเดิม (`line.service.ts:91`) มาใช้ worker เดียวกัน

---

## 5. Migration ที่เสนอ (ยังไม่สร้าง)

กลไก: ตาราง `schema_migrations(version, applied_at)` + โฟลเดอร์ `apps/api/migrations/NNN-name.sql` รันเรียงตอนเริ่ม API ใน transaction ทีละไฟล์; ตารางเฟส 1 ที่มี `CREATE IF NOT EXISTS` อยู่แล้วนับเป็น version 0 ไม่แตะ

| # | ไฟล์ | เนื้อหา |
|---|---|---|
| 001 | `visits` | `visits`, `queue_counters` |
| 002 | `patients` | `patient_profiles`, `line_patient_links`, `patient_sessions`, `link_requests` |
| 003 | `booking` | `booking_policies`, `booking_slots`, `bookings` (+ partial unique index active booking ต่อคน/บริการ/วัน) |
| 004 | `appointments` | `provider_schedules`, `appointment_slots`, `appointments`, `appointment_reschedule_requests` |
| 005 | `checkin` | `check_in_records` |
| 006 | `notify` | `notification_jobs`, `notification_logs` |
| 007 | `ops` | `audit_log`, `user_units`, `destinations`, `idempotency_keys` |

หลักการ: เวลาเก็บเป็น ISO UTC, แสดงเป็น Asia/Bangkok · `request_hash` คำนวณฝั่งเซิร์ฟเวอร์ · ไม่เก็บ token/OTP plaintext · ไม่มี PHI ใน payload ของ job

---

## 6. API ที่เสนอ (ให้ตรง convention ของ repo)

- Prefix: `/api/v1` สำหรับ REST ใหม่ (ingest/line/health เดิมคงที่เดิม)
- Caddy ปัจจุบันส่งเฉพาะ `/socket.io/*` และ `/health` ไป API (`deploy/Caddyfile:7-8`) → ต้องเพิ่ม `/api/*` (ดู R9)
- Validation: ทำมือแบบเดิม (ไม่มี class-validator) — เสนอให้คงแบบเดิมเพื่อไม่เพิ่ม dependency
- Error format: `{ ok:false, code, reason }` (เพิ่ม `code` ให้ตรงสเปก §8.4 แต่คง `reason` ภาษาไทยที่หน้าเว็บใช้อยู่)
- เจ้าหน้าที่: socket event ใหม่ `booking:*`, `checkin:*` ตามรูปแบบ `queue:command` เดิม ตรวจสิทธิ์ด้วย `may()`

---

## 7. ลำดับงาน, dependency, เกณฑ์ผ่าน

| ขั้น | งาน | ขึ้นกับ | เกณฑ์ผ่าน |
|---|---|---|---|
| **2.0 Foundation** | แก้ R9 (Caddy), migration runner, `audit_log`, `idempotency_keys`, error `code`, transaction helper | — | 46 เทสต์เดิมผ่าน + เทสต์ migration รันซ้ำได้ |
| **2.1 Visit model** | visits, `enter`/`step`, โหมด demo/live/mixed, ตัวแปลง visits→Patient, projection สาธารณะ | 2.0 | โหมด demo เหมือนเดิม 100% (เทสต์เดิม) · โหมด live: รับคนไข้ → เรียก → เสร็จ บนคอนโซล/TV/`/q` · TV payload ไม่มี HN |
| **2.2 Booking + quota** | policies, slots, bookings, cancel คืน quota ครั้งเดียว, idempotency | 2.0 | concurrency test capacity 1/N, key ซ้ำ, cancel ซ้ำ |
| **2.3 Check-in** | Kiosk/เจ้าหน้าที่สแกน → visit แบบ idempotent | 2.1, 2.2 | check-in ซ้ำได้ visit เดียว · ลำดับตามช่วงเวลาที่จอง |
| **2.4 Appointment** | schedules, slots, appointments, ขอเลื่อน (รออนุมัติ), cutoff | 2.2 | state transition tests · ไม่มี NO_SHOW จาก LINE |
| **2.5 LINE identity** | LIFF session, ผูกบัญชี (วิธี ก.), unlink, rate limit | 2.0 + **การตัดสินใจ D1** | token ปลอม/หมดอายุถูกปฏิเสธ · A อ่านของ B ไม่ได้ |
| **2.6 LIFF screens** | คิวของฉัน, จอง, นัด, แผนที่, ผูกบัญชี | 2.3–2.5 | mobile viewport, loading/empty/error, ตัวใหญ่ คอนทราสต์สูง |
| **2.7 Staff console + notify** | รายการจอง/นัดวันนี้, check-in, override + เหตุผล, คำขอเลื่อน, worker | 2.3–2.5 | override ต้องมีสิทธิ์+เหตุผล+audit · retry/dedupe tests |
| **2.8 Wayfinding QR** | destinations, `/wayfinding?to=`, หน้าพิมพ์ป้าย | 2.0 | QR ไม่มีข้อมูลผู้ป่วย · มี text fallback |
| **2.9 Pilot hardening** | ทดสอบ restore, load, security, PDPA review, คู่มือเจ้าหน้าที่ | ทั้งหมด | ตามสเปก §16 "Acceptance criteria ก่อน pilot" |

ขั้น 2.1 ใหญ่และเสี่ยงที่สุดเพราะแตะทุกหน้าของเฟส 1 — แนะนำทำก่อน booking เพราะ booking ไม่มีประโยชน์ถ้าคนที่จองเข้าคิวไม่ได้

---

## 8. คำถามที่โค้ดตอบไม่ได้ (ต้องให้โรงพยาบาล/เจ้าของผลิตภัณฑ์ตัดสิน)

| # | คำถาม | กระทบขั้น |
|---|---|---|
| D1 | วิธียืนยันตัวตนตอนผูก LINE: เจ้าหน้าที่ช่วย / OTP / ThaID | 2.5 |
| D2 | HIS มี API: ค้นผู้ป่วย, นัดหมาย, ออกเลขคิว/visit หรือไม่ · ใครเป็นเจ้าของเลขคิว | 2.1, 2.3 |
| D3 | แผนกนำร่อง, จองล่วงหน้ากี่วัน, โควตาต่อช่วง | 2.2 |
| D4 | ผู้ป่วยเลือกแพทย์เองได้ไหม, cutoff ยกเลิก/เลื่อน, ต้องอนุมัติไหม | 2.4 |
| D5 | คนที่จองแทรกคิวหน้างานอย่างไร (ตามเวลาจอง / สัดส่วน / ช่องแยก) | 2.3 |
| D6 | check-in ด้วยตัวเองผ่าน LIFF ได้ไหม หรือต้องสแกนที่ Kiosk/เจ้าหน้าที่เท่านั้น | 2.3 |
| D7 | ข้อความใดส่งทาง LINE ได้, consent/opt-out, retention ของแต่ละตาราง | 2.5, 2.7 |
| D8 | ใครเป็น owner ของ slot/ตารางแพทย์ และใคร override ได้ (map กับ role เดิมหรือเพิ่มสิทธิ์รายหน่วย) | 2.2, 2.7 |
| D9 | server/โดเมน/LINE OA ของโรงพยาบาล และผู้รับผิดชอบ incident | 2.9 |

ระหว่างรอคำตอบ ขั้น 2.0, 2.1, 2.2 (กติกาตั้งค่าได้) และ 2.8 ทำได้ทันที

---

## 8.1 ความคืบหน้า

### ✅ ขั้น 2.0 Foundation — เสร็จ (2026-10-17)
| งาน | ไฟล์ | หมายเหตุ |
|---|---|---|
| แก้ R9: Caddy ส่ง `/line/*`, `/ingest/*`, `/api/*` ไป API | `deploy/Caddyfile`, `docs/DEPLOY.md` | |
| Migration runner + `schema_migrations` | `apps/api/src/migrations.ts`, `db.service.ts` (`migrate`, `schemaVersion`) | migration เป็น TS (ติดไปกับ `dist` ไม่ต้อง copy ไฟล์ SQL) · migration 1 = `audit_log`, `idempotency_keys` · ตารางเฟส 1 = version 0 ไม่แตะ |
| Transaction helper | `db.service.ts` `tx()` | `BEGIN IMMEDIATE`, rollback เมื่อ throw, ซ้อนกันได้, ปฏิเสธ async · `busy_timeout = 5000` |
| Error convention | `apps/api/src/errors.ts` | `{ok:false, code, reason}` + `AppError` + filter สำหรับ REST · คำตอบเดิม (FORBIDDEN, AUTH_REQUIRED, RATE_LIMITED) ได้ `code` เพิ่ม `reason` ไทยเหมือนเดิม |
| Idempotency | `apps/api/src/idempotency.service.ts` | key ต่อ scope, hash จาก canonical request ฝั่งเซิร์ฟเวอร์, เก็บ 7 วัน, ไม่เก็บผลที่ล้มเหลว |
| Audit log | `apps/api/src/audit.service.ts` | actor เป็น `user:<id>` · กรอง key ที่เป็นความลับ/ตัวตนออกอัตโนมัติ · บันทึกแล้ว: สร้าง/แก้ผู้ใช้, แก้ตั้งค่า, ออกบัตรคิวใหม่, เปิด/ปิดสวิตช์ |
| Feature flags `phase2.*` | `apps/api/src/features.service.ts` | 6 สวิตช์ตามเอกสาร §18 ปิดทั้งหมดโดยค่าเริ่มต้น · socket `features:set` / `audit:list` (admin) · `features` event ได้ `phase2` เพิ่ม |
| Request id | `apps/api/src/main.ts` | header `x-request-id` ทุก HTTP request |
| Tests | `apps/api/test/foundation.test.ts` | +11 ข้อ รวม concurrency จริง 2 connection บนไฟล์เดียวกัน → **API 41 + Web 16 = 57/57 ผ่าน** |

ยังไม่ทำในขั้นนี้ (ตั้งใจ): หน้าเว็บสำหรับเปิด/ปิดสวิตช์และดู audit (รอพร้อมหน้าจอเจ้าหน้าที่ขั้น 2.7), `domain_events` แยก (ใช้ `notification_jobs` ใน transaction เดียวกันแทน ตาม §4.5)

### ✅ ขั้น 2.1 Visit model — เสร็จ (2026-10-17)
| งาน | ไฟล์ | หมายเหตุ |
|---|---|---|
| ตาราง `visits`, `queue_counters` (migration 2) | `apps/api/src/migrations.ts`, `visits.service.ts` | เลขคิวออกจากเซิร์ฟเวอร์ใน transaction เดียวกับ visit · 1 visit ต่อ source (VN ของ HIS / booking ภายหลัง) · **ไม่มีชื่อ/HN** |
| คำสั่งเจ้าหน้าที่ `visit:enter` / `visit:step` / `visit:cancel` | `flow.gateway.ts` | idempotent (key จากฟอร์ม), audit, ยกเลิกต้องมีเหตุผล |
| รับจาก HIS `POST /ingest/visit`, `/ingest/visit/step` | `ingest.controller.ts` | ส่ง VN เดิมซ้ำได้ visit เดิม |
| โหมดข้อมูล `dataMode: demo/live` (admin) | `queue.service.ts`, Settings → "ข้อมูลผู้ป่วย" | live: ไม่มีผู้ป่วยจำลอง · **แก้ R4** — เปลี่ยนเวลา/แผนกไม่ล้าง log |
| ตรวจคำสั่งคิวของผู้ป่วยจริง | `queue.service.ts` | ต้องมี visit วันนี้และขั้นตอนนั้นจริง |
| **แก้ R2** — สตรีมสาธารณะไม่มีชื่อเจ้าหน้าที่ | `flow.gateway.ts` | staff อยู่ใน room `staff` ได้ log เต็ม · จอ/หน้าผู้ป่วยได้ log ที่ตัด `by` |
| เว็บ: ผู้ป่วยจริงใช้ type `Patient` เดิม | `apps/web/lib/patients.ts` `livePatients`, `queue.ts` `basePatients` | ทุกขั้นเริ่มเมื่อขั้นก่อนหน้าเสร็จ ไม่มีการเดาเวลา · หลังขั้นสุดท้ายเดินออก |
| UI | `components/pages/LiveVisit.tsx` | "รับผู้ป่วยเข้าคิว" (คลินิก/ER/คิวพิเศษ → เลขคิว + QR) · แถบ "ส่งต่อ" (เจาะเลือด, เอกซเรย์, ฟังผล, รับยา, ชำระเงิน, ยกเลิกคิว) · ตัวเลขแถบบนเป็นค่าจริง |
| Tests | `apps/api/test/visits.test.ts`, `apps/web/test/live.test.ts` | **API 53 + Web 22 = 75/75 ผ่าน** · ทดสอบในเบราว์เซอร์ (headless) ครบวงจร: รับเข้าคิว → เรียก → ให้บริการ → ส่งต่อ → หน้า `/q` → จอทีวี และโหมดสาธิตยังเหมือนเดิม |

เรื่อง R1 (หน้าสาธารณะคำนวณจากข้อมูลทุกคน): แก้โดยออกแบบให้ visit ไม่มีข้อมูลระบุตัวตนเลย (เลขคิว คลินิก ขั้นตอน คิวพิเศษ) ข้อมูลตัวตนจะอยู่ใน `patient_profiles` (ขั้น 2.5) ซึ่งไม่ส่งออก socket สาธารณะ

ข้อจำกัดที่ยังเหลือ (ตั้งใจ):
- ภาพฝูงชน/ความหนาแน่นบนแผนที่ยังมาจาก demo live feed จนกว่า HIS ส่ง `/ingest/live` (หรือปิดด้วย `DEMO_FEED=off`)
- หน้าสถิติ/ศูนย์อัจฉริยะบางส่วนยังคำนวณจากวันจำลอง (มีป้าย "ข้อมูลจำลอง")
- ผู้ป่วยจริงยังไม่มีเพศ/อายุ (ใช้แค่วาดหุ่นบนแผนที่) — ไม่เก็บโดยเจตนา

### ✅ ขั้น 2.2 Booking + quota — เสร็จ (2026-10-17)
| งาน | ไฟล์ | หมายเหตุ |
|---|---|---|
| `patient_profiles`, `booking_policies`, `booking_slots`, `bookings` (migration 3) | `apps/api/src/migrations.ts` | idempotency ใช้ตาราง `idempotency_keys` กลาง (ไม่มีคอลัมน์ key ในตาราง bookings) · สถานะตามเอกสาร Implementation-Ready (ไม่มี PENDING/REJECTED) |
| `BookingService` | `apps/api/src/booking.service.ts` | กติกาต่อคลินิก (มี version) · สร้างช่วงเวลาตามช่วงวัน/วันในสัปดาห์ (ซ้ำได้) · จองด้วย conditional update ใน `BEGIN IMMEDIATE` · ยกเลิกคืนที่ครั้งเดียว · หลัง cut-off ต้องเป็นหัวหน้างาน + เปิด `staffOverrides` · ยกเลิกทั้งช่วงพร้อมเหตุผล · หมดอายุเมื่อเลยวัน (ไม่ใช่ no-show) |
| คำสั่ง socket `booking:*` | `flow.gateway.ts` | admin: กติกา/ช่วงเวลา · staff: จอง (ต้องเปิด `generalBooking`), ยกเลิก, ค้นหา · ค้นด้วย HN ถูกบันทึก audit โดยไม่เก็บ HN · `booking:changed` ส่งเฉพาะ room staff |
| UI | `apps/web/components/pages/Booking.tsx` | ตั้งค่า → "การจองล่วงหน้า" (สวิตช์ระบบ, กติกาต่อคลินิก, สร้าง/ดู/ปิด/ยกเลิกช่วงเวลา) · ติดตามคิว → แท็บ "การจอง" (จองให้ผู้ป่วยด้วย HN, รายการต่อวัน, ค้นด้วยรหัส BK/HN, ยกเลิก) |
| บั๊กที่พบระหว่างทำ | `db.service.ts` | `busy_timeout` ตั้งหลังคำสั่งสร้างตาราง → เปิดหลาย connection พร้อมกันได้ "database is locked" · ย้ายเป็นคำสั่งแรกแล้ว |
| Tests | `apps/api/test/booking.test.ts` | +13 ข้อ รวม **10 thread แย่ง 3 ที่บนไฟล์ SQLite เดียวกัน ได้ 3 พอดี** (รันซ้ำ 6 รอบผ่านทุกรอบ) → **API 66 + Web 22 = 88/88** · ทดสอบในเบราว์เซอร์ครบวงจร |

ช่องทางผู้ไม่มีสมาร์ตโฟน: เจ้าหน้าที่จองให้ทางเคาน์เตอร์/โทรศัพท์ได้แล้ว (ตรวจบัตรตามขั้นตอนเดิม เก็บเฉพาะ HN)

ค่าตั้งต้นที่ใช้ระหว่างรอโรงพยาบาลตัดสิน (D3, D4) — ปรับได้ในหน้าตั้งค่าทุกค่า: จองล่วงหน้า 14 วัน · ยกเลิกก่อน 1 ชม. · 1 การจองค้างต่อคนต่อคลินิก

### ✅ ขั้น 2.3 Check-in — เสร็จ (2026-10-17)
| งาน | ไฟล์ | หมายเหตุ |
|---|---|---|
| `check_in_records`, ตัวอักษรคิวและช่วงเวลาเช็กอินต่อคลินิก, visit จำผู้ป่วย/เวลาที่จอง (migration 4) | `apps/api/src/migrations.ts` | `patient_profile_id` ของ visit ไม่ถูกส่งออกจอใด ๆ |
| `CheckInService` | `apps/api/src/checkin.service.ts` | booking → visit → record ใน **transaction เดียว** (queue engine อยู่ใน DB เดียวกัน จึงไม่มีกรณี timeout กลางทางแบบสเปก §7.3) · เช็กอินซ้ำได้คิว/QR เดิม · ตู้: เฉพาะในช่วง (ก่อน 120 นาที – หลังจบ 60 นาที, ปรับได้) · เคาน์เตอร์: ช่วยคนมาก่อน/สายได้ในวันเดียวกัน (บันทึกว่า late) |
| คำสั่ง `checkin:booking` | `flow.gateway.ts` | ต้องเป็นโหมดผู้ป่วยจริง · audit · ออกลิงก์ `/q` ให้ทันที |
| UI | `components/CheckInCard.tsx`, `app/kiosk/page.tsx`, `components/pages/Booking.tsx` | **ตู้เช็กอิน `/kiosk`** (ล็อกอินบัญชีตู้ครั้งเดียว · ปุ่มใหญ่ · ใช้เครื่องอ่านบาร์โค้ดได้ · กลับหน้าแรกเองใน 45 วิ · พิมพ์บัตรคิว) · ปุ่ม "เช็กอิน" ในแท็บการจอง · ป้าย "จอง 09:00–10:00" ในคอนโซล |
| Tests | `apps/api/test/checkin.test.ts` | +7 ข้อ รวม rollback ทั้งหมดเมื่อออกเลขคิวไม่ได้ → **API 73 + Web 22 = 95/95** · ทดสอบในเบราว์เซอร์: ตู้ (รหัสผิด → รหัสถูกได้ A002 → เช็กอินซ้ำได้ A002 เดิม) และเคาน์เตอร์ (A003) |

ลำดับคิวของคนที่จอง (D5): ตอนนี้เข้าคิวตามเวลาเช็กอิน มีป้ายเวลาจองให้เจ้าหน้าที่เห็น — กติกาแทรกคิว (ตามเวลาจอง/สัดส่วน/ช่องแยก) รอโรงพยาบาลเลือก

### ✅ ขั้น 2.4 Appointment — เสร็จ (2026-10-17)
| งาน | ไฟล์ | หมายเหตุ |
|---|---|---|
| `appointment_policies`, `provider_schedules`, `appointment_slots`, `appointments`, `appointment_reschedule_requests` (migration 5) | `apps/api/src/migrations.ts` | แยกจาก booking ทั้งกติกาและโควตา · รหัส AP… · คำขอเลื่อนรอได้ครั้งละ 1 (partial unique index) |
| `AppointmentService` | `apps/api/src/appointment.service.ts` | ตารางแพทย์ตามช่วงวัน (แพทย์คนเดียวไม่ซ้อนเวลา แม้ต่างคลินิก) · นัดไม่เกินโควตา · ยกเลิกคืนที่ครั้งเดียว + cut-off/override · **เลื่อน = ได้ที่ใหม่และคืนที่เดิมใน transaction เดียว ไม่ได้ก็ไม่เปลี่ยน** · คำขอเลื่อนไม่กันที่จนอนุมัติ อนุมัติตอนเต็มแล้วล้มอย่างสะอาด · ยกเลิกตารางแพทย์ยกเลิกนัดในตาราง + ปิดคำขอที่ชี้เข้ามา · **ไม่มาตามนัด: หัวหน้างานเท่านั้น หลังเวลานัด ต้องมีเหตุผล — ไม่ตั้งอัตโนมัติ** · นัดที่เลยวันแล้วเป็น EXPIRED |
| สถานะระหว่างรอเลื่อน | — | นัดคงเป็น CONFIRMED (ที่เดิมยังใช้ได้) + `pendingRequest` แทนสถานะ RESCHEDULE_REQUESTED ในสเปก — ง่ายต่อเช็กอินและไม่มีช่วงที่ผู้ป่วยไม่มีนัด |
| เช็กอินด้วยรหัส AP | `checkin.service.ts`, `checkin:code` | ใช้ทางเดียวกับ BK · visit แสดง "นัด 09:00 · ชื่อแพทย์" |
| UI | `components/pages/Appointments.tsx`, `app/kiosk/page.tsx` | ตั้งค่า → "นัดแพทย์" (สวิตช์ + คำเตือนเรื่อง HIS เป็นเจ้าของตาราง, กติกาต่อคลินิก, สร้าง/ดู/ปิด/ยกเลิกตารางแพทย์) · ติดตามคิว → "นัดหมาย" (นัด, เลื่อน, ยกเลิก, เช็กอิน, ไม่มาตามนัด, คำขอเลื่อนรออนุมัติ) · ตู้รับ BK และ AP (เครื่องอ่านบาร์โค้ดสลับให้เอง) |
| Tests | `apps/api/test/appointment.test.ts` | +11 ข้อ → **API 84 + Web 22 = 106/106** · ทดสอบในเบราว์เซอร์: ตั้งตารางแพทย์ → นัด 2 ราย → เลื่อน → เช็กอินด้วย AP ที่ตู้ได้ A004 |

ค่าตั้งต้น (รอโรงพยาบาลยืนยัน D4): นัดล่วงหน้า 90 วัน · ยกเลิก/ขอเลื่อนก่อน 24 ชม. · การเลื่อนต้องอนุมัติ · ผู้ป่วยยังไม่เลือกแพทย์เอง
**ข้อควรระวัง (เอกสาร §2.3 release blocker):** ถ้า HIS เป็นเจ้าของตารางนัด ให้ปิด `appointments` และทำ adapter อ่านนัดจาก HIS แทน

### ✅ ขั้น 2.5 LINE identity + ผูกบัญชี — เสร็จ (2026-10-17)
| งาน | ไฟล์ | หมายเหตุ |
|---|---|---|
| `patient_sessions`, `line_patient_links`, `link_requests` (migration 6) | `apps/api/src/migrations.ts` | session เก็บเฉพาะ hash · 1 ลิงก์ ACTIVE ต่อบัญชี LINE และต่อผู้ป่วย (partial unique) |
| `PatientIdentityService` | `apps/api/src/patient-identity.service.ts` | ตรวจ ID token กับ LINE (issuer / audience = channel ของเรา / expiry) ก่อนออก session · โหมดทดสอบ `PATIENT_DEV_LOGIN=on` เท่านั้น และถูกปฏิเสธเมื่อ `NODE_ENV=production` · **D1 เลือกวิธี "เจ้าหน้าที่ช่วยยืนยัน"**: QR ใช้ครั้งเดียว 10 นาที + รหัสสำรอง 8 ตัว, ขอได้ 5 ครั้ง/ชม., มีรหัสใช้งานได้ทีละ 1 · เปลี่ยนเครื่อง = ลิงก์เดิมถูกยกเลิก · ผู้ป่วยยกเลิกเองได้ · เจ้าหน้าที่ยกเลิกได้พร้อมเหตุผล |
| REST ของผู้ป่วย `/api/v1/patient/*` | `apps/api/src/patient.controller.ts` | REST ชุดแรกของระบบ (Bearer, ไม่ใช้ cookie → ไม่มี CSRF) · จำกัด 30 ครั้ง/นาทีต่อ IP · ตัวตนมาจาก session เท่านั้น |
| คำสั่งเจ้าหน้าที่ `link:confirm/status/revoke` | `flow.gateway.ts` | audit ไม่มี LINE id และ HN (ใช้ hash อ้างอิง) |
| UI | `app/liff/page.tsx`, `components/pages/LineLink.tsx`, ตั้งค่า → ข้อมูลผู้ป่วย | หน้า LIFF (ตัวใหญ่ ปุ่มใหญ่ อธิบายวัตถุประสงค์และข้อมูลที่ใช้, QR + นับถอยหลัง, เปลี่ยนเองเมื่อเชื่อมสำเร็จ, ยกเลิกการเชื่อม) · แท็บ "เชื่อม LINE" (สแกนด้วยกล้อง/พิมพ์รหัส, ต้องติ๊ก "ตรวจบัตรแล้ว" ก่อนยืนยัน, ตรวจสถานะ, ยกเลิก) · สวิตช์ `accountLinking` |
| Tests | `apps/api/test/identity.test.ts` | +9 ข้อ (รวมตรวจ token ปลอม/ผิด channel/หมดอายุ/LINE ล่ม) → **API 93 + Web 22 = 115/115** · ทดสอบในเบราว์เซอร์: มือถือ (390 px) + เคาน์เตอร์ ครบวงจร |

ยังต้องมีจากโรงพยาบาลก่อนใช้จริง: LINE Login channel + LIFF app (ดู `docs/DEPLOY.md`) · ถ้าต้องการ OTP ทาง SMS หรือ ThaID เพิ่มเป็น method ใหม่ได้ (ตาราง `line_patient_links.method` รองรับไว้แล้ว)

### ✅ ขั้น 2.6 หน้า LIFF — เสร็จ (2026-10-17)
| งาน | ไฟล์ | หมายเหตุ |
|---|---|---|
| REST ผู้ป่วยที่เชื่อมบัญชีแล้ว | `apps/api/src/patient.controller.ts` | `/queue` (คิววันนี้ + ลิงก์หน้าคิว, การจอง/นัดวันนี้ที่ยังไม่เช็กอิน) · `/booking/services`, `/booking/slots` (เห็นที่ว่าง ไม่เห็น capacity), `POST /bookings` (ต้องมี `Idempotency-Key`), `/bookings/:id/cancel` · `/appointments`, `/appointments/:id/slots`, `/cancel`, `/reschedule` · ของคนอื่นตอบเหมือน "ไม่พบ" |
| กติกาใหม่ | `appointment.service.ts` | ผู้ป่วยเลื่อนนัดได้เฉพาะแพทย์ท่านเดิม (เว้นแต่คลินิกเปิด `patientSelectsProvider`) |
| หน้าจอ | `components/LiffViews.tsx`, `app/liff/page.tsx` | **คิวของฉัน** (เลขคิวตัวใหญ่ + ปุ่มไปหน้าคิว/แผนที่, การจอง/นัดวันนี้พร้อม QR รหัสสำหรับตู้, รีเฟรชทุก 30 วิ) · **จองคิว** (บริการ → วัน → ช่วงเวลา → ตรวจสอบ → ยืนยัน → รหัส + QR; ยกเลิกพร้อมเหตุผล; ประวัติ 30 วัน) · **นัดหมาย** (ดูนัด, QR วันนัด, ขอเลื่อน: วัน → เวลา → เหตุผล → รออนุมัติ/เลื่อนทันที, ยกเลิก; ใกล้ cut-off ให้โทรหาคลินิก) · **แผนที่** (ค้นแผนก → อาคาร/ชั้น/ห้อง) · ปุ่มย้อนกลับของมือถือปิดหน้าย่อย |
| Tests | `apps/api/test/portal.test.ts` | +5 ข้อ → **API 98 + Web 22 = 120/120** · ทดสอบในเบราว์เซอร์ขนาดมือถือครบวงจร: เชื่อมบัญชี → จองคิว (BKWUG99F) → ขอเลื่อนนัด → เช็กอินด้วย AP → คิวของฉันแสดง A005 → หน้าคิว "อีก 3 คิวจะถึงคุณ" |

ข้อจำกัด: "คิวของฉัน" เห็นเฉพาะคิวที่มาจากการจอง/นัด (มี patient profile) — คิว walk-in ที่ไม่ได้ผูก HN ใช้ QR บนบัตรคิวเหมือนเดิม · แผนที่ใน LINE ยังเป็นรายการแผนก (QR ป้ายนำทางคือขั้น 2.8) และใช้ผังแผนกตั้งต้น (ยังไม่รวมแผนกที่เพิ่มในตั้งค่า)

### ✅ ขั้น 2.7 Notifications — เสร็จ (2026-10-17)
| งาน | ไฟล์ | หมายเหตุ |
|---|---|---|
| `notification_jobs`, `notification_logs` (migration 7) | `apps/api/src/migrations.ts` | dedupe key unique · target = PROFILE (หา LINE ที่เชื่อมตอนส่ง) หรือ LINE_USER (การสมัครจากบัตรคิว) |
| Outbox | `apps/api/src/notification.service.ts` + จุดเรียกใน `flow.gateway.ts`, `patient.controller.ts` | **เขียนงานใน transaction เดียวกับการเปลี่ยนแปลง** (`notify.tx`) แทนตาราง `domain_events` แยก · ส่งหลัง commit |
| Worker | `notification.service.ts` | claim แบบมีเงื่อนไข (กันส่งซ้ำ) · `X-Line-Retry-Key` ต่อ job+ผู้รับ · network/429/5xx ลองใหม่ backoff+jitter สูงสุด 5 ครั้ง · 4xx = FAILED · ไม่มี token = SKIPPED · ไม่มี LINE ที่เชื่อม = SKIPPED · งานค้าง PROCESSING ตอนรีสตาร์ต → RETRY · ส่งไม่สำเร็จไม่ย้อนการจอง/นัด |
| ข้อความ | `render()` | ยืนยัน/ยกเลิกการจอง · นัดใหม่ · **เตือนนัด 18:00 วันก่อน** (ถูกแทนเมื่อเลื่อน, ถูกลบเมื่อยกเลิก/เช็กอิน/ไม่มาตามนัด) · เลื่อนนัด · ไม่อนุมัติเลื่อน · นัดถูกยกเลิก · เช็กอินแล้ว · เรียก/เรียกซ้ำ/ย้าย/รับเรื่อง ของผู้ป่วยที่เชื่อม LINE · **ไม่มีชื่อ, HN, ชื่อคลินิก, ชื่อแพทย์** · ผู้ป่วยเปลี่ยนนัดเองจะไม่ได้ข้อความ "นัดเปลี่ยน" |
| ย้ายการแจ้งเตือนคิวเดิม | `line.service.ts` | การสมัครรับแจ้งเตือนจากบัตรคิว (รหัส 6 หลัก) ใช้ worker เดียวกัน · ไม่ส่งซ้ำถ้าเป็นบัญชีที่เชื่อมแล้ว · reply ของ webhook ยังส่งตรง (reply token มีอายุสั้น) |
| UI | `components/pages/Notifications.tsx` | ตั้งค่า → "การแจ้งเตือน": สวิตช์, เตือนถ้ายังไม่ตั้ง LINE OA, ยอด 7 วัน, รายการ (ไม่แสดงผู้รับ), กรองสถานะ, ส่งใหม่ |
| Tests | `apps/api/test/notify.test.ts` | +10 ข้อ → **API 108 + Web 22 = 130/130** · ทดสอบ UI ในเบราว์เซอร์ |

### ✅ ขั้น 2.8 Wayfinding QR — เสร็จ (2026-10-17)
| งาน | ไฟล์ | หมายเหตุ |
|---|---|---|
| `destinations` (migration 8) | `apps/api/src/migrations.ts` | รหัสถาวร (พิมพ์บนป้าย) · อาคาร/ชั้น/โซน/ห้อง · จุดสังเกต · สาธารณะ/เฉพาะเจ้าหน้าที่ · เลิกใช้ → ชี้ไปจุดแทน (รหัสที่เลิกใช้ไม่นำกลับมาใช้) |
| REST สาธารณะ | `apps/api/src/wayfinding.controller.ts` | `GET /api/v1/wayfinding/destinations[/:code]` · ไม่ต้องล็อกอิน · มีแต่ข้อมูลสถานที่ · จำกัดต่อ IP · ต้องเปิด `wayfinding` |
| คำสั่งผู้ดูแล | `flow.gateway.ts` | `wayfinding:list/save/import/retire` + audit |
| หน้า `/wayfinding` | `app/wayfinding/page.tsx`, `lib/wayfinding.ts` | `?at=` "คุณอยู่ที่นี่" + เลือกจุดหมาย · `?to=` ขั้นตอนเป็นภาษาไทย (บอกลิฟต์ก่อนเสมอ, ปิดท้ายด้วยจุดสังเกต) + ผังชั้นไฮไลต์โซนปลายทางและลิฟต์ · ป้ายเก่าของจุดที่ย้ายพาไปจุดใหม่และแจ้งให้รู้ |
| ตั้งค่า → "QR นำทาง" | `components/pages/WayfindingAdmin.tsx` | สวิตช์ · นำเข้าจากผังแผนก (รหัสแบบ `OPD-2A`) · แก้ชื่อ/โซน/จุดสังเกต/รายละเอียด · เลิกใช้พร้อมจุดแทน · **พิมพ์ป้าย A4** (แผ่นละ 1 จุด: "คุณอยู่ที่…", QR ใหญ่, วิธีใช้) |
| LINE → แผนที่ | `components/LiffViews.tsx` | ใช้จุดหมายชุดเดียวกัน แตะแล้วไปหน้าเส้นทาง · ถ้ายังไม่เปิด ใช้รายชื่อแผนกแทน |
| Tests | `apps/api/test/wayfinding.test.ts`, `apps/web/test/wayfinding.test.ts` | +4 API +2 Web → **API 112 + Web 24 = 136/136** · ทดสอบในเบราว์เซอร์: นำเข้า → แก้จุดสังเกต → พิมพ์ป้าย (PDF 2 หน้า A4) → มือถือสแกนป้าย → เลือกห้องยา → เส้นทาง + ผัง |

ระหว่างทำ: แก้หน้าพิมพ์ป้ายที่ถูกแถบบนบัง (ย้ายไปแสดงที่ระดับ body) และกฎ print ที่จะทำให้การพิมพ์หน้าอื่น (บัตรคิวที่ตู้) ว่างเปล่า — จำกัดให้มีผลเฉพาะตอนเปิดหน้าพิมพ์ป้าย

ข้อจำกัด: เส้นทางเป็นข้อความระดับ อาคาร → ชั้น → โซน (ไม่มีกราฟทางเดินจริงของโรงพยาบาล) · ต้องเติมจุดสังเกตให้แต่ละจุดเองเพื่อให้เส้นทางชัดขึ้น

### ✅ ขั้น 2.9 Pilot hardening — เสร็จ (2026-10-17)
| งาน | ไฟล์ | หมายเหตุ |
|---|---|---|
| ตรวจ/กู้ backup | `apps/api/scripts/restore.mjs`, `test/backup.test.ts` | integrity + foreign keys + schema + จำนวนแถว · กู้แล้วเก็บไฟล์เดิมไว้ · ไฟล์เสียถูกปฏิเสธโดยไม่แตะของเดิม · ทดสอบสำรองขณะระบบทำงาน (มี WAL ค้าง) → กู้ → ข้อมูลตรง · ชื่อไฟล์ backup ละเอียดถึงวินาที (เดิมสองครั้งในนาทีเดียวชนกัน) |
| Privacy gate | `test/privacy.test.ts` | จำลองทั้งวันแล้วค้นทุกอย่างที่จอสาธารณะ/QR/ลิงก์ผู้ป่วย/audit ได้รับ · **เจอและแก้: settings ที่ส่งให้ทุกจอมีชื่อเจ้าหน้าที่ (`updatedBy`)** |
| Load test | `apps/api/scripts/load-test.mjs` | 400 จองพร้อมกัน / 250 ที่ → สำเร็จ 250 ไม่เกินโควตา · คำสั่งคิว ~1,650/วินาที |
| เฝ้าระวัง | `health.controller.ts` | `/health` เพิ่ม schema version และงานข้อความค้าง/ล้มเหลว |
| หน้าบันทึกการใช้งาน | `components/pages/AuditPane.tsx` | ตั้งค่า → บันทึกการใช้งาน (ชื่อเจ้าหน้าที่, ผู้ป่วยเป็นรหัสอ้างอิง) — ค้างมาจากขั้น 2.0 |
| เทสต์เสถียรขึ้น | `notify.test.ts`, `line.test.ts` | รอผลการส่งเบื้องหลังแทนการ sleep ตายตัว (เคยล้มครั้งเดียวตอนเครื่องโหลดหนัก) |
| เอกสาร | `docs/PILOT-READINESS.md`, `docs/STAFF-GUIDE.md`, `docs/DEPLOY.md`, `README.md` | เกณฑ์ §16.6 พร้อมหลักฐาน · ผลทดสอบความปลอดภัย · load test · backup/restore · สิ่งที่โรงพยาบาลต้องตัดสินใจ · ขั้นตอนเปิดนำร่อง · แผนย้อนกลับ/รับมือเหตุ · คู่มือเจ้าหน้าที่ภาษาไทย |

## ✅ สรุปเฟส 2 (2026-10-17)
ทำครบทุกขั้น 2.0–2.9 · migration 1–8 (เพิ่มตารางอย่างเดียว) · ทุกฟีเจอร์ปิดไว้เป็นค่าเริ่มต้นและเปิดแยกกันได้ · โหมดสาธิตยังเป็นค่าเริ่มต้น
สิ่งที่เหลือเป็นของโรงพยาบาล: ดู `docs/PILOT-READINESS.md` §5 (D1–D9, privacy notice, retention) และ §6 (ขั้นตอนเปิดนำร่อง)

---

## 9. Rollback

- ทุกฟีเจอร์ใหม่อยู่หลัง flag ใน settings; ปิด flag = กลับไปพฤติกรรมเฟส 1
- โหมดข้อมูลเริ่มต้นคง `demo` — repo ที่ deploy อยู่ไม่เปลี่ยนพฤติกรรมจนกว่าผู้ดูแลจะสลับ
- migration เป็นแบบเพิ่มตารางเท่านั้นในเฟสนี้ ไม่แก้/ลบตารางเฟส 1
- backup ก่อนเปิดแต่ละขั้น และต้องทดสอบ restore ให้ผ่านก่อน pilot

---

## 10. ไฟล์ที่ตรวจในรอบนี้

`package.json`, `apps/api/package.json`, `.github/workflows/ci.yml`, `packages/contracts/src/index.ts`,
`apps/api/src/{db.service,queue.service,flow.gateway,auth.service,tickets.service,line.service,line.controller,ingest.controller,main,app.module}.ts`,
`apps/api/scripts/backup.mjs`, `apps/web/lib/{patients,queue}.ts` (บางส่วน), `apps/web/app/tv/page.tsx`, `apps/web/app/q/[token]/page.tsx`, `apps/web/components/{HospitalDashboard,LoginScreen}.tsx`, `apps/web/components/pages/QueuePage.tsx` (บางส่วน)

คำสั่งที่รัน: `pnpm typecheck` (ผ่าน), `pnpm test` (46/46 ผ่าน), ตรวจ API ของ `node:sqlite` บน Node v24.21.0

---

## หลังเฟส 2 — งานต่อเนื่อง (2026-10-18)
| งาน | ไฟล์ | หมายเหตุ |
|---|---|---|
| รับผู้ป่วยหน้างานพร้อม HN (ไม่บังคับ) | `flow.gateway.ts` `visit:enter`, `components/pages/LiveVisit.tsx` | ต้องติ๊กตรวจบัตรก่อน · ผู้ป่วยที่เชื่อม LINE เห็นคิวใน "คิวของฉัน" และได้แจ้งเตือน · HN ไม่ไปกับ visit |
| แชตบอท LINE + rich menu (แผนเดิมข้อ 9.1–9.2 ที่ยังค้าง) | `apps/api/src/line-bot.ts`, `line.service.ts`, `components/pages/LineOaPane.tsx`, `app/liff/page.tsx` | ตอบคิว/จอง/นัด/เชื่อมบัญชี/ติดต่อ/"…อยู่ไหน" ด้วยปุ่มเปิดหน้าผู้ป่วย (ไม่ค้นข้อมูลใคร) · ข้อความต้อนรับ · เมนู 3×2 วาดในเบราว์เซอร์ ติดตั้งผ่าน API ของ LINE · หน้า LIFF เปิดตรงหน้าที่ปุ่มขอ (`?view=`) · ตั้งค่า → LINE OA |
| Tests | `test/portal.test.ts`, `test/linebot.test.ts` | +6 ข้อ |
