# Hospital Digital Twin — Phase 2 Implementation Specification

สถานะ: Proposed design — ต้องตรวจสอบ Repository จริงก่อน implement

## 0. วิธีใช้และข้อห้าม

เอกสารนี้เป็นข้อเสนอ ไม่ใช่หลักฐานว่า schema, route, service หรือ event ที่ระบุมีอยู่แล้ว ห้ามสร้าง migration หรือแก้โค้ดตามเอกสารนี้ทันที ต้องตรวจ monorepo, schema/migration, Queue Engine, RBAC, Socket.IO, settings/session/users, LINE integration และ tests ก่อน

**Non-regression:** ห้ามทำให้ Phase 1 เสียหาย ได้แก่ 2D/3D map, `/real-map`, `/real-map-3d`, queue console, supervisor tools, command center, `/tv`, HIS ingest, Socket.IO real-time, RBAC, audit log, health checks, backup และ Docker Compose ต้องรัน regression tests เดิมทั้งหมด ข้อมูลตั้งต้นเคยระบุ API 30 + Web 16 = 46 tests แต่ต้องตรวจ baseline จริงอีกครั้ง

Stack ตามข้อมูลตั้งต้น (ยังไม่ได้ตรวจ repo ในรอบนี้): pnpm monorepo, Next.js 15 App Router, React 19, three.js/R3F/drei, NestJS + Socket.IO, `packages/contracts`, SQLite ผ่าน `node:sqlite`, Docker Compose + Caddy, GitHub Actions

## 1. เป้าหมายและขอบเขต

เพิ่มประสบการณ์ผู้ป่วยผ่าน LINE OA/LIFF:
- ดูคิวของตัวเอง
- จองคิวบริการทั่วไป
- นัดพบแพทย์
- ดู/ยกเลิก/ขอเลื่อนนัดตาม policy
- รับแจ้งเตือนและเตือนนัด
- สแกน QR เพื่อดูทางไปอาคาร/ชั้น/จุดบริการ
- ให้เจ้าหน้าที่จัดการ booking, appointment, check-in และข้อยกเว้น
- คุ้มครองข้อมูลตาม PDPA และรองรับผู้ป่วยที่ไม่มี smartphone/LINE ผ่านช่องทางเจ้าหน้าที่เดิม

ไม่อยู่ใน scope โดยปริยาย: แทน HIS, เปลี่ยน Queue Engine โดยไม่ตรวจสอบ, วินิจฉัยโรคด้วย AI, ส่งเวชระเบียน/ผลตรวจผ่าน LINE โดยไม่มี security design, บังคับผู้ป่วยใช้ LINE หรือถือว่าไม่ตอบ LINE เท่ากับ no-show

| Module | ความสามารถ |
|---|---|
| LINE OA | Rich Menu และ chatbot entry points |
| LIFF My Queue | ดูคิวและสถานะล่าสุดของตน |
| LIFF Book Queue | จองคิวทั่วไปตามบริการ/slot |
| LIFF Appointments | จอง/ดู/ยกเลิก/ขอเลื่อนนัด |
| LIFF Wayfinding | QR และเส้นทางไปจุดบริการ |
| Account Linking | ผูก LINE กับ patient identity อย่างปลอดภัย |
| Staff Console | ค้นหา/จัดการ booking, appointment, check-in |
| Queue Adapter | เชื่อมกับ Queue Engine เดิมแบบ idempotent |
| Notification Worker | ส่งข้อความแบบ retry/dedupe |
| Audit/Reports | ตรวจสอบกิจกรรมตามสิทธิ |

## 2. หลักการผลิตภัณฑ์

### 2.1 แยกสอง domain

**General Queue Booking:** ผู้ป่วยเลือกหน่วยบริการ/ประเภทบริการและวันหรือช่วงเวลา ไม่เลือกแพทย์รายบุคคล ใช้ quota ของบริการ/slot การจองยังไม่ใช่ Queue Ticket จริง เว้นแต่ระบบเดิมกำหนดไว้ชัดเจน

**Doctor Appointment:** ผู้ป่วยเลือกคลินิก/แพทย์/ช่วงนัดตาม policy ใช้ provider schedule และ quota แยกจาก booking ทั่วไป มี cutoff สำหรับยกเลิก/เลื่อน และต้องเชื่อม check-in กับ Queue Engine/HIS ตาม contract จริง

แนะนำ flow `Booking/Appointment → Check-in → Queue Ticket` แต่ต้องตรวจ behavior ปัจจุบันก่อน หาก Queue Engine ออก ticket ตั้งแต่ตอนจองอยู่แล้ว ให้ map ตามจริง ห้ามสร้าง ticket ซ้ำ

### 2.2 UX สำหรับโรงพยาบาลรัฐไทย

- ภาษาไทยเป็นหลัก คำสั้น ปุ่มใหญ่ ขั้นตอนน้อย
- แสดงวัน เวลา หน่วยบริการ สถานะ และขั้นตอนถัดไปชัดเจน
- มี loading/empty/error/retry/offline states
- ยืนยันก่อน cancel หรือเปลี่ยนรายการ
- แสดง “คำขอรออนุมัติ” ต่างจาก “เปลี่ยนสำเร็จ”
- สีต้องมีข้อความ/ไอคอนประกอบ ไม่ใช้สีอย่างเดียว
- มีทางเลือกให้เจ้าหน้าที่ช่วยและ workflow สำหรับผู้ไม่มี smartphone
- ถ้า real-time ขัดข้อง ให้แสดงเวลาที่อัปเดตล่าสุด ไม่อ้างว่าสถานะเก่าเป็นข้อมูลปัจจุบัน

## 3. Roles และ authorization

| Role | ขอบเขต |
|---|---|
| Patient | ดูเฉพาะข้อมูลของตน |
| Staff | ทำงานตามหน่วยบริการและ permission |
| Supervisor | จัดการข้อยกเว้นที่ได้รับอนุญาต |
| Admin | policy, slots, provider schedules |
| Worker | service credentials จำกัดขอบเขต |

