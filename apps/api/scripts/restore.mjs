// Check a backup, or restore it.
//   node scripts/restore.mjs <backup.db>          check only: integrity, foreign keys, schema version, row counts
//   node scripts/restore.mjs <backup.db> --yes    restore: STOP THE API FIRST. The current database (and its -wal/-shm)
//                                                 is kept as hospital.db.before-restore-<time>, then the backup is copied in.
// In Docker: docker compose stop api && docker compose run --rm api node scripts/restore.mjs data/backups/<file> --yes && docker compose start api
// Env: DB_PATH (default data/hospital.db).
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const dbPath = process.env.DB_PATH ?? join(root, 'data', 'hospital.db');
const [file, flag] = process.argv.slice(2);
if (!file || !existsSync(file)) { console.error('usage: node scripts/restore.mjs <backup.db> [--yes]'); process.exit(2); }

// What a usable backup looks like: intact, consistent, with our tables.
function check(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check).join(', ');
    const fk = db.prepare('PRAGMA foreign_key_check').all().length;
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const version = tables.has('schema_migrations') ? db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v ?? 0 : 0;
    const counts = Object.fromEntries(['users', 'queue_events', 'visits', 'bookings', 'appointments', 'patient_profiles', 'line_patient_links', 'notification_jobs', 'audit_log']
      .filter((t) => tables.has(t)).map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
    const ok = integrity === 'ok' && fk === 0 && tables.has('users');
    return { ok, integrity, foreignKeyProblems: fk, schemaVersion: version, counts };
  } finally { db.close(); }
}

const report = check(file);
console.log(JSON.stringify({ backup: file, ...report }, null, 2));
if (!report.ok) { console.error('This backup is not usable — not restoring.'); process.exit(1); }
if (flag !== '--yes') { console.log('Check passed. To restore it, stop the API and run again with --yes.'); process.exit(0); }

const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-').slice(0, 19);
for (const ext of ['', '-wal', '-shm']) {
  if (existsSync(dbPath + ext)) renameSync(dbPath + ext, `${dbPath}.before-restore-${stamp}${ext}`);
}
copyFileSync(file, dbPath);
for (const ext of ['-wal', '-shm']) rmSync(dbPath + ext, { force: true });
const after = check(dbPath);
if (!after.ok) { console.error('Restored file failed its check — the previous database is kept as .before-restore-' + stamp); process.exit(1); }
console.log(`Restored ${file} → ${dbPath} (previous database kept as ${dbPath}.before-restore-${stamp}). Start the API again.`);
