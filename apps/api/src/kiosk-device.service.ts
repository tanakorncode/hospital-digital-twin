import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DbService } from './db.service';
import { AppError } from './errors';
import { CODE_RE } from './wayfinding.service';

// Digital Reception kiosks as devices (Reception spec §9 "kiosk session", §12). A kiosk stands in a public place, so it
// never holds a staff account: an administrator registers it and gets its credential once (`<id>.<secret>`, typed or
// pasted into the kiosk's setup screen); only the secret's hash is stored. The kiosk exchanges the credential for a
// short session token (in memory, 15 minutes, renewed while in use). Rotating or revoking the device ends its sessions
// at once. The device says where it stands (a wayfinding place) — it identifies the machine, never a person.
export type KioskDevice = { id: string; name: string; atCode?: string; status: 'ACTIVE' | 'REVOKED'; createdAt: string; rotatedAt?: string; lastSeenAt?: string };
type Row = { id: string; name: string; at_code: string | null; secret_hash: string; status: KioskDevice['status']; created_at: string; rotated_at: string | null; last_seen_at: string | null };
const toDevice = (r: Row): KioskDevice => ({ id: r.id, name: r.name, atCode: r.at_code ?? undefined, status: r.status, createdAt: r.created_at,
  rotatedAt: r.rotated_at ?? undefined, lastSeenAt: r.last_seen_at ?? undefined });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SESSION_MS = 15 * 60_000, MAX_DEVICES = 200, ONLINE_MS = 12 * 60_000, PAIR_MS = 10 * 60_000;
const ID_RE = /^k-[a-z0-9]{8}$/;
const DENIED = () => new AppError('AUTH_REQUIRED', 'ตู้นี้ยังไม่ได้ลงทะเบียน หรือรหัสตู้ถูกยกเลิก — ติดต่อผู้ดูแลระบบ');

@Injectable()
export class KioskDeviceService {
  now = () => new Date();
  // token hash → device and expiry. In memory: a restart signs kiosks in again from their credential.
  private sessions = new Map<string, { kioskId: string; secretHash: string; expires: number }>();
  // Setting a kiosk up on the kiosk itself: an administrator signed in there gets a ticket (10 minutes, used once) to
  // pick the kiosk from the list — or add it — and the credential goes straight into that browser. No copy and paste.
  private pairing = new Map<string, { by: string; expires: number }>();
  constructor(private readonly store: DbService) {}

