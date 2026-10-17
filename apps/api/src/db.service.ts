import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, type Migration } from './migrations';

// One SQLite file (Node's built-in driver, no server to install): queue events, settings, users and sessions.
// DB_PATH overrides the location; the default lives next to the API (apps/api/data, git-ignored).
// A larger deployment can move these tables to PostgreSQL without changing the services that use them.
@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly log = new Logger('Db');
  readonly db: DatabaseSync;

  constructor() {
    const file = process.env.DB_PATH ?? join(__dirname, '..', 'data', 'hospital.db');
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // First of all: another writer (the backup script, a second process starting at the same moment) makes this
    // connection wait up to 5 s instead of failing at once with "database is locked".
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS queue_events (
        day TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (day, seq));
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','supervisor','staff')),
        pass_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_login TEXT);
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL);
    `);
    this.migrate();
    this.log.log(`SQLite: ${file}`);
  }

  // Apply the migrations this database has not seen yet, each in its own transaction.
  migrate(list: Migration[] = MIGRATIONS) {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const done = new Set((this.db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
    for (const m of [...list].sort((a, b) => a.version - b.version)) {
      if (done.has(m.version)) continue;
      this.tx(() => {
        this.db.exec(m.sql);
        this.db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
      });
      this.log.log(`migration ${m.version}: ${m.name}`);
    }
  }
  schemaVersion() {
    return (this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v ?? 0;
  }

  // Run fn as one write transaction: all of it is saved, or — if it throws — none of it.
  // BEGIN IMMEDIATE takes the write lock up front, so two writers can never both pass a "still room in this slot?" check.
  // fn must be synchronous: no awaiting the network (LINE, HIS) while the database is locked — do that after commit.
  // Nested calls join the outer transaction.
  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      if (out instanceof Promise) throw new Error('DbService.tx: the function must be synchronous');
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getKv<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  setKv(key: string, value: unknown) {
    this.db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  onModuleDestroy() {
    this.db.close();
  }
}
