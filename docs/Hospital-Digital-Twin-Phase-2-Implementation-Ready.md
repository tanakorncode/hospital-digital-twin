# Hospital Digital Twin — Phase 2 Implementation-Ready Design

> **Purpose:** Design package for implementing Phase 2: LINE OA/LIFF patient experience, general queue booking, doctor appointments, check-in, wayfinding, staff tools, notifications, privacy, and operations.
>
> **Status:** Implementation-ready design baseline. This document does not claim that code has been implemented or that proposed names match the current repository.
>
> **Critical rule:** Inspect the real repository before editing. Reuse the Phase 1 Queue Engine, identity/RBAC, event mechanisms, map data, settings, and UI conventions wherever they already exist. Do not create duplicate sources of truth.

## 0. Executive decisions

1. **General Queue Booking** and **Doctor Appointment** are separate domains with separate policies and capacity.
2. A booking/appointment is not automatically a Queue Ticket. Check-in is the integration boundary unless repository discovery proves the existing system behaves differently.
3. The Phase 1 Queue Engine remains the source of truth for live queue state.
4. The backend derives patient identity from a verified session/link. Never accept a patient ID from a patient-facing request as authorization.
5. Mutations that can be retried must be idempotent.
6. Quota reservation and state changes must be transaction-safe under concurrent requests.
7. LINE messages, public TV screens, QR codes, logs, analytics and AI views must not expose unnecessary patient information.
8. Patients without LINE or smartphones retain an assisted/legacy service path.
9. Phase 1 routes, displays, events and tests must remain operational.
10. Feature flags allow booking, appointments, notifications and wayfinding to be enabled independently.

### 0.1 Definition of implementation-ready

This document supplies domain boundaries, state machines, proposed schema, endpoint contracts, DTO examples, service responsibilities, transaction algorithms, security controls, UI behavior, tests, rollout and rollback. Exact file paths, names, database adapter and queue-ticket API must be mapped to the repository before code is written.

### 0.2 Baseline to verify

Project context indicates:
- pnpm monorepo
- `apps/web`: Next.js App Router, React, three.js / React Three Fiber / drei
- `apps/api`: NestJS + Socket.IO
- `packages/contracts`
- SQLite via `node:sqlite`
- Docker Compose + Caddy HTTPS
- GitHub Actions
- Phase 1 2D/3D map, queue console, supervisor tools, TV screens, command center, HIS ingest, RBAC and real-time events

A prior baseline was reported as API 30 + Web 16 = 46 tests. **Verify the actual baseline** rather than assuming it is unchanged.

---

## 1. Repository discovery gate — mandatory before coding

### 1.1 Inspect in this order

1. `README` and repository instructions (`AGENTS.md`, Claude instructions, contributing docs).
2. Root `package.json`, `pnpm-workspace.yaml`, lockfile and package scripts.
3. `apps/api` modules/controllers/services/guards/interceptors/DTOs.
4. Database adapter, schema, migrations, seed data and transaction helpers.
5. Actual code path that creates, updates and broadcasts a Queue Ticket.
6. Existing user/session/patient identity models and authentication.
7. RBAC permission definitions and staff scope restrictions.
8. Socket.IO gateway, event names, room authorization and payloads.
9. Existing settings, audit log, domain event/outbox, job worker and scheduler.
10. Existing LINE webhook/LIFF integration and secret handling.
11. `apps/web` routes/components for patient views, `/tv`, `/real-map`, `/real-map-3d`.
12. Backup/restore scripts, Docker/Caddy config and CI workflows.
13. All existing tests and commands that run them.

### 1.2 Required discovery artifact

Create `docs/PHASE-2-IMPLEMENTATION-PLAN.md` before implementation. It must list:
- observed facts with file paths and line references
- existing Queue Ticket creation sequence
- schema reuse/new-schema mapping
- route and DTO conventions
- authentication and RBAC mapping
- event and notification mechanisms
- actual transaction capabilities of the SQLite driver
- gaps, risks, open questions and exact implementation order
- baseline test commands and results

Do not modify app code during discovery. Mark anything not proven from code as `UNVERIFIED`.

### 1.3 Non-regression inventory

Verify `/real-map`, `/real-map-3d`, `/tv`, queue console, supervisor tools, command center, HIS ingest, current Socket.IO event contract, RBAC, audit trail, health endpoints, Docker Compose, Caddy HTTPS, backup/restore and all existing API/Web tests.

---

## 2. Scope and module boundaries

### 2.1 User-facing features

