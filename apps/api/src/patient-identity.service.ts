import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { BookingService, maskHN } from './booking.service';
import { DbService } from './db.service';
import { AppError } from './errors';

// Who a patient is, on their own phone (LINE / LIFF).
// 1. LINE identity: the LIFF page sends its ID token; the server checks it with LINE (issuer, audience = our LINE Login
//    channel, expiry) and opens an app session. The client's word about its LINE user id is never taken.
// 2. Patient identity: a LINE account is linked to a hospital patient only after the identity has been checked. For now
//    staff do that at the counter: the patient shows a one-time QR from LINE, staff check the ID card as today and
//    confirm with the HN. (OTP to the phone number in the HIS, or ThaID, can be added as further methods.)
// Nothing here tells an unauthenticated caller whether an HN exists.
// Settings (apps/api/.env): LINE_LOGIN_CHANNEL_ID (the LINE Login channel of the LIFF app), LINE_LIFF_ID.
// PATIENT_DEV_LOGIN=on lets a test page sign in as a made-up LINE user without LINE — refused when NODE_ENV=production.
export type PatientSession = { subject: string; profileId?: string; expiresAt: string };
const SESSION_HOURS = Number(process.env.PATIENT_SESSION_HOURS ?? 24);
const LINK_MINUTES = 10, MAX_LINK_REQUESTS_PER_HOUR = 5;
const CODE_CHARS = 'ACDEFGHJKLMNPQRTUVWXY3479';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const HN_RE = /^[0-9A-Za-z-]{3,20}$/;
export const devLoginAllowed = () => process.env.PATIENT_DEV_LOGIN === 'on' && process.env.NODE_ENV !== 'production';

@Injectable()
export class PatientIdentityService {
  private readonly log = new Logger('PatientIdentity');
  now = () => new Date();
  constructor(private readonly store: DbService, private readonly booking: BookingService) {
    if (devLoginAllowed()) this.log.warn('PATIENT_DEV_LOGIN is on: test sign-in without LINE is allowed (never use this with real patients)');
  }

