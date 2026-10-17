import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DbService } from './db.service';

// Staff accounts and sessions. Passwords: scrypt with a per-user salt. Sessions: random tokens, only their SHA-256
// is stored, valid for SESSION_HOURS (default 12 — one shift). The public screens (TV, patient page) need no login.
export type Role = 'admin' | 'supervisor' | 'staff';
export type User = { id: number; username: string; name: string; role: Role; active: boolean; lastLogin?: string };
export const ROLES: Role[] = ['admin', 'supervisor', 'staff'];
const SESSION_HOURS = Number(process.env.SESSION_HOURS ?? 12);
const MAX_FAILS = 5, FAIL_WINDOW_MS = 5 * 60_000;

const hashPassword = (password: string) => { const salt = randomBytes(16); return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 32).toString('hex')}`; };
const checkPassword = (password: string, stored: string) => {
  const [, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const a = scryptSync(password, Buffer.from(salt, 'hex'), 32), b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
type Row = { id: number; username: string; name: string; role: Role; pass_hash: string; active: number; last_login: string | null };
const toUser = (r: Row): User => ({ id: r.id, username: r.username, name: r.name, role: r.role, active: !!r.active, lastLogin: r.last_login ?? undefined });

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly log = new Logger('Auth');
  private fails = new Map<string, number[]>(); // per username + client address: recent failed logins
  constructor(private readonly store: DbService) {}

  // First start: create the administrator from ADMIN_USERNAME / ADMIN_PASSWORD (apps/api/.env). Without a password,
  // a random one is written to data/initial-admin.txt (git-ignored) — change it after the first login.
  onModuleInit() {
    const count = (this.store.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    if (count) return;
    const username = process.env.ADMIN_USERNAME ?? 'admin';
    let password = process.env.ADMIN_PASSWORD;
    if (!password) {
      password = randomBytes(9).toString('base64url');
      const file = join(__dirname, '..', 'data', 'initial-admin.txt');
      writeFileSync(file, `username: ${username}\npassword: ${password}\n`, { mode: 0o600 });
      this.log.warn(`Created administrator "${username}" — password saved in ${file}`);
    } else this.log.log(`Created administrator "${username}" from ADMIN_PASSWORD`);
    this.create({ username, name: 'ผู้ดูแลระบบ', role: 'admin', password });
  }

  login(username: string, password: string, from: string): { ok: true; token: string; user: User } | { ok: false; reason: string } {
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password || username.length > 60 || password.length > 200) return { ok: false, reason: 'กรอกชื่อผู้ใช้และรหัสผ่าน' };
    const key = `${username.toLowerCase()}|${from}`, now = Date.now();
    const recent = (this.fails.get(key) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
    if (recent.length >= MAX_FAILS) return { ok: false, reason: 'ลองผิดหลายครั้ง กรุณารอ 5 นาทีแล้วลองใหม่' };
    const row = this.store.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Row | undefined;
    if (!row || !checkPassword(password, row.pass_hash)) { this.fails.set(key, [...recent, now]); return { ok: false, reason: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' }; }
    if (!row.active) return { ok: false, reason: 'บัญชีนี้ถูกระงับ ติดต่อผู้ดูแลระบบ' };
    this.fails.delete(key);
    const token = randomBytes(32).toString('base64url'), at = new Date();
    this.store.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(at.toISOString());
    this.store.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha(token), row.id, at.toISOString(), new Date(at.getTime() + SESSION_HOURS * 3600_000).toISOString());
    this.store.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(at.toISOString(), row.id);
    return { ok: true, token, user: toUser({ ...row, last_login: at.toISOString() }) };
  }

  // The signed-in user for a session token, or null (expired, unknown, or the account was suspended).
  resolve(token: unknown): User | null {
    if (typeof token !== 'string' || !token || token.length > 100) return null;
    const row = this.store.db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`)
      .get(sha(token), new Date().toISOString()) as Row | undefined;
    return row ? toUser(row) : null;
  }
  logout(token: unknown) {
    if (typeof token === 'string') this.store.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  }

  list(): User[] {
    return (this.store.db.prepare('SELECT * FROM users ORDER BY active DESC, role, name').all() as Row[]).map(toUser);
  }
  // Create (no id) or update a user. Password: required for a new user, optional (reset) for an existing one.
  save(input: { id?: number; username?: string; name?: string; role?: Role; active?: boolean; password?: string }, by: User): { ok: true; user: User } | { ok: false; reason: string } {
    const name = input.name?.trim(), username = input.username?.trim();
    if (name !== undefined && (!name || name.length > 60)) return { ok: false, reason: 'ชื่อต้องยาว 1–60 ตัวอักษร' };
    if (input.role !== undefined && !ROLES.includes(input.role)) return { ok: false, reason: 'สิทธิ์ไม่ถูกต้อง' };
    if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 200)) return { ok: false, reason: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร' };
    if (!input.id) {
      if (!username || !/^[a-zA-Z0-9._-]{3,40}$/.test(username)) return { ok: false, reason: 'ชื่อผู้ใช้ 3–40 ตัว ใช้ a–z 0–9 . _ - ได้' };
      if (!name || !input.role || !input.password) return { ok: false, reason: 'กรอกชื่อ สิทธิ์ และรหัสผ่านให้ครบ' };
      if (this.store.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return { ok: false, reason: 'มีชื่อผู้ใช้นี้แล้ว' };
      return { ok: true, user: this.create({ username, name, role: input.role, password: input.password }) };
    }
    const row = this.store.db.prepare('SELECT * FROM users WHERE id = ?').get(input.id) as Row | undefined;
    if (!row) return { ok: false, reason: 'ไม่พบผู้ใช้' };
    // Never leave the hospital without an active administrator (including demoting / suspending yourself).
    const losingAdmin = row.role === 'admin' && row.active && ((input.role && input.role !== 'admin') || input.active === false);
    if (losingAdmin && (this.store.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get() as { n: number }).n <= 1)
      return { ok: false, reason: 'ต้องมีผู้ดูแลระบบที่ใช้งานได้อย่างน้อย 1 คน' };
    this.store.db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?')
      .run(name ?? row.name, input.role ?? row.role, input.active === undefined ? row.active : input.active ? 1 : 0, row.id);
    if (input.password) {
      this.store.db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(input.password), row.id);
      // A reset signs the user out everywhere — except the admin's own current session when changing their own password.
      if (row.id !== by.id) this.store.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    }
    if (input.active === false) this.store.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    return { ok: true, user: toUser(this.store.db.prepare('SELECT * FROM users WHERE id = ?').get(row.id) as Row) };
  }

  private create(u: { username: string; name: string; role: Role; password: string }): User {
    const r = this.store.db.prepare('INSERT INTO users (username, name, role, pass_hash, active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(u.username, u.name, u.role, hashPassword(u.password), new Date().toISOString());
    return toUser(this.store.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid)) as Row);
  }
}