| ID | Feature | Main behavior |
|---|---|---|
| P2-01 | LINE OA Rich Menu | Entry points to LIFF pages and help |
| P2-02 | LIFF session | Verify LINE identity and establish app session |
| P2-03 | Account linking | Bind LINE subject to verified patient identity |
| P2-04 | My Queue | Show the current patient's queue state |
| P2-05 | General booking | Reserve a service slot |
| P2-06 | Doctor appointments | Reserve provider/clinic appointment slots |
| P2-07 | Cancel/reschedule | Apply domain policies and preserve audit history |
| P2-08 | Check-in | Validate booking/appointment and integrate with Queue Engine |
| P2-09 | Notifications | Confirmation, reminders and important changes |
| P2-10 | Wayfinding | QR to public destination and reuse existing map |
| P2-11 | Staff console | Search/manage bookings, appointments and check-ins |
| P2-12 | Operations | Policy/slot management, audit, metrics, recovery |

### 2.2 Proposed backend boundaries

Reuse existing module conventions. Logical responsibilities:
- `PatientIdentity`: verified link and current patient resolution
- `Booking`: general service booking policy, capacity and lifecycle
- `Appointments`: provider schedules, appointment capacity and lifecycle
- `CheckIn`: validate source record and coordinate queue conversion
- `QueueEngineAdapter`: one integration boundary to the existing queue service
- `Notifications`: job creation, dispatch, retry, dedupe and delivery log
- `Wayfinding`: public destinations and map references
- `Audit`: actor, action, target, reason and correlation ID
- `Realtime`: publish authorized changes using existing gateway
- `Admin/Staff`: policy enforcement and staff operations

These are responsibilities, not mandatory folder names. Do not duplicate existing modules.

### 2.3 Data ownership

| Data | Source of truth |
|---|---|
| Live Queue Ticket and called/serving state | Existing Queue Engine |
| Patient identity/HN | Approved existing patient source (HIS or verified system) |
| LINE subject link | Phase 2 identity-link record, if no existing equivalent |
| General booking | Booking domain |
| Doctor appointment schedule/booking | Appointment domain or approved HIS integration |
| Map destination and map node | Existing map data if available |
| Notification delivery | Notification job/log subsystem |
| Staff permissions | Existing RBAC |

If HIS is authoritative for appointments, Phase 2 must not silently create a conflicting second schedule. This is a release blocker to resolve.

---

## 3. Core domain rules

### 3.1 General booking vs doctor appointment

**General Queue Booking**
- Patient selects a service/department and an open date/time slot.
- Patient does not select a specific doctor unless policy explicitly allows it.
- Capacity is owned by a `booking_slot`.
- A booking reference confirms reservation only.
- Queue ticket is issued/linked at check-in unless existing Queue Engine semantics require another flow.

**Doctor Appointment**
- Patient selects clinic/provider/slot allowed by policy.
- Capacity is owned by an `appointment_slot`.
- Cancellation/reschedule policy is independent of general booking.
- An appointment is not a walk-in ticket.
- Rescheduling must reserve the new slot and update the appointment atomically.

### 3.2 Identity and privacy
- Resolve current patient server-side from authenticated session and verified link.
- Never accept patient ID from the client as proof of ownership.
- Do not expose full name/HN/diagnosis/results in LINE push, public QR, TV or public Socket.IO rooms.
- Use only fields required by the screen/operation.
- Opaque IDs do not replace authorization.

### 3.3 State rules
- Every mutation validates current state server-side.
- Terminal states cannot be reopened through generic updates.
- Cancellation, expiration, reschedule and quota release happen at most once.
- No-show requires an approved rule and authorized evidence; failure to click a LINE message is not evidence.
- Staff overrides require permission, reason and audit.

---

## 4. Domain state machines

### 4.1 General booking

```text
OPEN SLOT
   | reserve atomically
   v
CONFIRMED -------- cancel within policy ------> CANCELLED
   |
   | patient/staff check-in
   v
CHECKED_IN
   |
   | queue adapter succeeds
   v
CONVERTED_TO_QUEUE
```

Optional states such as `PENDING_CONFIRMATION`, `EXPIRED`, `REJECTED` should only be added if the flow requires them. Use the repository's established state naming if available.

Allowed transitions:
- `CONFIRMED -> CANCELLED` if cancellation policy allows.
- `CONFIRMED -> EXPIRED` only through an explicit expiry rule and job.
- `CONFIRMED -> CHECKED_IN` after validated check-in.
- `CHECKED_IN -> CONVERTED_TO_QUEUE` only after Queue Engine confirms the ticket.
- Repeated check-in returns current result idempotently.
- `CANCELLED` and `CONVERTED_TO_QUEUE` are terminal for ordinary patient commands.

### 4.2 Doctor appointment

```text
OPEN APPOINTMENT SLOT
   | reserve atomically
   v
CONFIRMED ---- cancel allowed ----> CANCELLED
   |
   | reschedule request (if approval needed)
   v
RESCHEDULE_REQUESTED ---- approved ----> CONFIRMED at new slot
   |
   | check-in
   v
CHECKED_IN ---- provider/HIS confirms completion ----> COMPLETED
```

`NO_SHOW` may only be set under an approved clinic policy, by authorized staff/system action, with audit. Never infer it from LINE inactivity.