ต้อง map กับ RBAC จริงของ Phase 1 ไม่สร้าง role ซ้ำโดยไม่จำเป็น หลักสำคัญ:
- ห้ามเชื่อ `patientId`, `userId`, HN หรือ role จาก client
- backend resolve patient จาก authenticated session/verified LINE link
- ทุก resource endpoint ต้องป้องกัน IDOR
- staff override ต้องตรวจ permission, reason และ audit
- จำกัดการค้นหา/export ตามสิทธิ

## 4. User journeys

### 4.1 LINE → LIFF
1. ผู้ป่วยเปิด Rich Menu
2. LIFF ใช้ LINE login context ตาม flow ที่รองรับ
3. client ส่ง token ให้ backend ตรวจสอบกับ LINE platform/ตามข้อกำหนด token
4. backend ตรวจ signature/issuer/audience/expiry ตามชนิด token
5. ถ้ายังไม่ link ให้เริ่ม account linking
6. หลังยืนยันแล้วจึงแสดงข้อมูลของ patient profile ที่ผูกไว้

ห้ามเชื่อ LINE `userId` จาก client โดยไม่ verify token ฝั่ง server

### 4.2 Account linking
1. เริ่มผูกบัญชีและอธิบายวัตถุประสงค์
2. ใช้วิธียืนยันที่โรงพยาบาลอนุมัติ เช่น OTP ไปยังเบอร์ที่ลงทะเบียนไว้หรือ staff-assisted verification
3. จำกัดการขอ/ตรวจ OTP และป้องกัน brute force
4. backend ผูก LINE subject กับ patient profile
5. แจ้งผลแบบไม่เปิดเผยข้อมูลอ่อนไหว และบันทึก audit
6. มี flow unlink, เปลี่ยน LINE account และ account recovery

HN + เบอร์โทรที่ผู้ใช้กรอกเองไม่ควรถูกถือเป็นหลักฐานเพียงพอโดยลำพัง

### 4.3 Booking ทั่วไป
1. เลือกบริการ → วัน/slot → ตรวจสรุป
2. backend ตรวจ policy, time window, slot status, quota และ duplicate rules
3. สร้าง booking ใน transaction
4. ส่ง confirmation หลัง commit
5. ผู้ป่วย check-in เมื่อมาถึง
6. check-in service สร้าง/เชื่อม Queue Ticket แบบ idempotent
7. LIFF แสดงคิวจริงเมื่อ Queue Engine ยืนยัน

### 4.4 Appointment
1. เลือกคลินิก/แพทย์/slot ตาม policy
2. แสดงรายละเอียดและ cutoff
3. backend ตรวจ schedule และ quota
4. สร้าง appointment ใน transaction
5. ส่ง confirmation/reminder
6. ผู้ป่วยดู/ยกเลิก/ขอเลื่อนตาม policy
7. check-in เชื่อม Queue Engine/HIS ตาม contract

### 4.5 QR Wayfinding
QR มี URL และ public destination code เท่านั้น ไม่ฝัง patient/booking/appointment ID หรือ token เปิดหน้าแผนที่ 2D/3D เดิมเมื่อ reuse ได้ และมี fallback เป็นข้อความหรือเจ้าหน้าที่ช่วย

## 5. State machines และ business rules

Booking states ที่เสนอ: `PENDING_CONFIRMATION`, `CONFIRMED`, `CANCELLED`, `EXPIRED`, `CHECKED_IN`, `CONVERTED_TO_QUEUE`, `REJECTED`.

Appointment states ที่เสนอ: `REQUESTED`, `CONFIRMED`, `RESCHEDULE_REQUESTED`, `CANCELLED`, `CHECKED_IN`, `COMPLETED`, `NO_SHOW`, `EXPIRED`.

Check-in states ที่เสนอ: `RECEIVED`, `VALIDATING`, `QUEUE_CREATION_PENDING`, `COMPLETED`, `FAILED_RETRYABLE`, `FAILED_FINAL`.

ต้อง map กับ state model จริงก่อนใช้ ไม่จำเป็นต้องใช้ทุกสถานะ

กฎขั้นต่ำ:
- ห้ามจอง slot ปิด/เต็ม หรือ appointment ที่ provider ไม่พร้อม
- ป้องกัน active booking ซ้ำตาม policy
- cancel/reschedule ตรวจ cutoff และ current state
- idempotency key เดิม + payload เดิม คืนผลเดิม; key เดิม + payload ต่างตอบ conflict
- check-in ซ้ำต้องไม่สร้าง ticket เพิ่ม
- cancel ซ้ำต้องไม่คืน quota ซ้ำ
- staff override ต้องมี permission/reason/audit
- **ห้ามตั้ง NO_SHOW เพราะผู้ป่วยไม่เปิด LINE หรือไม่กด notification**
- ใช้ timezone strategy เดียวกันทั้งระบบ แสดงเวลาท้องถิ่นไทยใน UI

## 6. Data model / SQL ตัวอย่าง

ข้อเสนอนี้เป็น starting point เท่านั้น ต้อง map กับ schema จริงก่อน migration

