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
];