### 4.3 Check-in states
`RECEIVED`, `VALIDATING`, `QUEUE_CREATION_PENDING`, `COMPLETED`, `FAILED_RETRYABLE`, `FAILED_FINAL`.

A retry must resume/reconcile the existing record. Never create a second ticket because the previous network response timed out.

---

## 5. Data model and migration plan

> SQL below is a logical starting point. Compare with actual tables and reuse existing identity, user, queue, event, settings and audit models before migration.

### 5.1 Proposed tables

| Table | Purpose | Safeguards |
|---|---|---|
| `patient_profiles` | Internal patient reference if none exists | Unique external patient reference; verified status |
| `line_patient_links` | LINE subject ↔ patient reference | Unique LINE subject; verified timestamp; unlink state |
| `booking_policies` | General booking rules | Server-side validation; versioned policy |
| `booking_slots` | Service capacity by time | `reserved_count <= capacity`; open/closed state |
| `bookings` | General booking lifecycle | Unique code, idempotency key, request hash |
| `provider_schedules` | Provider/clinic schedule | Time range and status validation |
| `appointment_slots` | Appointment capacity | Capacity constraint |
| `appointments` | Appointment lifecycle | Unique code, idempotency key, request hash |
| `appointment_reschedule_requests` | Approval workflow if needed | Actor, decision and timestamps |
| `check_in_records` | Check-in/queue conversion | Unique source + idempotency key |
| `notification_jobs` | Scheduled/delayed delivery | Dedupe key, attempts, status |
| `notification_logs` | Delivery outcomes | Minimal provider response data |
| `domain_events` | Outbox if no existing equivalent | Retryable publish status |

### 5.2 SQLite reference schema

This is for design review. **Do not run directly against production.** Adapt IDs, names, timestamps, and foreign keys to the actual repository.

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
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
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
    'CONFIRMED','CANCELLED','EXPIRED','CHECKED_IN','CONVERTED_TO_QUEUE'
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
    'CONFIRMED','RESCHEDULE_REQUESTED','CANCELLED','CHECKED_IN',
    'COMPLETED','NO_SHOW','EXPIRED'
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

### 5.3 Migration review checklist
- Reuse an existing patient table if authoritative.
- Determine whether HIS owns schedules/appointments.
- Add foreign keys only where ownership/lifecycle are understood.
- Choose one timestamp format (UTC ISO-8601 or epoch); convert to Thai local time only for presentation.
- Consider partial unique indexes for active bookings if policy requires.
- Release quota exactly once on cancellation/expiration.
- Validate and version policy JSON.
- Calculate request hash server-side from canonical request data.
- Never store OTP or LINE access tokens in plaintext.
- Do not put PHI in event payloads unless strictly required.

---

## 6. Transaction algorithms

### 6.1 Reserve capacity atomically

Never use “read reserved_count, check in app, then update” without a transaction.

1. Begin a serialized write transaction (for SQLite, verify `BEGIN IMMEDIATE` support in the actual driver).
2. Look up idempotency key in the correct scope.
3. Existing key + same request hash: return existing result.
4. Existing key + different hash: return `409 IDEMPOTENCY_KEY_REUSED`.
5. Validate slot open, time window, policy enabled and patient booking rules.
6. Execute conditional increment:

```sql
UPDATE booking_slots
SET reserved_count = reserved_count + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id = ?
  AND status = 'OPEN'
  AND reserved_count < capacity;
```

7. If changed rows != 1, rollback and return `409 SLOT_FULL_OR_CLOSED`.
8. Insert booking and outbox event (if used).
9. Commit.
10. Queue notification asynchronously after commit.

Repeat the same algorithm for appointment slots. Test with the real SQLite driver/runtime, not mocks only.

### 6.2 Cancel and release capacity
1. Load record and validate ownership/permission.
2. Validate current state and cutoff.
3. In one transaction, conditional-update active state to cancelled.
4. Only if transition succeeded, decrement the corresponding slot count.
5. Record audit/outbox event in the same transaction where possible.
6. Commit; enqueue notification afterward.
7. Retry returns the cancelled state and never decrements capacity twice.

### 6.3 Reschedule appointment
If approval is required:
1. Create `appointment_reschedule_requests` without changing the confirmed slot.
2. Staff reviews request.
3. On approval, in one transaction reserve new slot, release old slot and update appointment slot/status.
4. If the new slot cannot be reserved, leave original appointment unchanged.
5. Store actor, decision, reason and timestamps.
6. Cancel obsolete reminder jobs and schedule reminders for the new appointment time.

If self-service reschedule is allowed, use the same atomic reserve-new/release-old pattern and idempotency.

### 6.4 Idempotency
Required for booking, appointment creation, check-in, cancellation/reschedule and other retryable mutations:
- Store key, canonical request hash, result/resource reference and creation time.
- Scope keys by actor/operation or another documented scope.
- Same key + same payload returns the same result.
- Same key + different payload returns conflict.
- Queue Engine itself must dedupe by source/idempotency key, or the risk must be resolved before production.
- Set retention according to retry and recovery windows.