  list(): KioskDevice[] {
    return (this.store.db.prepare('SELECT * FROM kiosk_devices ORDER BY status, name').all() as Row[]).map(toDevice);
  }
  get(id: string): KioskDevice | undefined {
    const r = this.row(id);
    return r ? toDevice(r) : undefined;
  }
  // New device (no id) or change its name / place. A new device answers with its credential — shown this once only.
  save(input: { id?: unknown; name?: unknown; atCode?: unknown }, by: string): { device: KioskDevice; credential?: string } {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 60) throw new AppError('VALIDATION_ERROR', 'ระบุชื่อตู้ เช่น ตู้ล็อบบี้ OPD ชั้น 1');
    const at = input.atCode === undefined || input.atCode === null || input.atCode === '' ? null : typeof input.atCode === 'string' && CODE_RE.test(input.atCode.trim().toUpperCase()) ? input.atCode.trim().toUpperCase() : undefined;
    if (at === undefined) throw new AppError('VALIDATION_ERROR', 'จุดที่ตั้งตู้ไม่ถูกต้อง (รหัสจุดหมายนำทาง)');
    if (input.id !== undefined) {
      const r = typeof input.id === 'string' ? this.row(input.id) : undefined;
      if (!r) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบตู้นี้');
      this.store.db.prepare('UPDATE kiosk_devices SET name = ?, at_code = ? WHERE id = ?').run(name, at, r.id);
      return { device: this.get(r.id)! };
    }
    if ((this.store.db.prepare(`SELECT COUNT(*) AS n FROM kiosk_devices WHERE status = 'ACTIVE'`).get() as { n: number }).n >= MAX_DEVICES) throw new AppError('POLICY_REJECTED', 'ลงทะเบียนตู้ได้ไม่เกิน 200 เครื่อง');
    const id = `k-${randomBytes(6).toString('hex').slice(0, 8)}`, secret = randomBytes(24).toString('base64url');
    this.store.db.prepare(`INSERT INTO kiosk_devices (id, name, at_code, secret_hash, status, created_at, created_by) VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`)
      .run(id, name, at, sha(secret), this.now().toISOString(), by);
    return { device: this.get(id)!, credential: `${id}.${secret}` };
  }
  // A new credential (the old one and every session made with it stop working).
  rotate(id: unknown): { device: KioskDevice; credential: string } {
    const r = typeof id === 'string' ? this.row(id) : undefined;
    if (!r) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบตู้นี้');
    if (r.status !== 'ACTIVE') throw new AppError('INVALID_STATE_TRANSITION', 'ตู้นี้ถูกยกเลิกแล้ว — ลงทะเบียนใหม่แทน');
    const secret = randomBytes(24).toString('base64url');
    this.store.db.prepare('UPDATE kiosk_devices SET secret_hash = ?, rotated_at = ? WHERE id = ?').run(sha(secret), this.now().toISOString(), r.id);
    this.endSessions(r.id);
    return { device: this.get(r.id)!, credential: `${r.id}.${secret}` };
  }
  revoke(id: unknown): KioskDevice {
    const r = typeof id === 'string' ? this.row(id) : undefined;
    if (!r) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบตู้นี้');
    this.store.db.prepare(`UPDATE kiosk_devices SET status = 'REVOKED' WHERE id = ?`).run(r.id);
    this.endSessions(r.id);
    return this.get(r.id)!;
  }

  // The kiosk's credential → a session token. Wrong or revoked: the same answer (nothing to learn from guessing).
  signIn(credential: unknown): { token: string; expiresInSeconds: number; kiosk: KioskDevice } {
    const [id, secret] = typeof credential === 'string' ? credential.trim().split('.') : [];
    const r = id && secret && ID_RE.test(id) ? this.row(id) : undefined;
    if (!r || r.status !== 'ACTIVE' || !same(sha(secret), r.secret_hash)) throw DENIED();
    this.seen(r, true);
    return { ...this.issue(r), kiosk: toDevice(r) };
  }
  // A still-valid token → a fresh one (the old one ends).
  refresh(token: unknown): { token: string; expiresInSeconds: number } {
    const r = this.check(token);
    this.sessions.delete(sha(token as string));
    return this.issue(r);
  }
  // The kiosk behind a session token, checked against the device record every time (revoked = refused at once).
  kiosk(token: unknown): KioskDevice {
    return toDevice(this.check(token));
  }

  // Last heard from: on sign-in and on every call with its session (at most once a minute). An idle kiosk still renews
  // its session every 10 minutes, so one not heard from for longer than ONLINE_MS is off, unplugged or offline.
  private seen(r: Row, always = false) {
    const now = this.now();
    if (!always && r.last_seen_at && now.getTime() - new Date(r.last_seen_at).getTime() < 60_000) return;
    this.store.db.prepare('UPDATE kiosk_devices SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), r.id);
    r.last_seen_at = now.toISOString();
  }
  pairTicket(by: string): { ticket: string; expiresInSeconds: number } {
    const now = this.now().getTime();
    for (const [k, v] of this.pairing) if (v.expires < now) this.pairing.delete(k);
    const ticket = randomBytes(24).toString('base64url');
    this.pairing.set(sha(ticket), { by, expires: now + PAIR_MS });
    return { ticket, expiresInSeconds: PAIR_MS / 1000 };
  }
  // The ticket's administrator (`user:<id>`), and the ticket is spent; unknown / expired / used → refused.
  usePairTicket(ticket: unknown): string {
    const k = typeof ticket === 'string' && ticket.length >= 20 && ticket.length <= 100 ? sha(ticket) : '', t = k ? this.pairing.get(k) : undefined;
    if (k) this.pairing.delete(k);
    if (!t || t.expires < this.now().getTime()) throw new AppError('AUTH_REQUIRED', 'หมดเวลาตั้งค่า — เข้าสู่ระบบผู้ดูแลอีกครั้ง');
    return t.by;
  }
  // Heard from recently enough to count as on (sessions renew every 10 minutes).
  online(d: KioskDevice): boolean { return d.status === 'ACTIVE' && !!d.lastSeenAt && this.now().getTime() - new Date(d.lastSeenAt).getTime() <= ONLINE_MS; }

  private check(token: unknown): Row {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw DENIED();
    const s = this.sessions.get(sha(token));
    if (!s || s.expires < this.now().getTime()) { if (s) this.sessions.delete(sha(token)); throw DENIED(); }
    const r = this.row(s.kioskId);
    if (!r || r.status !== 'ACTIVE' || r.secret_hash !== s.secretHash) { this.sessions.delete(sha(token)); throw DENIED(); }
    this.seen(r);
    return r;
  }
  private issue(r: Row) {
    const token = randomBytes(32).toString('base64url'), now = this.now().getTime();
    for (const [k, v] of this.sessions) if (v.expires < now) this.sessions.delete(k);
    this.sessions.set(sha(token), { kioskId: r.id, secretHash: r.secret_hash, expires: now + SESSION_MS });
    return { token, expiresInSeconds: SESSION_MS / 1000 };
  }
  private endSessions(id: string) { for (const [k, v] of this.sessions) if (v.kioskId === id) this.sessions.delete(k); }
  private row(id: string) { return this.store.db.prepare('SELECT * FROM kiosk_devices WHERE id = ?').get(id) as Row | undefined; }
}
function same(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
