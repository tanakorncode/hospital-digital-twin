// Numbered schema changes, applied once each, in order, when the API starts (DbService.migrate).
// Rules: only add — never edit a migration that has shipped (add a new one), never drop or rewrite Phase 1 tables.
// The Phase 1 tables (queue_events, kv, users, sessions, tickets, line_*) predate this list and stay as they are
// ("version 0"). Times are stored as UTC ISO-8601 text; screens show Thai local time.
export type Migration = { version: number; name: string; sql: string };

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'audit log and idempotency keys',
    sql: `
      -- Who did what to which record, and why. actor_id is an opaque reference (user:<id>, line:<hash>…), never a name or HN.
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('staff','patient','system','his')),
        actor_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        outcome TEXT NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok','denied','failed')),
        reason TEXT,
        request_id TEXT,
        meta_json TEXT);
      CREATE INDEX audit_log_created ON audit_log (created_at);
      CREATE INDEX audit_log_target ON audit_log (target_type, target_id, created_at);

      -- Retried requests (lost response, double tap) return the first result instead of acting twice.
      CREATE TABLE idempotency_keys (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope, key));
      CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);
    `,
  },
  {
    version: 2,
    name: 'visits and queue numbers',
    sql: `
      -- A real patient's visit today, taken into the queue by staff (registration / check-in) or by the HIS.
      -- No name, no HN: identity lives with the patient record (Phase 2 account linking), never on queue screens.
      -- steps_json: [{kind, at}] in order, append-only (queue actions refer to steps by position).
      CREATE TABLE visits (
        day TEXT NOT NULL,
        id TEXT NOT NULL,
        queue TEXT NOT NULL,
        flow TEXT NOT NULL CHECK (flow IN ('opd','er')),
        clinic_key TEXT,
        dept TEXT NOT NULL,
        priority TEXT,
        triage INTEGER CHECK (triage BETWEEN 1 AND 5),
        arrival INTEGER NOT NULL,
        steps_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
        source_type TEXT,
        source_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (day, id),
        UNIQUE (day, queue));
      -- One visit per source record (an HIS visit number, a booking): a repeated check-in finds the first one.
      CREATE UNIQUE INDEX visits_source ON visits (source_type, source_id) WHERE source_type IS NOT NULL;

      -- Running numbers per day and prefix (A001, A002 … ER001), taken inside the same transaction as the visit.
      CREATE TABLE queue_counters (
        day TEXT NOT NULL,
        prefix TEXT NOT NULL,
        last_no INTEGER NOT NULL,
        PRIMARY KEY (day, prefix));
    `,
  },
  {
    version: 3,
    name: 'patients and general booking',
    sql: `
      -- The hospital's patient as this system knows them. external_patient_id = the HN in the HIS (the HIS stays the
      -- source of truth). Never sent to public screens. VERIFIED = identity checked by staff (ID card) or the HIS.
      CREATE TABLE patient_profiles (
        id TEXT PRIMARY KEY,
        external_patient_id TEXT UNIQUE,
        identity_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (identity_status IN ('UNVERIFIED','VERIFIED','REVOKED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL);

      -- One policy per bookable service (an OPD clinic). Off until an administrator opens it.
      CREATE TABLE booking_policies (
        service_code TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
        advance_days INTEGER NOT NULL DEFAULT 14 CHECK (advance_days BETWEEN 0 AND 180),
        cancel_cutoff_minutes INTEGER NOT NULL DEFAULT 60 CHECK (cancel_cutoff_minutes BETWEEN 0 AND 10080),
        max_active_per_patient INTEGER NOT NULL DEFAULT 1 CHECK (max_active_per_patient BETWEEN 1 AND 10),
        policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
        updated_at TEXT NOT NULL,
        updated_by TEXT);

      -- Capacity by time. reserved_count can never pass capacity (the CHECK is the last line of defence; the
      -- booking transaction uses a conditional update so it never even tries).
      CREATE TABLE booking_slots (
        id TEXT PRIMARY KEY,
        service_code TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        capacity INTEGER NOT NULL CHECK (capacity >= 0),
        reserved_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_count >= 0 AND reserved_count <= capacity),
        status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','CANCELLED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (starts_at < ends_at),
        UNIQUE (service_code, starts_at));
      CREATE INDEX booking_slots_service_time ON booking_slots (service_code, starts_at, status);

      -- A reserved place in a slot. Not a queue number: the patient joins the queue at check-in.
      -- Idempotent creation uses idempotency_keys (scope per caller), so no key column is needed here.
      CREATE TABLE bookings (
        id TEXT PRIMARY KEY,
        booking_code TEXT NOT NULL UNIQUE,
        patient_profile_id TEXT NOT NULL REFERENCES patient_profiles(id),
        slot_id TEXT NOT NULL REFERENCES booking_slots(id),
        service_code TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('CONFIRMED','CANCELLED','EXPIRED','CHECKED_IN','CONVERTED_TO_QUEUE')),
        channel TEXT NOT NULL CHECK (channel IN ('STAFF','LINE')),
        created_by TEXT,
        visit_id TEXT,
        checked_in_at TEXT,
        cancelled_at TEXT,
        cancellation_reason TEXT,
        cancelled_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL);
      CREATE INDEX bookings_patient_status ON bookings (patient_profile_id, status);
      CREATE INDEX bookings_slot_status ON bookings (slot_id, status);
    `,
  },
];
