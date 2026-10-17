# Phase 2 — Implementation Plan (Stage 0: Repository discovery)

สถานะ: ผลการสำรวจ repo จริง ณ commit `a74e0b2` (2026-10-17) · อ้างอิงสเปก [Hospital-Digital-Twin-Phase-2-Spec.md](Hospital-Digital-Twin-Phase-2-Spec.md)
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
