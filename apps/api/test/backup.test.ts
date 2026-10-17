import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BookingService, localInstant } from '../src/booking.service';
import { DbService } from '../src/db.service';
import { MIGRATIONS } from '../src/migrations';
import './helpers';

const scripts = join(__dirname, '..', 'scripts');
const run = (script: string, args: string[], env: Record<string, string>) =>
  execFileSync(process.execPath, [join(scripts, script), ...args], { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// The real scripts on real files: back up a live database (with un-checkpointed WAL), check the copy, restore it.
test('backup → check → restore gives back the same data, and the API opens it as it is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hdt-restore-')), dbPath = join(dir, 'hospital.db'), backups = join(dir, 'backups');
  try {
    process.env.DB_PATH = dbPath;
    const db = new DbService(), booking = new BookingService(db);
    booking.now = () => localInstant('2026-11-02', '10:00');
    booking.setPolicy({ serviceCode: 'opd-2-0', displayName: 'อายุรกรรม', enabled: true }, 'test');
    booking.createSlots({ serviceCode: 'opd-2-0', from: '2026-11-03', to: '2026-11-03', weekdays: [2], start: '09:00', end: '10:00', minutes: 60, capacity: 5 });
    const b = booking.book(booking.profileForHN('65-1'), booking.slots('opd-2-0', '2026-11-03')[0].id, 'STAFF', 'test');
    // The API keeps running while the backup is taken.
    run('backup.mjs', [], { DB_PATH: dbPath, BACKUP_DIR: backups });
    const file = join(backups, readdirSync(backups)[0]);
    // A change after the backup: lost by the restore, as expected.
    booking.cancel(b.id, 'หลังสำรอง', { kind: 'staff', id: 1, name: 'x', canOverride: true });
    db.db.close();

    const checked = JSON.parse(run('restore.mjs', [file], { DB_PATH: dbPath }).split('\nCheck passed')[0]);
    assert.equal(checked.ok, true);
    assert.equal(checked.integrity, 'ok');
    assert.equal(checked.schemaVersion, MIGRATIONS.at(-1)!.version);
    assert.equal(checked.counts.bookings, 1);

    run('restore.mjs', [file, '--yes'], { DB_PATH: dbPath });
    assert.ok(readdirSync(dir).some((f) => f.startsWith('hospital.db.before-restore-')), 'the database it replaced is kept');
    process.env.DB_PATH = dbPath;
    const back = new DbService(), again = new BookingService(back);
    assert.equal(again.get(b.id)!.status, 'CONFIRMED', 'as it was at the backup');
    assert.equal(back.schemaVersion(), MIGRATIONS.at(-1)!.version);
    back.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a damaged backup is refused and nothing is replaced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hdt-restore-')), dbPath = join(dir, 'hospital.db'), bad = join(dir, 'bad.db');
  try {
    process.env.DB_PATH = dbPath;
    new DbService().db.close();
    writeFileSync(bad, 'not a database at all');
    assert.throws(() => run('restore.mjs', [bad, '--yes'], { DB_PATH: dbPath }));
    assert.ok(existsSync(dbPath));
    assert.ok(!readdirSync(dir).some((f) => f.includes('before-restore')), 'the current database was not touched');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two backups in the same minute do not collide', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hdt-restore-')), dbPath = join(dir, 'hospital.db'), backups = join(dir, 'backups');
  try {
    process.env.DB_PATH = dbPath;
    new DbService().db.close();
    run('backup.mjs', [], { DB_PATH: dbPath, BACKUP_DIR: backups });
    execFileSync('sleep', ['1.1']);
    run('backup.mjs', [], { DB_PATH: dbPath, BACKUP_DIR: backups });
    assert.equal(readdirSync(backups).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
