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
];
