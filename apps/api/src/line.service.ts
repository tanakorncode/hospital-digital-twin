import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { DbService } from './db.service';
import type { QueueEvent } from './queue.service';
import { NotificationService, queueTemplate } from './notification.service';
import { TicketsService } from './tickets.service';

// LINE Official Account notifications. Switched on by three settings in apps/api/.env:
//   LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN (Messaging API channel) and LINE_OA_ID (e.g. @123abcde).
// Linking, without any login: the patient's page asks for a short code → LINE opens the OA chat with
// "รับแจ้งเตือนคิว <code>" typed in → the webhook receives it and binds that LINE user to the patient's link.
// Messages go out (through the notification worker) when staff call / recall the patient, move them to another point,
// or take on their help request.
// Only the queue number and where to go are sent — never a name or HN. "หยุด" in the chat stops notifications.
const LINE_API = 'https://api.line.me/v2/bot/message';
const CODE_MINUTES = 15;
type Link = { user_id: string; patient_id: string; queue: string; ticket: string };

export { placeOf } from './places';

@Injectable()
export class LineService {
  private readonly log = new Logger('LINE');
  constructor(private readonly store: DbService, private readonly tickets: TicketsService, private readonly notify: NotificationService) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS line_codes (code TEXT PRIMARY KEY, ticket TEXT NOT NULL, queue TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS line_links (
        user_id TEXT NOT NULL, ticket TEXT NOT NULL, patient_id TEXT NOT NULL, queue TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, ticket));
      CREATE INDEX IF NOT EXISTS line_links_patient ON line_links (patient_id);
    `);
  }
  get enabled() { return !!(process.env.LINE_CHANNEL_SECRET && process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_OA_ID); }

  // Step 1 (patient page): a code and the link that opens the OA chat with the message ready to send.
  startLink(token: string, queue: string): { ok: true; code: string; url: string; expiresAt: string } | { ok: false; reason: string; disabled?: boolean } {
    if (!this.enabled) return { ok: false, reason: 'ยังไม่ได้เปิดใช้การแจ้งเตือนทาง LINE', disabled: true };
    const t = this.tickets.check(token);
    if (!t.ok) return { ok: false, reason: t.reason };
    if (t.ticket.kind !== 'patient') return { ok: false, reason: 'ลิงก์ของญาติรับแจ้งเตือนแทนผู้ป่วยไม่ได้' };
    if (typeof queue !== 'string' || !/^[A-Z]{1,3}-?\d{1,4}$/.test(queue)) return { ok: false, reason: 'เลขคิวไม่ถูกต้อง' };
    const now = new Date();
    this.store.db.prepare('DELETE FROM line_codes WHERE expires_at < ?').run(now.toISOString());
    let code = '';
    do code = String(randomInt(100000, 1000000)); while (this.store.db.prepare('SELECT 1 FROM line_codes WHERE code = ?').get(code));
    const expiresAt = new Date(now.getTime() + CODE_MINUTES * 60_000).toISOString();
    this.store.db.prepare('INSERT INTO line_codes (code, ticket, queue, expires_at) VALUES (?, ?, ?, ?)').run(code, token, queue, expiresAt);
    const oa = encodeURIComponent(process.env.LINE_OA_ID!.trim());
    return { ok: true, code, expiresAt, url: `https://line.me/R/oaMessage/${oa}/?${encodeURIComponent(`รับแจ้งเตือนคิว ${code}`)}` };
  }

  // Webhook signature: base64 HMAC-SHA256 of the raw body with the channel secret.
  verify(raw: Buffer | undefined, signature: string | undefined) {
    const secret = process.env.LINE_CHANNEL_SECRET;
    if (!secret || !raw || !signature) return false;
    const want = createHmac('sha256', secret).update(raw).digest(), got = Buffer.from(signature, 'base64');
    return want.length === got.length && timingSafeEqual(want, got);
  }

  // Step 2 (LINE webhook): bind on "…<code>", unbind on "หยุด".
  async handleWebhook(body: { events?: { type: string; replyToken?: string; source?: { userId?: string }; message?: { type: string; text?: string } }[] }) {
    for (const ev of body?.events ?? []) {
      const userId = ev.source?.userId, text = ev.message?.type === 'text' ? (ev.message.text ?? '').trim() : '';
      if (ev.type !== 'message' || !userId || !text) continue;
      if (/^(หยุด|ยกเลิก|stop)$/i.test(text)) {
        const n = this.store.db.prepare('DELETE FROM line_links WHERE user_id = ?').run(userId).changes;
        await this.reply(ev.replyToken, n ? 'หยุดการแจ้งเตือนคิวแล้ว ขอบคุณที่ใช้บริการ' : 'ไม่มีการแจ้งเตือนคิวที่เปิดอยู่');
        continue;
      }
      const code = text.match(/(\d{6})/)?.[1];
      if (!code) { await this.reply(ev.replyToken, 'ส่งรหัส 6 หลักจากหน้าคิวของคุณ เพื่อรับแจ้งเตือนทาง LINE · พิมพ์ "หยุด" เพื่อหยุดแจ้งเตือน'); continue; }
      const row = this.store.db.prepare('SELECT * FROM line_codes WHERE code = ? AND expires_at > ?').get(code, new Date().toISOString()) as { ticket: string; queue: string } | undefined;
      const t = row ? this.tickets.check(row.ticket) : undefined;
      if (!row || !t?.ok) { await this.reply(ev.replyToken, 'รหัสหมดอายุหรือไม่ถูกต้อง กรุณากด "รับแจ้งเตือนทาง LINE" ในหน้าคิวอีกครั้ง'); continue; }
      this.store.db.prepare('DELETE FROM line_codes WHERE code = ?').run(code);
      this.store.db.prepare('INSERT OR REPLACE INTO line_links (user_id, ticket, patient_id, queue, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, row.ticket, t.ticket.patientId, row.queue, new Date().toISOString());
      await this.reply(ev.replyToken, `เปิดการแจ้งเตือนคิว ${row.queue} แล้ว ✅\nจะแจ้งเมื่อถึงคิวและเมื่อมีการย้ายจุดบริการ · ใช้ได้ถึงสิ้นวันนี้\nพิมพ์ "หยุด" เพื่อหยุดแจ้งเตือน`);
    }
  }

  // Step 3: after each accepted queue action — a message job for each LINE user subscribed to that patient's slip
  // (sent by the notification worker, with retries). Users who are also the patient's linked LINE account get it from
  // there instead, not twice.
  onQueueEvent(e: QueueEvent) {
    if (!this.enabled || !e.patientId) return;
    const links = this.store.db.prepare('SELECT * FROM line_links WHERE patient_id = ?').all(e.patientId) as Link[];
    const q = links.length ? queueTemplate(e) : undefined;
    if (!q) return;
    const linked = new Set(this.notify.linkedSubjects(e.patientId));
    let queued = false;
    for (const l of links) {
      if (!this.tickets.check(l.ticket).ok) { this.store.db.prepare('DELETE FROM line_links WHERE user_id = ? AND ticket = ?').run(l.user_id, l.ticket); continue; } // slip re-issued / expired
      if (linked.has(l.user_id)) continue;
      queued = this.notify.enqueue({ template: q.template, payload: { queue: l.queue, place: q.place, who: q.who }, target: { type: 'LINE_USER', id: l.user_id },
        related: { type: 'queue-event', id: e.id }, dedupe: `queue:${e.id}:${l.user_id}` }) || queued;
    }
    if (queued) this.notify.kick();
  }

  private async reply(replyToken: string | undefined, text: string) { if (replyToken) await this.call(`${LINE_API}/reply`, { replyToken, messages: [{ type: 'text', text }] }); }
  private async call(url: string, body: unknown) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }, body: JSON.stringify(body) });
      if (!res.ok) this.log.warn(`LINE ${url.split('/').pop()} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (err) { this.log.warn(`LINE request failed: ${(err as Error).message}`); }
  }
}