---

## 7. Queue Engine integration contract

### 7.1 Adapter responsibility
The adapter is the only Phase 2 boundary to the existing Queue Engine. Map fields to actual conventions:

```ts
export type CreateQueueTicketInput = {
  sourceType: 'BOOKING' | 'APPOINTMENT' | 'WALK_IN';
  sourceId: string;
  idempotencyKey: string;
  patientReference: string;
  serviceCode: string;
};

export type CreateQueueTicketResult = {
  ticketId: string;
  displayNumber?: string;
  status: string;
};

export interface QueueEngineAdapter {
  createTicket(input: CreateQueueTicketInput): Promise<CreateQueueTicketResult>;
  getTicket(ticketId: string): Promise<CreateQueueTicketResult | null>;
}
```

This is a logical contract, not an existing interface. Adapt it to actual identifiers and return types.

### 7.2 Check-in command algorithm
1. Authenticate patient or staff.
2. Resolve source booking/appointment and verify owner/permission.
3. Validate source state and check-in window.
4. Create/find `check_in_records` using unique source + idempotency key.
5. Persist `QUEUE_CREATION_PENDING` before external call.
6. Call Queue Engine with stable source/idempotency key.
7. On success, persist ticket ID and mark source/check-in completed.
8. On timeout/unknown result, query/reconcile by source key before retrying.
9. On transient failure, mark retryable and schedule retry.
10. On permanent policy failure, mark final and surface a staff action.

SQLite and Queue Engine may not share a transaction. Use durable state/outbox/reconciliation, not a fictitious distributed transaction.

### 7.3 Failure matrix

| Failure | Required behavior |
|---|---|
| Queue Engine succeeds | Persist ticket reference; return current result |
| Request times out | Query by idempotency/source; do not blindly create again |
| Queue Engine unavailable | Keep retryable pending state; show clear message |
| DB update fails after ticket creation | Reconcile by source key and repair local record |
| Duplicate check-in request | Return existing check-in/ticket |
| Source cancelled before check-in | Reject check-in |
| Ticket already exists in Phase 1 | Link/reconcile existing ticket if policy permits |

---

## 8. API contracts

> Paths are proposals. Match the repository's existing prefix, auth guards, validation library, error format and naming before implementation.

### 8.1 Patient endpoints

| Method | Proposed path | Purpose |
|---|---|---|
| POST | `/api/v1/patient/line/session` | Verify LINE token and establish app session |
| GET | `/api/v1/patient/me` | Current linked patient summary |
| POST | `/api/v1/patient/link/start` | Start account-link proof |
| POST | `/api/v1/patient/link/verify` | Verify proof and create link |
| POST | `/api/v1/patient/link/unlink` | Revoke/unlink according to policy |
| GET | `/api/v1/patient/queue` | Current patient's active queue |
| GET | `/api/v1/patient/queue/:id` | Authorized queue detail |
| GET | `/api/v1/booking/services` | Bookable services |
| GET | `/api/v1/booking/slots` | Available general booking slots |
| POST | `/api/v1/bookings` | Create booking |
| GET | `/api/v1/bookings` | List own bookings |
| GET | `/api/v1/bookings/:id` | Read own booking |
| POST | `/api/v1/bookings/:id/cancel` | Cancel own booking |
| GET | `/api/v1/appointments/clinics` | Clinics open for appointments |
| GET | `/api/v1/appointments/providers` | Allowed provider choices |
| GET | `/api/v1/appointments/slots` | Available appointment slots |
| POST | `/api/v1/appointments` | Create appointment |
| GET | `/api/v1/appointments` | List own appointments |
| GET | `/api/v1/appointments/:id` | Read own appointment |
| POST | `/api/v1/appointments/:id/cancel` | Cancel own appointment |
| POST | `/api/v1/appointments/:id/reschedule-requests` | Request reschedule |
| GET | `/api/v1/wayfinding/destinations` | Public destinations |
| GET | `/api/v1/wayfinding/destinations/:code` | Destination detail |

### 8.2 Staff/admin endpoints

| Method | Proposed path | Purpose |
|---|---|---|
| GET | `/api/v1/staff/bookings` | Search within authorized scope |
| GET | `/api/v1/staff/appointments` | Search within authorized scope |
| POST | `/api/v1/staff/check-ins` | Staff-assisted check-in |
| POST | `/api/v1/staff/bookings/:id/cancel` | Authorized override with reason |
| POST | `/api/v1/staff/appointments/:id/cancel` | Authorized override with reason |
| POST | `/api/v1/staff/appointments/:id/reschedule` | Approve/reject/perform reschedule |
| GET | `/api/v1/admin/booking-policies` | List policies |
| PUT | `/api/v1/admin/booking-policies/:id` | Update policy with audit |
| POST | `/api/v1/admin/booking-slots` | Create slots |
| PATCH | `/api/v1/admin/booking-slots/:id` | Change slot status/capacity |
| POST | `/api/v1/admin/provider-schedules` | Create provider schedules |
| POST | `/api/v1/admin/appointment-slots` | Create appointment slots |
| GET | `/api/v1/admin/notification-jobs` | Inspect delivery jobs |