Entity ที่อาจจำเป็น:
`patient_profiles`, `line_patient_links`, `booking_policies`, `booking_slots`, `bookings`, `provider_schedules`, `appointment_slots`, `appointments`, `appointment_reschedule_requests`, `check_in_records`, `notification_jobs`, `notification_logs`, `domain_events`.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS patient_profiles (
  id TEXT PRIMARY KEY,
  external_patient_id TEXT UNIQUE,
  identity_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (identity_status IN ('UNVERIFIED','VERIFIED','REVOKED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS line_patient_links (
  id TEXT PRIMARY KEY,
  patient_profile_id TEXT NOT NULL REFERENCES patient_profiles(id),
  line_subject TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','UNLINKED','REVOKED')),
  verified_at TEXT NOT NULL,
  unlinked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_line_links_patient
  ON line_patient_links(patient_profile_id, status);

CREATE TABLE IF NOT EXISTS booking_policies (
  id TEXT PRIMARY KEY,
  service_code TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  advance_days INTEGER NOT NULL DEFAULT 14 CHECK (advance_days >= 0),
  cancel_cutoff_minutes INTEGER NOT NULL DEFAULT 60 CHECK (cancel_cutoff_minutes >= 0),
  max_active_bookings_per_patient INTEGER NOT NULL DEFAULT 1
    CHECK (max_active_bookings_per_patient >= 1),
  policy_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS booking_slots (
  id TEXT PRIMARY KEY,
  service_code TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity >= 0),
  reserved_count INTEGER NOT NULL DEFAULT 0
    CHECK (reserved_count >= 0 AND reserved_count <= capacity),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','CLOSED','CANCELLED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (starts_at < ends_at)
);
CREATE INDEX IF NOT EXISTS idx_booking_slots_service_time
  ON booking_slots(service_code, starts_at, status);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  booking_code TEXT NOT NULL UNIQUE,
  patient_profile_id TEXT NOT NULL REFERENCES patient_profiles(id),
  slot_id TEXT NOT NULL REFERENCES booking_slots(id),
  status TEXT NOT NULL CHECK (status IN (
    'PENDING_CONFIRMATION','CONFIRMED','CANCELLED','EXPIRED',
    'CHECKED_IN','CONVERTED_TO_QUEUE','REJECTED'
  )),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  queue_ticket_id TEXT,
  checked_in_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_patient_status
  ON bookings(patient_profile_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_slot_status
  ON bookings(slot_id, status);

CREATE TABLE IF NOT EXISTS provider_schedules (
  id TEXT PRIMARY KEY,
  provider_code TEXT NOT NULL,
  clinic_code TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','CLOSED','CANCELLED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (starts_at < ends_at)
);
CREATE INDEX IF NOT EXISTS idx_provider_schedules_provider_time
  ON provider_schedules(provider_code, starts_at, status);

CREATE TABLE IF NOT EXISTS appointment_slots (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES provider_schedules(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity >= 0),
  reserved_count INTEGER NOT NULL DEFAULT 0
    CHECK (reserved_count >= 0 AND reserved_count <= capacity),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','CLOSED','CANCELLED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (starts_at < ends_at)
);
CREATE INDEX IF NOT EXISTS idx_appointment_slots_schedule_time
  ON appointment_slots(schedule_id, starts_at, status);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  appointment_code TEXT NOT NULL UNIQUE,
  patient_profile_id TEXT NOT NULL REFERENCES patient_profiles(id),
  slot_id TEXT NOT NULL REFERENCES appointment_slots(id),
  status TEXT NOT NULL CHECK (status IN (
    'REQUESTED','CONFIRMED','RESCHEDULE_REQUESTED','CANCELLED',
    'CHECKED_IN','COMPLETED','NO_SHOW','EXPIRED'
  )),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  queue_ticket_id TEXT,
  checked_in_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_appointments_patient_status
  ON appointments(patient_profile_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_appointments_slot_status
  ON appointments(slot_id, status);

CREATE TABLE IF NOT EXISTS appointment_reschedule_requests (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL REFERENCES appointments(id),
  requested_slot_id TEXT NOT NULL REFERENCES appointment_slots(id),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  reason TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS check_in_records (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('BOOKING','APPOINTMENT','WALK_IN')),
  source_id TEXT NOT NULL,
  patient_profile_id TEXT REFERENCES patient_profiles(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'RECEIVED','VALIDATING','QUEUE_CREATION_PENDING','COMPLETED',
    'FAILED_RETRYABLE','FAILED_FINAL'
  )),
  queue_ticket_id TEXT,
  error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source_type, source_id)
);

CREATE TABLE IF NOT EXISTS notification_jobs (
  id TEXT PRIMARY KEY,
  patient_profile_id TEXT REFERENCES patient_profiles(id),
  channel TEXT NOT NULL CHECK (channel IN ('LINE','STAFF_CONSOLE')),
  template_code TEXT NOT NULL,
  related_type TEXT NOT NULL,
  related_id TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','SENT','RETRY','FAILED','CANCELLED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_due
  ON notification_jobs(status, scheduled_at);

CREATE TABLE IF NOT EXISTS notification_logs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES notification_jobs(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('SENT','RETRY','FAILED')),
  provider_message_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS domain_events (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','PUBLISHED','FAILED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_domain_events_status_created
  ON domain_events(status, created_at);
```

### 6.1 Schema review ก่อน migration
- ตรวจว่ามี patient/users/tickets/queue_events/settings อยู่แล้วหรือไม่
- อย่าสร้าง patient identity ซ้ำกับ HIS
- กำหนด time storage format และ timezone
- พิจารณา partial unique index สำหรับ active booking
- คืน quota เมื่อ cancel/expire ใน transaction และคืนได้ครั้งเดียว
- กำหนด retention/deletion policy
- ห้ามเก็บ LINE tokens/OTP plaintext
- validate/version `policy_json`
- คำนวณ `request_hash` ฝั่ง server จาก canonical payload
- หลีกเลี่ยง PHI ใน event payload


## 7. Transaction, concurrency และ idempotency

### 7.1 จอง slot แบบป้องกัน overbooking
ห้ามอ่าน `reserved_count` แล้วค่อย update โดยไม่มี transaction เพราะ concurrent requests อาจเกิน quota

แนวทางสำหรับ SQLite:
1. เริ่ม write transaction แบบ serialize writer เช่น `BEGIN IMMEDIATE` หาก driver/runtime รองรับ
2. ตรวจ idempotency key ก่อน
3. key เดิม + hash เดิม: คืนผลเดิม; key เดิม + hash ต่าง: `409 IDEMPOTENCY_KEY_REUSED`
4. ตรวจ slot status, time window, policy และ quota
5. ใช้ conditional update:

```sql
UPDATE booking_slots
SET reserved_count = reserved_count + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id = ?
  AND status = 'OPEN'
  AND reserved_count < capacity;
```

6. ถ้า update ไม่ได้หนึ่งแถว ให้ rollback และตอบ `409 SLOT_FULL_OR_CLOSED`
7. insert booking และ domain event/outbox (ถ้าใช้)
8. commit
9. ส่ง notification หลัง commit เท่านั้น

ต้องตรวจ transaction API ของ `node:sqlite` และ wrapper จริงก่อน implement ตัวอย่างนี้เป็น SQL pattern เท่านั้น

### 7.2 Cancel และคืน quota
- ตรวจ current state และ cutoff
- เปลี่ยนสถานะและคืน quota ใน transaction เดียวกัน
- คืน quota เฉพาะ transition active → cancelled/expired ครั้งแรก
- retry cancel ต้องไม่คืน quota ซ้ำ
- ห้ามเรียก LINE/HIS/network ระหว่าง write transaction
- เก็บ actor/reason ตาม policy

### 7.3 Idempotency contract
ใช้กับ `POST /bookings`, `POST /appointments`, `POST /check-ins` และ mutation สำคัญที่ผู้ใช้ retry ได้:
- `Idempotency-Key` มี scope ที่เหมาะสม
- server เก็บ key + canonical request hash + resource/result
- key เดิม/payload เดิม คืนผลเดิม
- key เดิม/payload ต่าง ตอบ conflict
- Queue Engine ต้องป้องกัน duplicate ที่ฝั่งมันด้วย
- กำหนด retention ของ idempotency record ตาม retry window

### 7.4 Queue Engine Adapter
เป็น service boundary เชื่อมกับ Queue Engine เดิม ไม่ให้ booking module ผูกกับ implementation ภายในโดยตรง

```ts
type CreateQueueTicketInput = {
  sourceType: 'BOOKING' | 'APPOINTMENT' | 'WALK_IN';
  sourceId: string;
  idempotencyKey: string;
  patientReference: string;
  serviceCode: string;
};

type CreateQueueTicketResult = {
  ticketId: string;
  displayNumber?: string;
  status: string;
};

interface QueueEngineAdapter {
  createTicket(input: CreateQueueTicketInput): Promise<CreateQueueTicketResult>;
  getTicket(ticketId: string): Promise<CreateQueueTicketResult | null>;
}
```

ต้อง map type/field กับ codebase จริง `sourceId` ต้อง unique/idempotent ที่ Queue Engine ด้วย หาก call timeout หลัง Queue Engine สร้าง ticket แล้ว ให้ lookup/reconcile ก่อน retry ห้ามสร้าง ticket ใหม่เพียงเพราะ client ไม่ได้รับ response หาก Queue Engine ไม่มี idempotency ให้บันทึกเป็น risk และกำหนด reconciliation/manual recovery ก่อนเปิดใช้จริง

## 8. API contract ที่เสนอ

**ทุก path ต่อไปนี้เป็น proposal ไม่ใช่ route ที่ยืนยันว่ามีจริง** ต้อง map กับ prefix/versioning/DTO convention ของ repository

### 8.1 Patient/LIFF API

| Method | Proposed path | Purpose |
|---|---|---|
| POST | `/api/v1/patient/line/session` | verify LINE token และสร้าง session |
| GET | `/api/v1/patient/me` | patient profile แบบจำกัดข้อมูล |
| POST | `/api/v1/patient/link/start` | เริ่ม link account |
| POST | `/api/v1/patient/link/verify` | verify identity evidence |
| POST | `/api/v1/patient/link/unlink` | unlink ตาม policy |
| GET | `/api/v1/patient/queue` | คิว active ของผู้ป่วย |
| GET | `/api/v1/patient/queue/:id` | รายละเอียดคิวที่เข้าถึงได้ |
| GET | `/api/v1/booking/services` | บริการที่เปิดจอง |
| GET | `/api/v1/booking/slots` | slot ตาม filter |
| POST | `/api/v1/bookings` | สร้าง booking |
| GET | `/api/v1/bookings` | booking ของผู้ป่วยปัจจุบัน |
| GET | `/api/v1/bookings/:id` | รายละเอียด booking ของตน |
| POST | `/api/v1/bookings/:id/cancel` | cancel ตาม policy |
| GET | `/api/v1/appointments/clinics` | คลินิกที่เปิดนัด |
| GET | `/api/v1/appointments/providers` | provider ตาม filter |
| GET | `/api/v1/appointments/slots` | slot นัดที่ว่าง |
| POST | `/api/v1/appointments` | สร้าง appointment |
| GET | `/api/v1/appointments` | นัดของผู้ป่วยปัจจุบัน |
| GET | `/api/v1/appointments/:id` | รายละเอียดนัดของตน |
| POST | `/api/v1/appointments/:id/cancel` | cancel ตาม policy |
| POST | `/api/v1/appointments/:id/reschedule-requests` | ขอเลื่อนนัด |
| GET | `/api/v1/wayfinding/destinations` | จุดหมายสาธารณะ |
| GET | `/api/v1/wayfinding/destinations/:code` | รายละเอียดจุดหมาย |

### 8.2 Staff/Admin API

| Method | Proposed path | Purpose |
|---|---|---|
| GET | `/api/v1/staff/bookings` | ค้น booking ตาม permission |
| GET | `/api/v1/staff/appointments` | ค้น appointment ตาม permission |
| POST | `/api/v1/staff/check-ins` | check-in โดยเจ้าหน้าที่ |
| POST | `/api/v1/staff/bookings/:id/cancel` | override/cancel พร้อม reason |
| POST | `/api/v1/staff/appointments/:id/cancel` | override/cancel พร้อม reason |
| POST | `/api/v1/staff/appointments/:id/reschedule` | จัดการคำขอเลื่อน |
| GET | `/api/v1/admin/booking-policies` | ดู policies |
| PUT | `/api/v1/admin/booking-policies/:id` | แก้ policy + audit |
| POST | `/api/v1/admin/booking-slots` | สร้าง slot |
| PATCH | `/api/v1/admin/booking-slots/:id` | เปิด/ปิด/แก้ slot |
| POST | `/api/v1/admin/provider-schedules` | สร้างตาราง provider |
| POST | `/api/v1/admin/appointment-slots` | สร้าง slot นัด |
| GET | `/api/v1/admin/notification-jobs` | ตรวจ notification jobs |

ไม่จำเป็นต้องสร้างทุก endpoint หาก repository ใช้ command routes หรือ conventions อื่น ให้คงความสม่ำเสมอ

### 8.3 Request/response ตัวอย่าง

สร้าง booking:

```http
POST /api/v1/bookings
Authorization: Bearer <app-session-token>
Idempotency-Key: <unique-key>
Content-Type: application/json
```

```json
{ "slotId": "slot_public_id" }
```

ห้ามรับ `patientProfileId` จาก client เป็นเจ้าของ booking; derive identity จาก session ฝั่ง server และ derive service/time จาก slot ในฐานข้อมูล

Response ตัวอย่าง (ข้อมูลสมมติ):

```json
{
  "data": {
    "id": "booking_public_id",
    "bookingCode": "BK-EXAMPLE",
    "status": "CONFIRMED",
    "service": { "code": "OPD_EXAMPLE", "displayName": "ตัวอย่างหน่วยบริการ" },
    "slot": {
      "startsAt": "2026-11-01T02:00:00Z",
      "endsAt": "2026-11-01T03:00:00Z"
    },
    "nextStep": "CHECK_IN_AT_HOSPITAL"
  }
}
```

สร้าง appointment request ใช้ `{"slotId":"appointment_slot_public_id"}` โดย patient identity derive จาก session เช่นกัน response ควรมี appointment code, status, clinic/provider ที่อนุญาตให้แสดง และเวลา ห้ามคืนเวชระเบียน

### 8.4 Error contract

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | input ไม่ถูกต้อง |
| 401 | `AUTH_REQUIRED` | ไม่มี session ที่ถูกต้อง |
| 403 | `FORBIDDEN` | ไม่มีสิทธิ |
| 404 | `RESOURCE_NOT_FOUND` | ไม่พบหรือไม่มีสิทธิอ่าน |
| 409 | `SLOT_FULL_OR_CLOSED` | slot เต็ม/ปิด |
| 409 | `IDEMPOTENCY_KEY_REUSED` | key เดิมแต่ payload ต่าง |
| 409 | `INVALID_STATE_TRANSITION` | เปลี่ยน state ไม่ได้ |
| 422 | `POLICY_REJECTED` | ไม่ผ่าน policy |
| 429 | `RATE_LIMITED` | เรียกถี่เกิน |
| 503 | `QUEUE_ENGINE_UNAVAILABLE` | Queue Engine ไม่พร้อม |

Error ต้องไม่ช่วย enumerate ว่า HN หรือ patient record ของบุคคลนั้นมีอยู่หรือไม่

## 9. LINE OA / LIFF / notifications

### 9.1 Rich Menu
เมนูแนะนำ:
1. คิวของฉัน
2. จองคิวบริการ
3. นัดแพทย์
4. แผนที่โรงพยาบาล
5. เชื่อมบัญชีผู้ป่วย
6. ติดต่อเจ้าหน้าที่

ตรวจข้อจำกัด LINE OA/LIFF และจำนวน action ที่รองรับ ณ วัน deploy

### 9.2 Chatbot intents
- ดูคิวของฉัน
- จองคิวทั่วไป
- ดูนัดหมาย
- ขอเลื่อน/ยกเลิกนัด
- แผนที่/วิธีไปจุดบริการ
- วิธีเชื่อมบัญชี
- ติดต่อเจ้าหน้าที่

สำหรับข้อมูลเฉพาะบุคคล ให้เปิด LIFF หลัง authentication แทนการส่ง PHI ลงในข้อความแชต

### 9.3 Notification types
- booking confirmed/cancelled
- appointment confirmed/reminder
- reschedule request received/approved/rejected
- check-in success
- queue status change ที่มีประโยชน์และไม่ถี่เกินไป
- service/slot cancellation ที่กระทบผู้ป่วย

ข้อความควรเปิดเผยน้อยที่สุด เช่น “มีการยืนยันการจองแล้ว กรุณาเปิด LIFF เพื่อดูรายละเอียด” หลีกเลี่ยงชื่อเต็ม, HN, diagnosis, ผลตรวจ และรายละเอียดการรักษาใน push notification

### 9.4 Worker behavior
- ทำงานหลัง transaction commit
- `dedupe_key` ป้องกัน event/ข้อความซ้ำ
- retry แบบ exponential backoff + jitter
- แยก transient/permanent errors และมี retry limit
- เก็บ provider message ID/error code เท่าที่จำเป็น
- ยกเลิก reminder ที่ไม่จำเป็นหลัง cancel/reschedule
- notification failure ไม่ rollback booking/appointment
- ตรวจ LINE rate limits และ webhook signature ตามข้อกำหนดจริง

## 10. LIFF UX

### My Queue
แสดงสถานะที่แยกได้ชัด: ไม่มีคิว active, จองแล้วรอ check-in, check-in แล้วรอระบบ, มีคิวจริง, เสร็จสิ้น/ยกเลิก แสดงเลขคิวที่อนุญาต หน่วยบริการ สถานะ เวลาปรับปรุง และขั้นตอนถัดไป

### Book Queue
เลือกบริการ → วัน → slot → ตรวจสรุป → ยืนยัน → booking code/ขั้นตอน check-in แสดง quota เฉพาะเมื่อข้อมูลเชื่อถือได้

### Appointments
แสดงนัดที่จะมาถึงก่อน แยกนัดที่ผ่านมา/ยกเลิก แสดงวัน เวลา คลินิก และปุ่ม cancel/reschedule เฉพาะเมื่อ policy อนุญาต ต้องยืนยันก่อนเปลี่ยนรายการ

### Account linking
อธิบายวัตถุประสงค์และข้อมูลที่ใช้ ไม่แสดงข้อมูลเต็มก่อน verify ป้องกัน enumeration และมี staff-assisted path

### Wayfinding
แสดงชื่อจุดหมายภาษาไทย อาคาร ชั้น landmark และเส้นทาง รองรับข้อความแทนแผนที่และใช้ map data เดิมเมื่อเหมาะสม QR ห้ามมี patient/appointment/booking ID หรือ access token

## 11. Staff Console

หน้าจอที่เสนอ:
- bookings วันนี้
- appointments วันนี้
- ค้นหาด้วย code/เงื่อนไขที่ได้รับอนุญาต
- check-in
- cancel/override
- reschedule requests
- notification failures
- slot/quota management
- audit history

Guardrails:
- override ต้องมี permission และ reason
- disable ปุ่มระหว่าง submit แต่ backend ต้องป้องกัน duplicate อยู่ดี
- แสดง source-of-truth status และ last-updated
- จำกัดผลค้นหา/export ตามสิทธิ
- หลีกเลี่ยงข้อมูลผู้ป่วยบน TV/command center
- มี workflow สำหรับผู้ไม่มี smartphone: เจ้าหน้าที่ตรวจตัวตนตามกระบวนการเดิม สร้าง booking/check-in เมื่อ policy อนุญาต และให้ผู้ป่วยรับเลขอ้างอิง/คำแนะนำโดยไม่บังคับ LINE

## 12. QR / destination data

URL ตัวอย่าง: `https://<hospital-domain>/wayfinding?to=OPD-REGISTRATION` (placeholder เท่านั้น)

Destination fields ที่อาจต้องมี:
- `code`, `display_name_th`, `building`, `floor`, `description_th`
- `map_node_id` reference ไปยัง map เดิม
- `is_public`, `status`, `updated_at`

Reuse destination model เดิมถ้ามี มี owner อนุมัติ QR ตรวจปลายทางก่อนพิมพ์ มี redirect/version strategy หากจุดหมายเปลี่ยน และ QR ที่ปิดแล้วต้องแสดงหน้าแจ้งข้อมูลที่เหมาะสม

## 13. PDPA / security / privacy

- เก็บข้อมูลเท่าที่จำเป็น แยก identity จาก event payload ตามเหมาะสม
- กำหนด purpose, retention, deletion, data controller/processor และช่องทางติดต่อร่วมกับโรงพยาบาล
- ตรวจ LINE token ฝั่ง server รวม issuer/audience/expiry/signature ตาม token type
- session มี expiry/revocation/rotation; cookie ใช้ HttpOnly/Secure/SameSite ตามข้อจำกัด LIFF/deployment และป้องกัน CSRF ตาม auth model
- ป้องกัน IDOR, enumeration, OTP brute force และ rate-limit link/search/booking
- เก็บ LINE secrets ใน secret storage/env ที่เหมาะสม ห้าม commit
- redact authorization header, tokens, OTP, HN/name/PHI จาก logs
- TV/QR/public screens ไม่แสดงชื่อเต็ม/HN/ข้อมูลสุขภาพ
- analytics/AI ใช้ aggregate หรือ de-identified data เท่าที่ทำได้; ห้ามส่ง identifiable patient data ไป external model โดยไม่มี approval/risk assessment
- incident playbook ต้องครอบคลุม revoke session/link, ปิด slot, reconcile queue, ตรวจ audit, แจ้ง privacy/security owner และประเมินหน้าที่ตามกฎหมาย

## 14. Real-time events และ integration

ใช้ event mechanism เดิมถ้ามี หลีกเลี่ยง event ซ้ำ และ authorize patient rooms ทุกครั้ง Logical event names ที่อาจต้องใช้ (ไม่ใช่ชื่อที่ยืนยันว่ามีใน repo):
- `booking.created`
- `booking.cancelled`
- `appointment.confirmed`
- `appointment.cancelled`
- `appointment.reschedule_requested`
- `appointment.rescheduled`
- `checkin.completed`
- `queue.ticket.updated`
- `notification.failed`

Payload มีเฉพาะ field ที่ consumer ต้องใช้ ใช้ eventId สำหรับ dedupe, timestamp และ schema version ห้าม broadcast PHI ไป TV/public rooms frontend ต้อง reconnect แล้ว fetch API เพื่อ reconcile

หากต้องรับประกัน DB write + event ให้ใช้ outbox/domain event ใน transaction เดียวกัน หรือกลไกเดิมของ repo ไม่สมมติว่า DB write แล้ว emit socket ทันทีจะทน process crash ได้

## 15. Observability / operations

Metrics:
- booking/appointment attempts, success, reject, cancel
- slot-full conflicts, duplicate idempotency
- check-in success/failure
- Queue Engine latency/error/retry
- notification success/failure/retry
- webhook signature failures, account-link rate limits
- API latency/errors, DB lock/busy contention หากวัดได้

ห้ามใช้ patient identifiers เป็น metric labels เพราะเป็น privacy risk และทำให้ cardinality สูง

Logs ควรมี correlation/request ID, operation, resource type/opaque ID เมื่อเหมาะสม, outcome, error code, latency และ retry count ห้าม log token, OTP, auth header, full request body หรือ PHI โดยไม่จำเป็น

Backup/restore:
- รวมตารางใหม่ใน backup mechanism เดิม
- ตรวจ SQLite WAL consistency
- ทดสอบ restore แยกจาก production
- กำหนด RPO/RTO และควบคุมสิทธิ/encryption ของ backup
- backup script ไม่ได้แปลว่า restore ใช้งานได้จริงจนกว่าจะทดสอบ

SQLite:
- ตรวจจำนวน concurrent writers และ deployment topology
- write transactions ต้องสั้น ห้าม network call ระหว่าง transaction
- ตรวจ WAL/busy timeout/retry ตาม runtime จริง
- ถ้า concurrency/HA เกินความสามารถ ให้ทำ architecture review แยก ห้ามเปลี่ยน DB โดยอัตโนมัติ


## 16. Testing strategy และ acceptance criteria

### Unit tests
- policy validation
- booking/appointment state transitions
- cancellation cutoff
- quota rules
- canonical request hash
- idempotency
- notification redaction
- RBAC/permission

### Integration tests
- create/read booking
- create/read appointment
- cancel คืน quota exactly once
- check-in เรียก Queue Adapter อย่างถูกต้อง
- Queue Engine timeout แล้ว reconcile โดยไม่สร้าง ticket ซ้ำ
- LINE token verification failure
- account linking success/failure/rate limit
- notification retry/dedupe
- outbox publish/retry
- migration recovery ตามเครื่องมือจริง

### Concurrency tests
1. capacity = 1 ส่งหลาย requests พร้อมกัน ต้องสำเร็จไม่เกิน 1
2. capacity = N ส่ง requests มากกว่า N ต้องสำเร็จไม่เกิน N
3. key เดิม/payload เดิม ต้องได้ resource เดียว
4. cancel ซ้ำ ต้องคืน quota ครั้งเดียว
5. check-in ซ้ำ ต้องได้ Queue Ticket เดียว
6. worker restart ระหว่างส่ง notification/เรียก Queue Engine ต้อง reconcile ได้

ต้องทดสอบกับ SQLite driver/runtime จริง ไม่ใช้ mock อย่างเดียว

### Security tests
- patient A อ่าน booking/appointment ของ B ไม่ได้
- ปลอม patient ID จาก client ไม่สำเร็จ
- LINE token ปลอม/หมดอายุ/audience ผิดถูกปฏิเสธ
- OTP brute force และ enumeration ถูก rate limit
- staff ที่ไม่มี permission override ไม่ได้
- QR สาธารณะไม่เปิดข้อมูลผู้ป่วย
- TV payload ไม่มีชื่อ/HN/PHI
- logs ไม่มี secrets/PHI
- webhook signature ผิดถูกปฏิเสธ

### UX/accessibility tests
- ผู้ใช้ที่ยังไม่ link เข้าใจขั้นตอนถัดไป
- success/failure messages ชัดเจน
- mobile viewport ใช้งานได้
- ปุ่ม/ตัวอักษรอ่านง่าย
- loading/empty/error states ครบ
- network หลุดตอน submit แล้ว retry ไม่สร้างซ้ำ
- ผู้ไม่มี smartphone ยังรับบริการได้
- wayfinding มี text fallback

### Acceptance criteria ก่อน pilot
1. booking และ appointment แยก policy/quota
2. concurrent booking ไม่เกิน capacity
3. idempotency ครอบคลุม booking, appointment, check-in
4. Queue Engine integration ผ่าน timeout/reconciliation tests
5. account linking ผ่าน security/privacy review
6. notification มี retry/dedupe และไม่เปิดเผย PHI
7. staff override มี RBAC/audit
8. TV/QR/public payload ผ่าน privacy review
9. ผู้ไม่มี LINE/smartphone ใช้ช่องทางเดิมได้
10. Phase 1 regression tests ผ่าน
11. backup/restore และ recovery ผ่าน
12. โรงพยาบาลอนุมัติ workflow, retention, consent และข้อความผู้ป่วย

## 17. Implementation plan

### Stage 0 — Repository discovery (ห้ามข้าม)
- inventory apps/packages/services, package scripts, CI, build/test commands
- schema/migration inventory
- actual Queue Engine flow และจุดสร้าง ticket
- RBAC map
- Socket.IO events/payloads
- LINE integration status
- baseline tests
- risk register และคำถามที่ต้องตัดสินใจ
- ห้ามแก้ application code ใน stage นี้

### Stage 1 — Domain/contracts
- ตกลง booking vs appointment semantics
- กำหนด state transitions
- กำหนด quota/cancel/reschedule policies
- กำหนด identity proof
- map API DTO/error convention
- กำหนด Queue Adapter contract
- schema mapping และ migration plan

### Stage 2 — Backend foundation
- schema/migration หลัง review
- booking/appointment policy services
- quota-safe transaction/idempotency
- audit events
- concurrency/authorization tests

### Stage 3 — Queue integration/check-in
- เชื่อม Queue Adapter กับระบบจริง
- idempotent check-in
- timeout/retry/reconciliation
- mapping กับ HIS หากเกี่ยวข้อง

### Stage 4 — LINE/LIFF
- LINE token verification/session
- account linking
- My Queue, Book Queue, Appointments, Wayfinding
- error/loading/empty states
- accessibility review

### Stage 5 — Notifications/staff console
- jobs/worker, retry/dedupe/logging
- staff lists and check-in
- override with RBAC/audit
- QR destination management

### Stage 6 — Pilot/hardening
- integration/security/UX tests
- backup/restore, concurrency/load tests
- train staff, controlled pilot, rollback plan
- monitor metrics and collect feedback before wider rollout

## 18. Rollout และ rollback

### Feature flags
ควรเปิด/ปิดแยกได้: general booking, doctor appointments, account linking, LINE notifications, LIFF wayfinding, staff overrides ใช้ feature flag/settings mechanism เดิมถ้ามี

### Pilot
- เริ่มจากหน่วยบริการที่มี owner ชัดเจน
- ใช้ slot/quota ที่ตรวจสอบได้
- มีเจ้าหน้าที่รับผิดชอบ incident
- กำหนดเกณฑ์หยุด pilot ล่วงหน้า
- ห้ามใช้ข้อมูลผู้ป่วยจริงใน test environment โดยไม่มี approval และ safeguards

### Rollback
- ปิด feature flag ก่อน
- เก็บ booking/appointment ที่สร้างแล้ว อย่าลบ cascade โดยไม่ประเมิน
- หยุด worker หาก notification ผิด
- reconcile สถานะค้าง
- ห้าม rollback migration ที่ทำให้ข้อมูลสูญหายโดยไม่มีแผน
- มี manual workflow ให้ staff ทำงานต่อได้

## 19. Open questions / decisions required

ต้องให้เจ้าของผลิตภัณฑ์/โรงพยาบาลยืนยัน:
1. Source of truth ของ patient identity คือ HIS, ระบบเดิม หรือ Phase 1?
2. จองล่วงหน้าได้กี่วัน และเปิดให้แผนกใด?
3. quota แบ่งตามแผนก/วัน/ช่วงเวลา/ประเภทผู้ป่วยอย่างไร?
4. ผู้ป่วยเลือกแพทย์เองได้หรือเลือกเฉพาะช่วงนัด?
5. cutoff cancel/reschedule เท่าไร และต้องอนุมัติบางกรณีหรือไม่?
6. check-in ต้องสร้าง ticket ใหม่หรือผูก ticket ที่มีอยู่?
7. HIS มี API appointment/check-in และ idempotency support หรือไม่?
8. วิธีพิสูจน์ตัวตนตอน link LINE ที่โรงพยาบาลอนุมัติคืออะไร?
9. consent/opt-out ของ LINE notification เป็นอย่างไร?
10. ใครเป็น owner ของ schedule/slot และใคร override quota ได้?
11. pilot ที่หน่วยบริการใดและ success criteria คืออะไร?
12. ข้อมูลใดแสดงใน LIFF/notification ได้บ้าง?
13. retention ของ booking, appointment, audit, LINE link และ notification log เท่าไร?
14. ต้องเชื่อมสิทธิ/ประเภทผู้ป่วย/ข้อยกเว้นจาก HIS หรือไม่?
15. รองรับผู้ไม่มีเบอร์โทรศัพท์/LINE หรือผู้ป่วยต่างชาติด้วย workflow ใด?

## 20. Claude Code prompt — repository discovery only

วางเอกสารนี้เป็น `docs/PHASE-2-IMPLEMENTATION-SPEC.md` แล้วใช้ prompt:

```text
You are reviewing the Hospital Digital Twin repository to prepare Phase 2 implementation.

Read docs/PHASE-2-IMPLEMENTATION-SPEC.md completely before planning.

IMPORTANT:
- This is proposed design, not proof that routes, tables, services, event names, or implementation details exist.
- Do not modify application code, schema, migrations, configuration, lockfiles, or tests.
- Do not fabricate files, endpoints, entities, events, or test results.
- Inspect the real repository and map each proposed feature to current implementation.
- Preserve Phase 1 behavior and all existing tests.

Inspect:
1. Monorepo structure, package scripts, CI, build/test commands.
2. Current database schema and migration mechanism.
3. Existing queue engine and exact queue-ticket creation sequence.
4. Existing user/patient/session/identity models and linking capabilities.
5. RBAC and staff/supervisor/admin permissions.
6. Audit/event-log mechanism.
7. Socket.IO events, payloads and authorization.
8. LINE OA, webhook, LIFF and notification integration, if any.
9. Routes/components for /tv, /real-map, /real-map-3d and patient screens.
10. SQLite runtime support for transactions, concurrency, WAL and busy timeout.
11. Backup/restore behavior and relevant tests.

Create only docs/PHASE-2-IMPLEMENTATION-PLAN.md.

The plan must include:
- Repository facts with file paths and line references where available.
- Current architecture and actual queue-ticket creation sequence.
- Mapping table: proposed feature -> existing code/schema -> gap -> proposed change.
- Schema reuse vs new schema decisions.
- Proposed migrations, without implementing them.
- API route/DTO mapping to actual conventions.
- Queue Engine idempotency, timeout and reconciliation analysis.
- Security/PDPA risks and mitigations.
- Test baseline and tests to add.
- Ordered stages, dependencies and acceptance criteria.
- Open questions that code cannot answer.
- Risks, rollback strategy and decisions requiring human approval.

Do not edit any other file. Report exact files inspected, the one file created, and commands/tests run. Label unverifiable claims UNVERIFIED rather than guessing.
```

## 21. Definition of Done

- [ ] Repository discovery/schema mapping เสร็จ
- [ ] Product owner อนุมัติ booking/appointment policies
- [ ] Identity linking ผ่าน security/privacy review
- [ ] Migration ผ่าน review และทดสอบกับสำเนาข้อมูล
- [ ] Quota transaction/idempotency ผ่าน concurrency tests
- [ ] Queue Adapter ผ่าน timeout/retry/reconciliation tests
- [ ] LIFF ผ่าน UX/accessibility review
- [ ] Notification ผ่าน dedupe/retry tests
- [ ] Staff actions ผ่าน RBAC/audit tests
- [ ] QR/TV/public payload ผ่าน privacy review
- [ ] ผู้ไม่มี smartphone ยังเข้าถึงบริการได้
- [ ] Phase 1 regression tests ผ่าน
- [ ] Backup/restore และ rollback ผ่านการทดสอบ
- [ ] เจ้าของระบบอนุมัติ pilot, monitoring และ incident plan

## 22. สรุป

Phase 2 ควรเพิ่ม patient-experience layer ผ่าน LINE OA/LIFF โดยให้ Queue Engine และ workflow เดิมเป็น source of truth หลังตรวจสอบจริง จุดเสี่ยงหลักคือ identity linking, การแยก booking/appointment, quota concurrency, duplicate queue tickets, privacy leaks และช่องทางสำหรับผู้ไม่มี smartphone

ลำดับที่ปลอดภัยคือ **Repository discovery → decisions/schema mapping → contracts/migration design → backend/queue integration → LINE/LIFF → controlled pilot** ห้ามเริ่มจากเพิ่ม schema หรือสร้าง UI ตามเอกสารนี้โดยไม่ตรวจระบบจริง
