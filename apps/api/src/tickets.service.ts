import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DbService } from './db.service';

// Links to the patient's own status page (/q/<token>), as printed on the queue slip.
// · patient — issued by staff (the kiosk in production); valid until the end of the service day; lets the patient
//   send a help request.
// · family  — made by the patient from their page to share; read-only; expires sooner (default 12 h, never after
//   the patient's own link).
// Tokens are 128-bit random values, so a link cannot be guessed from the queue number or the patient id. Staff can
// re-issue a lost slip: every older link for that patient stops working at once.
export type TicketKind = 'patient' | 'family';
export type Ticket = { token: string; patientId: string; kind: TicketKind; expiresAt: string };
type Row = { token: string; patient_id: string; kind: TicketKind; day: string; expires_at: string; revoked: number; parent: string | null };
export const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const MAX_FAMILY_PER_DAY = 5;
const today = () => new Date().toLocaleDateString('sv-SE');
const endOfDay = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };
const toTicket = (r: Row): Ticket => ({ token: r.token, patientId: r.patient_id, kind: r.kind, expiresAt: r.expires_at });

@Injectable()
export class TicketsService {
  constructor(private readonly store: DbService) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        token TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('patient','family')),
        day TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        parent TEXT,
        issued_by TEXT);
      CREATE INDEX IF NOT EXISTS tickets_patient ON tickets (patient_id, day);
    `);
  }

  // The patient's current link (the same one every time staff show the QR again), or a fresh one when renew is set.
  issue(patientId: string, issuedBy: string, renew = false): Ticket {
    const day = today(), now = new Date().toISOString();
    if (renew) this.store.db.prepare('UPDATE tickets SET revoked = 1 WHERE patient_id = ? AND day = ?').run(patientId, day);
    else {
      const row = this.store.db.prepare(`SELECT * FROM tickets WHERE patient_id = ? AND day = ? AND kind = 'patient' AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1`)
        .get(patientId, day, now) as Row | undefined;
      if (row) return toTicket(row);
    }
    return this.create(patientId, 'patient', endOfDay(), null, issuedBy);
  }

  // A read-only link the patient shares with family, made from their own valid link.
  family(token: string, hours = 12): { ok: true; ticket: Ticket } | { ok: false; reason: string } {
    const parent = this.check(token);
    if (!parent.ok) return parent;
    if (parent.ticket.kind !== 'patient') return { ok: false, reason: 'ลิงก์ของญาติแชร์ต่อไม่ได้' };
    const made = (this.store.db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE parent = ? AND kind = 'family'`).get(token) as { n: number }).n;
    if (made >= MAX_FAMILY_PER_DAY) return { ok: false, reason: `สร้างลิงก์ญาติได้ไม่เกิน ${MAX_FAMILY_PER_DAY} ลิงก์ต่อวัน` };
    const h = Math.min(24, Math.max(1, Number.isFinite(hours) ? hours : 12));
    const expires = new Date(Math.min(Date.now() + h * 3600_000, new Date(parent.ticket.expiresAt).getTime()));
    return { ok: true, ticket: this.create(parent.ticket.patientId, 'family', expires, token, 'ผู้ป่วย') };
  }

  // Who a link belongs to, or why it no longer works.
  check(token: unknown): { ok: true; ticket: Ticket } | { ok: false; reason: string; code: 'invalid' | 'expired' | 'revoked' } {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { ok: false, reason: 'ลิงก์ไม่ถูกต้อง', code: 'invalid' };
    const row = this.store.db.prepare('SELECT * FROM tickets WHERE token = ?').get(token) as Row | undefined;
    if (!row) return { ok: false, reason: 'ไม่พบคิวนี้', code: 'invalid' };
    if (row.revoked) return { ok: false, reason: 'ลิงก์นี้ถูกยกเลิกแล้ว (ออกบัตรคิวใหม่แล้ว)', code: 'revoked' };
    if (row.expires_at <= new Date().toISOString()) return { ok: false, reason: 'ลิงก์หมดอายุแล้ว', code: 'expired' };
    return { ok: true, ticket: toTicket(row) };
  }

  private create(patientId: string, kind: TicketKind, expires: Date, parent: string | null, issuedBy: string): Ticket {
    const token = randomBytes(16).toString('base64url'), now = new Date().toISOString();
    this.store.db.prepare('INSERT INTO tickets (token, patient_id, kind, day, created_at, expires_at, revoked, parent, issued_by) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
      .run(token, patientId, kind, today(), now, expires.toISOString(), parent, issuedBy);
    return { token, patientId, kind, expiresAt: expires.toISOString() };
  }
}