Do not expose routes merely because they appear here; each requires explicit permission and DTO validation.

### 8.3 Create booking request

```http
POST /api/v1/bookings
Authorization: Bearer <app-session-token>
Idempotency-Key: <unique-operation-key>
Content-Type: application/json
```

```json
{ "slotId": "slot_public_id" }
```

Do not accept patient identity, service code, slot time or quota values from the client as authoritative. Derive them from the verified session and server-side slot.

Example response (illustrative, not an existing API):

```json
{
  "data": {
    "id": "booking_public_id",
    "bookingCode": "BK-EXAMPLE",
    "status": "CONFIRMED",
    "service": {
      "code": "OPD_EXAMPLE",
      "displayName": "ตัวอย่างหน่วยบริการ"
    },
    "slot": {
      "startsAt": "2026-11-01T02:00:00Z",
      "endsAt": "2026-11-01T03:00:00Z"
    },
    "nextStep": "CHECK_IN_AT_HOSPITAL"
  }
}
```

### 8.4 Create appointment request
Request: `{"slotId":"appointment_slot_public_id"}`. Derive patient identity and appointment details server-side. Return only appointment code, status, approved clinic/provider display fields and time; never return medical records.

### 8.5 Common errors

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 401 | `AUTH_REQUIRED` | No valid app session |
| 403 | `FORBIDDEN` | Permission denied |
| 404 | `RESOURCE_NOT_FOUND` | Not found or not accessible |
| 409 | `SLOT_FULL_OR_CLOSED` | Slot not bookable |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key, different payload |
| 409 | `INVALID_STATE_TRANSITION` | Current state disallows command |
| 422 | `POLICY_REJECTED` | Business rule denied |
| 429 | `RATE_LIMITED` | Too many attempts |
| 503 | `QUEUE_ENGINE_UNAVAILABLE` | Queue integration unavailable |

Avoid errors that reveal whether a specific patient/HN exists.

---

## 9. LINE OA and LIFF design

### 9.1 Rich Menu
Recommended entry points:
1. คิวของฉัน
2. จองคิวบริการ
3. นัดแพทย์
4. แผนที่โรงพยาบาล
5. เชื่อมบัญชีผู้ป่วย
6. ติดต่อเจ้าหน้าที่

Verify current LINE OA/LIFF limits and account configuration before publishing.

### 9.2 LIFF session flow
1. LIFF obtains the supported LINE login token/context.
2. Client sends token to backend over HTTPS.
3. Backend verifies token with the correct LINE verification mechanism.
4. Backend creates/returns an application session with explicit expiry/revocation rules.
5. Backend resolves an active verified patient link.
6. If no link exists, expose only account-linking/help screens.
7. Patient endpoints derive identity from server-side session state.

Never trust a client-supplied LINE subject or patient ID alone.

### 9.3 Account-linking protocol
- Start: create short-lived linking challenge and send no patient details in response.
- Verify: validate OTP or approved proof against the hospital-controlled source.
- Limit OTP issue/verification attempts; expire challenges; prevent replay.
- Bind verified LINE subject to patient record inside a transaction.
- Enforce uniqueness and handle account migration explicitly.
- Audit link/unlink actor, time, method and outcome without storing secrets.
- Support staff-assisted verification.
- HN + self-entered phone number alone is not sufficient identity proof.

### 9.4 Chatbot behavior
Intents: My Queue, Book Queue, Appointments, Reschedule/Cancel, Wayfinding, Link Account, Contact Staff. Route patient-specific details to authenticated LIFF rather than echoing PHI into chat text.

---

## 10. Notifications

### 10.1 Notification types
- booking confirmed/cancelled
- appointment confirmed/reminder
- reschedule request received/approved/rejected
- check-in successful
- useful queue status updates, not excessive
- service/slot cancellation or material change

### 10.2 Privacy-safe copy
- “ยืนยันการจองเรียบร้อยแล้ว กรุณาเปิดเมนูคิวของฉันเพื่อดูรายละเอียด”
- “มีนัดหมายใกล้ถึงเวลา กรุณาตรวจสอบวัน เวลา และจุดบริการใน LIFF”
- “สถานะคิวมีการเปลี่ยนแปลง กรุณาเปิดเมนูคิวของฉัน”

Avoid full name, HN, diagnosis, results and treatment details in push notifications.

