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
  {
    version: 4,
    name: 'check-in',
    sql: `
      -- Per service: the queue-number letter, and when a booked patient may check in at the kiosk
      -- (from N minutes before the slot until N minutes after it ends; staff at the counter may check in later the same day).
      ALTER TABLE booking_policies ADD COLUMN queue_prefix TEXT;
      ALTER TABLE booking_policies ADD COLUMN checkin_early_minutes INTEGER NOT NULL DEFAULT 120;
      ALTER TABLE booking_policies ADD COLUMN checkin_late_minutes INTEGER NOT NULL DEFAULT 60;

      -- Which patient a visit belongs to (never sent to screens), and the booked time staff see beside the number.
      ALTER TABLE visits ADD COLUMN patient_profile_id TEXT;
      ALTER TABLE visits ADD COLUMN booked_slot TEXT;

      -- One check-in per booking (or appointment): repeating it finds this record and the same visit.
      CREATE TABLE check_in_records (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL CHECK (source_type IN ('BOOKING','APPOINTMENT','WALK_IN')),
        source_id TEXT NOT NULL,
        patient_profile_id TEXT REFERENCES patient_profiles(id),
        status TEXT NOT NULL CHECK (status IN ('COMPLETED')),
        visit_day TEXT NOT NULL,
        visit_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('COUNTER','KIOSK','LINE')),
        late INTEGER NOT NULL DEFAULT 0 CHECK (late IN (0,1)),
        created_by TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (source_type, source_id));
    `,
  },
  {
    version: 5,
    name: 'doctor appointments',
    sql: `
      -- Doctor appointments: a separate domain from general booking — own rules, own capacity, own codes (AP…).
      -- If the hospital's HIS already owns appointments, leave this switched off (no second schedule).
      CREATE TABLE appointment_policies (
        clinic_code TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
        advance_days INTEGER NOT NULL DEFAULT 90 CHECK (advance_days BETWEEN 0 AND 365),
        cancel_cutoff_minutes INTEGER NOT NULL DEFAULT 1440 CHECK (cancel_cutoff_minutes BETWEEN 0 AND 20160),
        reschedule_needs_approval INTEGER NOT NULL DEFAULT 1 CHECK (reschedule_needs_approval IN (0,1)),
        patient_selects_provider INTEGER NOT NULL DEFAULT 0 CHECK (patient_selects_provider IN (0,1)),
        queue_prefix TEXT,
        checkin_early_minutes INTEGER NOT NULL DEFAULT 120,
        checkin_late_minutes INTEGER NOT NULL DEFAULT 60,
        policy_version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        updated_by TEXT);

      -- A doctor's clinic session (one day, one block of time). provider_code = the doctor's code in the HIS / licence no.
      CREATE TABLE provider_schedules (
        id TEXT PRIMARY KEY,
        provider_code TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        clinic_code TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','CANCELLED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (starts_at < ends_at),
        UNIQUE (provider_code, starts_at));
      CREATE INDEX provider_schedules_clinic_time ON provider_schedules (clinic_code, starts_at, status);

      CREATE TABLE appointment_slots (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES provider_schedules(id),
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        capacity INTEGER NOT NULL CHECK (capacity >= 0),
        reserved_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_count >= 0 AND reserved_count <= capacity),
        status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','CANCELLED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (starts_at < ends_at),
        UNIQUE (schedule_id, starts_at));
      CREATE INDEX appointment_slots_schedule_time ON appointment_slots (schedule_id, starts_at, status);

      -- While a reschedule request waits, the appointment keeps its confirmed slot (status stays CONFIRMED).
      -- NO_SHOW is only ever set by authorised staff with a reason — never from LINE inactivity.
      CREATE TABLE appointments (
        id TEXT PRIMARY KEY,
        appointment_code TEXT NOT NULL UNIQUE,
        patient_profile_id TEXT NOT NULL REFERENCES patient_profiles(id),
        slot_id TEXT NOT NULL REFERENCES appointment_slots(id),
        clinic_code TEXT NOT NULL,
        provider_code TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('CONFIRMED','CANCELLED','CHECKED_IN','COMPLETED','NO_SHOW','EXPIRED')),
        channel TEXT NOT NULL CHECK (channel IN ('STAFF','LINE')),
        created_by TEXT,
        visit_id TEXT,
        checked_in_at TEXT,
        cancelled_at TEXT,
        cancellation_reason TEXT,
        cancelled_by TEXT,
        no_show_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL);
      CREATE INDEX appointments_patient_status ON appointments (patient_profile_id, status);
      CREATE INDEX appointments_slot_status ON appointments (slot_id, status);

      CREATE TABLE appointment_reschedule_requests (
        id TEXT PRIMARY KEY,
        appointment_id TEXT NOT NULL REFERENCES appointments(id),
        requested_slot_id TEXT NOT NULL REFERENCES appointment_slots(id),
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
        reason TEXT,
        requested_by TEXT,
        decided_by TEXT,
        decided_at TEXT,
        decision_note TEXT,
        created_at TEXT NOT NULL);
      -- At most one waiting request per appointment.
      CREATE UNIQUE INDEX appointment_requests_pending ON appointment_reschedule_requests (appointment_id) WHERE status = 'PENDING';
    `,
  },
  {
    version: 6,
    name: 'LINE identity and account linking',
    sql: `
      -- A patient's app session, made after the server has verified a LINE ID token. Only the SHA-256 of the token
      -- is stored. line_subject = the LINE user id (kept to recognise the person and, later, to send them messages).
      CREATE TABLE patient_sessions (
        token_hash TEXT PRIMARY KEY,
        line_subject TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL);
      CREATE INDEX patient_sessions_subject ON patient_sessions (line_subject);

      -- LINE account ↔ hospital patient. Made only after the identity was checked (staff with the ID card for now).
      -- One active link per LINE account and per patient; a new phone replaces the old link (kept, as REVOKED).
      CREATE TABLE line_patient_links (
        id TEXT PRIMARY KEY,
        patient_profile_id TEXT NOT NULL REFERENCES patient_profiles(id),
        line_subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','UNLINKED','REVOKED')),
        method TEXT NOT NULL CHECK (method IN ('STAFF_ASSISTED','OTP','HIS')),
        verified_at TEXT NOT NULL,
        verified_by TEXT,
        ended_at TEXT,
        ended_by TEXT,
        end_reason TEXT,
        created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX line_links_active_subject ON line_patient_links (line_subject) WHERE status = 'ACTIVE';
      CREATE UNIQUE INDEX line_links_active_patient ON line_patient_links (patient_profile_id) WHERE status = 'ACTIVE';

      -- "Link my account" at the counter: the patient shows this one-time code (QR) from LINE; staff check the ID card
      -- and confirm. Short-lived; only the hash of the long QR token is stored.
      CREATE TABLE link_requests (
        id TEXT PRIMARY KEY,
        line_subject TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        short_code TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','USED','EXPIRED')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL);
    `,
  },
  {
    version: 7,
    name: 'notification jobs',
    sql: `
      -- Messages to patients, written in the same transaction as the change they report (so a committed booking never
      -- loses its message, and a rolled-back one never sends one) and sent afterwards by the worker, with retries.
      -- target: a patient (PROFILE — their linked LINE accounts at sending time) or one LINE user (the queue-slip
      -- subscription). payload_json: what the message needs — dates, times, queue numbers, codes; never a name or HN.
      CREATE TABLE notification_jobs (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL DEFAULT 'LINE' CHECK (channel IN ('LINE')),
        template TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        related_type TEXT,
        related_id TEXT,
        target_type TEXT NOT NULL CHECK (target_type IN ('PROFILE','LINE_USER')),
        target_id TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','SENT','RETRY','FAILED','CANCELLED','SKIPPED')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        dedupe_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT);
      CREATE INDEX notification_jobs_due ON notification_jobs (status, scheduled_at);
      CREATE INDEX notification_jobs_related ON notification_jobs (related_type, related_id, template, status);

      CREATE TABLE notification_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES notification_jobs(id),
        outcome TEXT NOT NULL CHECK (outcome IN ('SENT','RETRY','FAILED','SKIPPED')),
        http_status INTEGER,
        error TEXT,
        created_at TEXT NOT NULL);
    `,
  },
  {
    version: 8,
    name: 'wayfinding destinations',
    sql: `
      -- Public places patients look for, and where the QR signs hang. A QR holds only the URL and this code
      -- (/wayfinding?at=CODE) — never anything about a patient. A place that moves keeps its code, or is retired with a
      -- pointer to its replacement, so signs already on the walls keep working.
      CREATE TABLE destinations (
        code TEXT PRIMARY KEY,
        name_th TEXT NOT NULL,
        building_id TEXT NOT NULL,
        level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 20),
        zone_index INTEGER,
        room_id TEXT,
        landmark_th TEXT,
        description_th TEXT,
        is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0,1)),
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETIRED')),
        replaced_by TEXT,
        updated_at TEXT NOT NULL,
        updated_by TEXT);
    `,
  },
  {
    version: 9,
    name: 'staff clinic scope',
    sql: `
      -- Which clinics a staff member or supervisor works for (Phase 2 spec §14.2 "scope staff access by department").
      -- No rows = every clinic, as before. Administrators always cover every clinic. Keys are the queue's clinic keys
      -- (opd-<floor>-<zone>) and 'er' for the emergency room.
      CREATE TABLE user_clinics (
        user_id INTEGER NOT NULL REFERENCES users(id),
        clinic_key TEXT NOT NULL,
        PRIMARY KEY (user_id, clinic_key));
    `,
  },
  {
    version: 10,
    name: 'doctor rooms',
    sql: `
      -- The exam room a doctor's session runs in (a room of the OPD building, e.g. opd-205). A patient checked in for an
      -- appointment then waits for that room — that doctor — instead of the next free room of the clinic.
      ALTER TABLE provider_schedules ADD COLUMN room_id TEXT;
      -- The room a visit's exam step is held for (from the appointment). Only a room code, nothing about the patient.
      ALTER TABLE visits ADD COLUMN exam_room TEXT;
    `,
  },
  {
    version: 11,
    name: 'digital reception',
    sql: `
      -- Digital Reception kiosks (/reception). A kiosk is a public device: it signs in with its own credential (only the
      -- hash is kept; shown once when made or rotated), never with a staff account. at_code: the wayfinding place it
      -- stands at (where routes start). Revoked = refused at once.
      CREATE TABLE kiosk_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        at_code TEXT,
        secret_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
        created_at TEXT NOT NULL,
        created_by TEXT,
        rotated_at TEXT,
        last_seen_at TEXT);

      -- What a kiosk may say: approved answers only. Editing an answer makes a new draft version that must be approved
      -- again. topic: faq (general questions), steps (how a visit works), hours, emergency (approved wording only).
      CREATE TABLE reception_answers (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL CHECK (topic IN ('faq','steps','hours','emergency')),
        question_th TEXT NOT NULL,
        keywords TEXT NOT NULL,
        answer_th TEXT NOT NULL,
        destination_code TEXT,
        owner TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','RETIRED')),
        version INTEGER NOT NULL DEFAULT 1,
        effective_from TEXT,
        effective_until TEXT,
        approved_by TEXT,
        approved_at TEXT,
        updated_at TEXT NOT NULL,
        updated_by TEXT);

      -- Use of the kiosks, as daily counts only: no text that anyone typed, no session, nothing about a person.
      CREATE TABLE reception_usage (
        day TEXT NOT NULL,
        kiosk_id TEXT NOT NULL,
        event TEXT NOT NULL,
        intent TEXT NOT NULL DEFAULT '',
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, kiosk_id, event, intent));
    `,
  },
  {
    version: 12,
    name: 'facility model',
    sql: `
      -- The hospital's facility (docs/FACILITY-MODEL-DESIGN.md): buildings › floors (where), departments (who, not tied
      -- to a floor) › service groups (one step, one queue, on a floor) › service points (rooms / counters / beds / kiosks
      -- = queue stations). Ids are stable and never derived from a position. These tables hold the published version;
      -- sort = display order. Retired rows stay (retired_at) so history still reads them.
      CREATE TABLE facility_buildings (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        short_name TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        map_json TEXT NOT NULL,
        sort INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        retired_at TEXT);
      CREATE TABLE facility_floors (
        id TEXT PRIMARY KEY,
        building_id TEXT NOT NULL,
        level INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        sort INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        retired_at TEXT);
      CREATE TABLE facility_departments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        short_name TEXT,
        type TEXT NOT NULL,
        queue_prefix TEXT,
        features_json TEXT NOT NULL,
        first_group_id TEXT,
        sort INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        retired_at TEXT);
      CREATE TABLE facility_service_groups (
        id TEXT PRIMARY KEY,
        department_id TEXT NOT NULL,
        name TEXT NOT NULL,
        floor_id TEXT,
        point_kind TEXT NOT NULL,
        point_noun TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        serves TEXT NOT NULL,
        min_open INTEGER NOT NULL DEFAULT 0,
        sort INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        retired_at TEXT);
      CREATE INDEX facility_service_groups_department ON facility_service_groups (department_id);
      CREATE TABLE facility_service_points (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        name TEXT,
        room_code TEXT,
        floor_id TEXT,
        room_kind TEXT,
        in_room_id TEXT,
        map_json TEXT,
        sort INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        retired_at TEXT);
      CREATE INDEX facility_service_points_group ON facility_service_points (group_id);
      -- Scenery around the buildings (roads, car parks, neighbouring blocks): one row.
      CREATE TABLE facility_site (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        site_json TEXT NOT NULL);
      -- Every published version, in full (rollback publishes an old one again). source: seed = made from the sample
      -- hospital and the old Settings layout, layout = re-made after a layout change, publish, rollback.
      CREATE TABLE facility_versions (
        version INTEGER PRIMARY KEY,
        published_at TEXT NOT NULL,
        published_by TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('seed','layout','publish','rollback')),
        note TEXT,
        summary_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL);
      -- Work in progress: one draft per administrator, on top of the version it started from.
      CREATE TABLE facility_drafts (
        user_id TEXT PRIMARY KEY,
        base_version INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL);
    `,
  },
  {
    version: 13,
    name: 'facility group options',
    sql: `
      -- How a service group is set out and whom it takes: arrange = one long counter (staff side by side) or separate
      -- booths across the area (blood draw); triage = the ER triage levels a bed group takes (resuscitation: 1–2).
      ALTER TABLE facility_service_groups ADD COLUMN options_json TEXT;
    `,
  },
  {
    version: 14,
    name: 'wayfinding places linked to departments',
    sql: `
      -- A place (QR sign) for a department on a floor: where its waiting area is drawn follows the facility.
      ALTER TABLE destinations ADD COLUMN department_id TEXT;
    `,
  },
  {
    version: 15,
    name: 'floor layouts and floor-plan pictures',
    sql: `
      -- How a floor is set out: automatic with adjusted proportions, or rooms and waiting areas placed by hand, and a
      -- floor-plan picture laid underneath (JSON, see FloorLayout in facility-model.ts).
      ALTER TABLE facility_floors ADD COLUMN layout_json TEXT;
      -- Pictures uploaded for floor-plan backgrounds (PNG / JPEG / WebP). Kept when no floor uses them any more, so
      -- old versions still show theirs.
      CREATE TABLE facility_images (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        uploaded_at TEXT NOT NULL,
        uploaded_by TEXT NOT NULL);
    `,
  },
];
