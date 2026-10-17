// Online backup of the SQLite database (safe while the API runs): VACUUM INTO a dated copy, keep the newest KEEP.
//   node scripts/backup.mjs            (in the container: docker compose exec api node scripts/backup.mjs)
// Env: DB_PATH (default data/hospital.db), BACKUP_DIR (default data/backups), BACKUP_KEEP (default 14).
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const dbPath = process.env.DB_PATH ?? join(root, 'data', 'hospital.db');
const dir = process.env.BACKUP_DIR ?? join(root, 'data', 'backups');
const keep = Number(process.env.BACKUP_KEEP ?? 14);
mkdirSync(dir, { recursive: true });
const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-').slice(0, 16);
const out = join(dir, `hospital-${stamp}.db`);
const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
const old = readdirSync(dir).filter((f) => /^hospital-.*\.db$/.test(f)).sort().reverse().slice(keep);
old.forEach((f) => rmSync(join(dir, f)));
console.log(`backup: ${out}${old.length ? ` (removed ${old.length} old)` : ''}`);