### 10.3 Worker contract
- Persist job after domain transaction commit or insert outbox in the same transaction.
- Claim jobs safely so multiple workers cannot process the same job simultaneously.
- Use unique `dedupe_key`.
- Retry transient errors with exponential backoff and jitter.
- Stop/review permanent failures; cap attempts.
- Store minimal provider result/error data.
- Cancel/recalculate reminders when appointment changes.
- Notification failure must not roll back a valid booking.
- Verify LINE rate limits and webhook signature rules against current provider docs.

---

## 11. Wayfinding

### 11.1 Public QR
Example placeholder: `https://<hospital-domain>/wayfinding?to=OPD-REGISTRATION`

QR may contain only a public destination code and non-sensitive routing parameters. Never encode patient/HN/appointment/booking identifiers or bearer tokens.

### 11.2 Destination model
Potential fields: `code`, `display_name_th`, `building`, `floor`, `description_th`, `map_node_id`, `is_public`, `status`, `updated_at`.

Reuse the existing Phase 1 map/node model if available. Do not create a second coordinate graph without a clear reason.

### 11.3 UI behavior
- Show destination name, building, floor and landmarks.
- Reuse existing 2D/3D map and route model where possible.
- If location permission is denied, let the patient select a starting point.
- Offer text directions and staff assistance.
- Retired QR targets should show a helpful destination-not-available page.

---

## 12. Staff Console

### 12.1 Screens
- Today's general bookings
- Today's doctor appointments
- Search by booking/appointment code and authorized filters
- Check-in workflow
- Cancel/override with reason
- Reschedule approval queue
- Slot/quota and provider schedule management
- Failed notification jobs
- Audit history

### 12.2 Staff commands
- Check permission on the server for every command.
- Require reason for override where policy says so.
- Use optimistic UI carefully; refresh source-of-truth state after command.
- Disable duplicate clicks in UI, but do not rely on UI to prevent duplicates.
- Keep PHI off public displays and broad command-center views.
- Scope staff search to authorized departments/roles.
- Staff-assisted workflow must support patients without smartphone/LINE.

---

## 13. Socket.IO and event model

Use the existing gateway and event naming style if available. Proposed logical events only:
- `booking.created`
- `booking.cancelled`
- `appointment.confirmed`
- `appointment.cancelled`
- `appointment.reschedule_requested`
- `appointment.rescheduled`
- `checkin.completed`
- `queue.ticket.updated`
- `notification.failed`

Payloads must be minimal and versioned. Include `eventId` for dedupe and timestamp. Authorize patient-specific rooms. Public/TV rooms receive only redacted fields. Never broadcast PHI.

For reliable DB + event delivery, use the existing outbox/event mechanism or add one only if required. A DB commit followed by an in-memory socket emit is not crash-safe. Reconnecting clients must refetch API state to reconcile missed events.

---

## 14. Security, PDPA and audit

### 14.1 Authentication
- Verify LINE tokens server-side according to token type and current provider requirements.
- Validate signature/issuer/audience/expiry as appropriate.
- Define app session expiration, revocation and rotation.
- Apply cookie flags/CSRF protection according to the selected LIFF/session architecture.
- Keep channel secrets/access tokens out of Git and client bundles.

### 14.2 Authorization
- Prevent IDOR on all patient resource routes.
- Derive current patient from verified session/link.
- Scope staff access by permission and department.
- Rate-limit OTP, link, search and booking operations.
- Use privacy-preserving errors to prevent patient enumeration.

### 14.3 Data minimization
- Collect only required patient data.
- Define purpose, retention, deletion and access roles with hospital privacy owners.
- Redact tokens, OTP, authorization headers and PHI from logs.
- Do not put PHI in metric labels or broad event payloads.
- AI/analytics should use aggregate/de-identified data; no external model receives identifiable patient data without explicit approval and risk assessment.

### 14.4 Audit event fields
Suggested fields: `id`, `actor_type`, `actor_id` (opaque reference), `action`, `target_type`, `target_id`, `outcome`, `reason`, `request_id`, `correlation_id`, `created_at`, and minimal metadata without secrets/PHI. Reuse existing audit schema if present.

### 14.5 Incident response
Runbook must cover session/link revocation, feature flag/slot shutdown, pausing incorrect notifications, queue reconciliation, restricted evidence preservation, notification to security/privacy owner, and evaluation of applicable legal obligations.

---

## 15. Observability and operations

### 15.1 Metrics
- booking/appointment attempts, success, rejects and cancellations
- slot-full conflicts and idempotent replays
- check-in success/failure
- Queue Engine latency/errors/retries
- notification sent/retry/failed
- LINE token/webhook failures
- rate-limit events
- API latency/error rates
- SQLite busy/lock contention if observable

Never use patient identifiers as metric labels.

### 15.2 Logs
Log correlation ID, operation, resource type/opaque ID where appropriate, outcome, error code, latency and retry count. Do not log full request bodies, secrets, OTP or unnecessary PHI.