  // ---- LINE ID token → LINE user id (replaceable in tests) -----------------------------------------------------------
  verifyIdToken = async (idToken: string): Promise<string> => {
    const channel = process.env.LINE_LOGIN_CHANNEL_ID;
    if (!channel) {
      const dev = /^dev:(U[0-9a-f]{32})$/.exec(idToken);
      if (devLoginAllowed() && dev) return dev[1];
      throw new AppError('FEATURE_DISABLED', 'ยังไม่ได้ตั้งค่า LINE Login ของโรงพยาบาล');
    }
    let body: { iss?: string; sub?: string; aud?: string; exp?: number; error?: string };
    try {
      const res = await fetch('https://api.line.me/oauth2/v2.1/verify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: idToken, client_id: channel }) });
      body = await res.json() as typeof body;
      if (!res.ok) throw new AppError('AUTH_REQUIRED', 'ยืนยันตัวตนกับ LINE ไม่สำเร็จ กรุณาเปิดจากเมนูใน LINE อีกครั้ง');
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError('UPSTREAM_UNAVAILABLE', 'ติดต่อ LINE ไม่ได้ชั่วคราว กรุณาลองใหม่');
    }
    if (body.iss !== 'https://access.line.me' || body.aud !== channel || !body.sub || !body.exp || body.exp * 1000 < this.now().getTime())
      throw new AppError('AUTH_REQUIRED', 'ยืนยันตัวตนกับ LINE ไม่สำเร็จ กรุณาเปิดจากเมนูใน LINE อีกครั้ง');
    return body.sub;
  };

  async startSession(idToken: unknown): Promise<{ token: string; expiresAt: string; linked: boolean }> {
    if (typeof idToken !== 'string' || idToken.length < 10 || idToken.length > 4096) throw new AppError('VALIDATION_ERROR', 'ไม่พบข้อมูลยืนยันตัวตนจาก LINE');
    const subject = await this.verifyIdToken(idToken); // network call: before any write
    const token = randomBytes(32).toString('base64url'), now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3600_000).toISOString();
    this.store.db.prepare('DELETE FROM patient_sessions WHERE expires_at < ?').run(now.toISOString());
    this.store.db.prepare('INSERT INTO patient_sessions (token_hash, line_subject, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(token), subject, now.toISOString(), expiresAt);
    return { token, expiresAt, linked: !!this.activeProfile(subject) };
  }
  resolve(token: unknown): PatientSession | null {
    if (typeof token !== 'string' || !token || token.length > 100) return null;
    const r = this.store.db.prepare('SELECT line_subject, expires_at FROM patient_sessions WHERE token_hash = ? AND expires_at > ?').get(sha(token), this.now().toISOString()) as
      { line_subject: string; expires_at: string } | undefined;
    return r ? { subject: r.line_subject, profileId: this.activeProfile(r.line_subject), expiresAt: r.expires_at } : null;
  }
  // From an "Authorization: Bearer …" header; AUTH_REQUIRED if missing or expired.
  require(header: unknown): PatientSession {
    const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';
    const s = this.resolve(token);
    if (!s) throw new AppError('AUTH_REQUIRED', 'กรุณาเปิดจากเมนูใน LINE อีกครั้ง');
    return s;
  }
  logout(header: unknown) {
    const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';
    if (token) this.store.db.prepare('DELETE FROM patient_sessions WHERE token_hash = ?').run(sha(token));
  }
  // What the patient's own screen may show: linked or not, and the HN's last 4 digits.
  me(s: PatientSession) {
    if (!s.profileId) return { linked: false as const };
    const r = this.store.db.prepare(`SELECT pp.external_patient_id AS hn, l.verified_at FROM line_patient_links l JOIN patient_profiles pp ON pp.id = l.patient_profile_id
      WHERE l.line_subject = ? AND l.status = 'ACTIVE'`).get(s.subject) as { hn: string; verified_at: string };
    return { linked: true as const, hn: maskHN(r.hn), linkedAt: r.verified_at };
  }

  // ---- linking -----------------------------------------------------------------------------------------------------
  // The patient asks to link: a one-time QR (long token) plus a short code to read out if the QR cannot be scanned.
  startLink(s: PatientSession): { qr: string; code: string; expiresAt: string } {
    if (s.profileId) throw new AppError('POLICY_REJECTED', 'บัญชี LINE นี้เชื่อมกับผู้ป่วยแล้ว');
    const now = this.now();
    this.store.db.prepare(`UPDATE link_requests SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at < ?`).run(now.toISOString());
    this.store.db.prepare('DELETE FROM link_requests WHERE created_at < ?').run(new Date(now.getTime() - 86_400_000).toISOString());
    const recent = (this.store.db.prepare('SELECT COUNT(*) AS n FROM link_requests WHERE line_subject = ? AND created_at > ?').get(s.subject, new Date(now.getTime() - 3600_000).toISOString()) as { n: number }).n;
    if (recent >= MAX_LINK_REQUESTS_PER_HOUR) throw new AppError('RATE_LIMITED', 'ขอรหัสบ่อยเกินไป กรุณารอสักครู่');
    // Only one live code at a time.
    this.store.db.prepare(`UPDATE link_requests SET status = 'EXPIRED' WHERE line_subject = ? AND status = 'PENDING'`).run(s.subject);
    const token = randomBytes(18).toString('base64url'), expiresAt = new Date(now.getTime() + LINK_MINUTES * 60_000).toISOString();
    let code = '';
    do code = Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    while (this.store.db.prepare('SELECT 1 FROM link_requests WHERE short_code = ?').get(code));
    this.store.db.prepare(`INSERT INTO link_requests (id, line_subject, token_hash, short_code, status, expires_at, created_at) VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`)
      .run(`lr_${randomBytes(9).toString('base64url')}`, s.subject, sha(token), code, expiresAt, now.toISOString());
    return { qr: `HDTLINK:${token}`, code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
  }

  // Staff, after checking the patient's ID card: bind the LINE account that showed this code to the patient with this HN.
  // If the patient was linked to another LINE account (new phone), that link ends (REVOKED) — the old phone loses access.
  confirmLink(code: unknown, hn: unknown, by: string): { linkId: string; replaced: boolean; hn: string } {
    if (typeof hn !== 'string' || !HN_RE.test(hn.trim())) throw new AppError('VALIDATION_ERROR', 'HN ไม่ถูกต้อง');
    const text = typeof code === 'string' ? code.trim() : '';
    if (!text) throw new AppError('VALIDATION_ERROR', 'สแกน QR หรือพิมพ์รหัสจากหน้าจอผู้ป่วย');
    return this.store.tx(() => {
      const now = this.now().toISOString();
      const req = (text.startsWith('HDTLINK:')
        ? this.store.db.prepare(`SELECT * FROM link_requests WHERE token_hash = ?`).get(sha(text.slice(8)))
        : this.store.db.prepare(`SELECT * FROM link_requests WHERE short_code = ?`).get(text.toUpperCase().replace(/[\s-]/g, ''))) as
        { id: string; line_subject: string; status: string; expires_at: string } | undefined;
      if (!req || req.status !== 'PENDING' || req.expires_at < now) throw new AppError('RESOURCE_NOT_FOUND', 'รหัสหมดอายุหรือไม่ถูกต้อง ให้ผู้ป่วยกด "เชื่อมบัญชี" ใหม่ใน LINE');
      if (this.activeProfile(req.line_subject)) throw new AppError('POLICY_REJECTED', 'บัญชี LINE นี้เชื่อมกับผู้ป่วยแล้ว');
      const profile = this.booking.profileForHN(hn);
      const replaced = this.store.db.prepare(`UPDATE line_patient_links SET status = 'REVOKED', ended_at = ?, ended_by = ?, end_reason = 'เชื่อมบัญชี LINE ใหม่' WHERE patient_profile_id = ? AND status = 'ACTIVE'`)
        .run(now, by, profile).changes > 0;
      const linkId = `ll_${randomBytes(9).toString('base64url')}`;
      this.store.db.prepare(`INSERT INTO line_patient_links (id, patient_profile_id, line_subject, status, method, verified_at, verified_by, created_at) VALUES (?, ?, ?, 'ACTIVE', 'STAFF_ASSISTED', ?, ?, ?)`)
        .run(linkId, profile, req.line_subject, now, by, now);
      this.store.db.prepare(`UPDATE link_requests SET status = 'USED' WHERE id = ?`).run(req.id);
      return { linkId, replaced, hn: maskHN(hn.trim()) };
    });
  }

  // The patient ends the link from their phone.
  unlink(s: PatientSession) {
    const n = this.store.db.prepare(`UPDATE line_patient_links SET status = 'UNLINKED', ended_at = ?, ended_by = 'patient', end_reason = 'ผู้ป่วยยกเลิกการเชื่อม' WHERE line_subject = ? AND status = 'ACTIVE'`)
      .run(this.now().toISOString(), s.subject).changes;
    return n > 0;
  }
  // Staff end a link (lost phone, wrong person) — with a reason.
  revoke(hn: unknown, reason: unknown, by: string) {
    if (typeof hn !== 'string' || !HN_RE.test(hn.trim())) throw new AppError('VALIDATION_ERROR', 'HN ไม่ถูกต้อง');
    const text = typeof reason === 'string' ? reason.trim().slice(0, 100) : '';
    if (!text) throw new AppError('VALIDATION_ERROR', 'ระบุเหตุผล เช่น ผู้ป่วยแจ้งโทรศัพท์หาย');
    const n = this.store.db.prepare(`UPDATE line_patient_links SET status = 'REVOKED', ended_at = ?, ended_by = ?, end_reason = ?
      WHERE status = 'ACTIVE' AND patient_profile_id = (SELECT id FROM patient_profiles WHERE external_patient_id = ?)`).run(this.now().toISOString(), by, text, hn.trim()).changes;
    if (!n) throw new AppError('RESOURCE_NOT_FOUND', 'ผู้ป่วยนี้ไม่มีบัญชี LINE ที่เชื่อมอยู่');
  }
  // For staff: is this patient linked, since when (no LINE id is ever shown).
  status(hn: unknown): { linked: boolean; since?: string } {
    if (typeof hn !== 'string' || !HN_RE.test(hn.trim())) throw new AppError('VALIDATION_ERROR', 'HN ไม่ถูกต้อง');
    const r = this.store.db.prepare(`SELECT l.verified_at FROM line_patient_links l JOIN patient_profiles pp ON pp.id = l.patient_profile_id
      WHERE pp.external_patient_id = ? AND l.status = 'ACTIVE'`).get(hn.trim()) as { verified_at: string } | undefined;
    return r ? { linked: true, since: r.verified_at } : { linked: false };
  }
  // LINE user ids linked to a patient (for messages, stage 2.7). Never leaves the server.
  subjectsOf(profileId: string) {
    return (this.store.db.prepare(`SELECT line_subject FROM line_patient_links WHERE patient_profile_id = ? AND status = 'ACTIVE'`).all(profileId) as { line_subject: string }[]).map((r) => r.line_subject);
  }
  private activeProfile(subject: string) {
    return (this.store.db.prepare(`SELECT patient_profile_id AS p FROM line_patient_links WHERE line_subject = ? AND status = 'ACTIVE'`).get(subject) as { p: string } | undefined)?.p;
  }
}