### 15.3 SQLite
- Keep write transactions short.
- Do not perform network I/O inside write transactions.
- Verify WAL mode, busy timeout and transaction support in actual runtime.
- Test concurrent requests against production-equivalent driver.
- If expected concurrency/HA exceeds SQLite's operational envelope, document an architecture decision; do not silently migrate databases as part of feature implementation.

### 15.4 Backup/restore
- Include Phase 2 data in existing backup method.
- Validate SQLite/WAL consistency.
- Run restore tests in an isolated environment.
- Define acceptable RPO/RTO.
- Protect backups with appropriate access control and encryption.

---

## 16. Test plan

### 16.1 Unit tests
Policy/input validation, state transitions, cancellation cutoff, quota rules, canonical request hash, idempotency, notification redaction, permission checks and audit generation.

### 16.2 Integration tests
- create/read/cancel general booking
- create/read/cancel appointment
- quota release exactly once
- reschedule reserves new slot and releases old slot atomically
- check-in calls Queue Adapter
- Queue Engine timeout and reconciliation
- LINE token verification and link proof
- notification retry/dedupe
- outbox retry/publish
- migration behavior using repository's real migration tool

### 16.3 Concurrency tests
- capacity 1 with many simultaneous requests: at most one success
- capacity N with more than N requests: at most N successes
- same idempotency key and payload: one resource
- same key with different payload: conflict
- concurrent cancellation: quota released once
- duplicate check-in: one ticket
- worker restart during dispatch: recover without duplicate
- appointment reschedule racing for a full slot

### 16.4 Security tests
- Patient A cannot read/update Patient B's resources
- client-supplied patient ID is ignored/rejected
- invalid/expired/wrong-audience LINE token rejected
- OTP rate limiting and anti-enumeration
- unauthorized staff override rejected
- QR/public/TV payload contains no PHI
- secrets/PHI absent from logs
- invalid webhook signature rejected
- department scope enforced

### 16.5 Regression tests
Run the full existing suite before and after every stage. Verify `/tv`, map pages, queue console, supervisor tools, command center, HIS ingest and Socket.IO flows with existing tests/manual checks.

### 16.6 Pilot acceptance gates
Do not enable real-patient pilot until:
1. General booking and appointments have separate policies and quotas.
2. Concurrent reservations never exceed capacity.
3. Booking/appointment/check-in operations are idempotent.
4. Queue integration can reconcile ambiguous timeouts.
5. Account linking passes security/privacy review.
6. Notifications have retry/dedupe and safe content.
7. Staff override is protected by RBAC and audit.
8. Public screens/QR/events pass privacy review.
9. Patients without smartphones have an approved service path.
10. Phase 1 regression suite passes.
11. Backup/restore and incident recovery are tested.
12. Hospital owner approves policy, retention, consent, copy and pilot scope.

---

## 17. Implementation sequence and dependencies

### Stage 0 — Discovery
Deliver `docs/PHASE-2-IMPLEMENTATION-PLAN.md`; no application code edits.

### Stage 1 — Decisions and contracts
Approve identity proof, schedule ownership, booking/appointment rules, cancellation cutoff, queue conversion semantics, notification consent, retention and pilot scope.

### Stage 2 — Persistence and backend domain
Implement migrations only after schema mapping; policy services; capacity-safe transactions; idempotency; state transitions; audit; unit/integration tests.

### Stage 3 — Queue integration
Implement adapter, check-in state machine, idempotent queue creation and reconciliation tests.

### Stage 4 — Identity and LINE foundation
Verify tokens, app session, account linking/unlinking, rate limiting and privacy-safe failure messages.

### Stage 5 — Patient LIFF screens
My Queue, Book Queue, Appointments, Wayfinding, error/loading/empty states and accessibility.

### Stage 6 — Staff console and notifications
Staff workflows, slot management, reminder worker, retries/dedupe, failed-job review.

### Stage 7 — Hardening and pilot
Security review, concurrency/load tests, restore test, training, feature-flagged pilot, monitoring and rollback rehearsal.

Dependencies:
- Booking/Appointment UI depends on approved API contracts and policies.
- Check-in depends on Queue Adapter idempotency.
- Patient-specific screens depend on verified account linking.
- Notifications depend on durable jobs/outbox and consent.
- Pilot depends on security, privacy, recovery and regression gates.

---

## 18. Feature flags and rollout

Proposed independent flags:
- `phase2.accountLinking.enabled`
- `phase2.generalBooking.enabled`
- `phase2.appointments.enabled`
- `phase2.notifications.enabled`
- `phase2.wayfinding.enabled`
- `phase2.staffOverrides.enabled`

Reuse existing settings/flag conventions if available.

Rollout:
1. local/test with synthetic patient data
2. staging integration with provider/HIS sandbox where available
3. staff-only dry run
4. limited pilot in an approved service
5. monitor errors, capacity conflicts, duplicate prevention and feedback
6. expand only after review

Rollback:
- disable affected feature flag first
- preserve existing records
- pause notifications if content/delivery is wrong
- reconcile pending check-ins and tickets
- avoid destructive down-migrations
- maintain manual staff process
- record incident and follow-up actions

---

## 19. Product decisions requiring explicit approval

These must not be invented by implementation:
1. Patient identity source of truth (HIS or existing system).
2. Approved proof for LINE account linking.
3. General booking services and advance-booking window.
4. Quota allocation by service/date/time/patient class.
5. Whether patients may select a provider.
6. Cancellation/reschedule cutoff and approval policy.
7. Whether HIS owns provider schedules and appointments.
8. Queue ticket creation timing and existing ticket reconciliation.
9. LINE notification consent and opt-out behavior.
10. Patient data allowed in LIFF, notification and staff search.
11. Retention periods for links, bookings, audit and notifications.
12. Pilot departments, success metrics and stop criteria.
13. Staff permission for quota override.
14. Service path for patients without LINE/phone.
15. RPO/RTO and operational owner.

Use documented defaults only for development fixtures, never for live hospital policy.

---

## 20. Claude Code prompt — repository mapping only

Save this file as `docs/PHASE-2-IMPLEMENTATION-READY.md`, then ask Claude Code to perform discovery first.

```text
You are the repository architect for Hospital Digital Twin Phase 2.

Read docs/PHASE-2-IMPLEMENTATION-READY.md completely.

This is proposed design. It does not prove that any named table, route, service, event or file exists.

TASK 1 ONLY: inspect the repository and create docs/PHASE-2-IMPLEMENTATION-PLAN.md.
Do not implement Phase 2 yet.

Hard constraints:
- Do not edit application code, schema, migrations, configuration, lockfiles or tests.
- Do not invent repository facts, file paths, routes, event names or test results.
- Preserve all Phase 1 behavior and existing tests.
- Reuse existing services and models where possible; do not create duplicate sources of truth.
- Mark uncertain facts UNVERIFIED.

Inspect:
1. Repository instructions, workspace and scripts.
2. API modules, controllers, DTO validation, guards and error conventions.
3. Database schema, migration tool and transaction helpers.
4. Exact Queue Ticket creation/update/broadcast flow.
5. User/patient/session identity and current authentication.
6. RBAC permissions and staff scope.
7. Socket.IO event names, payloads and room authorization.
8. Audit, settings, event/outbox, scheduler and worker mechanisms.
9. LINE OA/webhook/LIFF integration, if any.
10. Web routes/components for /tv, /real-map, /real-map-3d and patient screens.
11. SQLite driver/runtime transaction and concurrency capabilities.
12. Backup/restore and current test baseline.

Create only docs/PHASE-2-IMPLEMENTATION-PLAN.md with:
- observed facts and file/line references
- actual architecture and Queue Ticket creation sequence
- mapping: proposed feature -> existing code/schema -> gap -> change
- reuse/new-schema decisions
- route/DTO/auth mapping
- queue idempotency and ambiguous timeout recovery
- security/PDPA risk register
- test baseline and exact test commands/results
- staged implementation order and dependencies
- questions requiring human/product-owner decisions
- rollback and acceptance gates

Do not edit any other file. Report exact files inspected, the one file created and commands run. Do not claim tests passed unless you ran them.
```

---

## 21. Definition of Done

- [ ] Repository discovery plan reviewed
- [ ] Patient identity and schedule source of truth approved
- [ ] General booking and doctor appointment policies approved
- [ ] Schema mapped to existing data model
- [ ] Migration reviewed and tested on a copy
- [ ] Quota concurrency tests pass
- [ ] Idempotency tests pass
- [ ] Queue timeout/reconciliation tests pass
- [ ] LINE linking security review passed
- [ ] LIFF accessibility/error-state review passed
- [ ] Notification retry/dedupe and privacy review passed
- [ ] Staff RBAC/audit tests pass
- [ ] Public QR/TV/socket payloads contain no PHI
- [ ] Patient without smartphone has a working path
- [ ] Existing Phase 1 regression tests pass
- [ ] Backup/restore and rollback rehearsal completed
- [ ] Hospital owner approves pilot and incident plan

## 22. Final implementation guidance

The highest-risk work is not the LIFF UI. It is:
1. linking LINE identity to the correct patient safely;
2. keeping booking and appointment policies distinct;
3. preventing overbooking under concurrency;
4. preventing duplicate Queue Tickets across retries and timeouts;
5. preventing PHI leakage through notifications, logs, sockets, TV and QR;
6. preserving access for patients who do not use smartphones.

The correct order is **inspect repository → resolve product/identity/integration decisions → map schema/contracts → implement backend and queue integration → implement LINE/LIFF → add staff/notifications → security/recovery testing → controlled pilot**.

No code or database changes should be made based only on this document until the discovery gate is complete.
