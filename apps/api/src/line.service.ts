import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { DbService } from './db.service';
import type { QueueEvent } from './queue.service';
import { NotificationService, queueTemplate } from './notification.service';
import { TicketsService } from './tickets.service';
import { AppError } from './errors';
import { FeaturesService } from './features.service';
import { RICH_MENU, WELCOME, answer, richMenuBody, toMessage, viewUrl } from './line-bot';
import { WayfindingService } from './wayfinding.service';

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
  constructor(private readonly store: DbService, private readonly tickets: TicketsService, private readonly notify: NotificationService,
    private readonly wayfinding: WayfindingService, private readonly features: FeaturesService) {
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

  // Step 2 (LINE webhook): a new friend gets a welcome; "…<6-digit code>" subscribes to a queue slip, "หยุด" stops;
  // anything else is answered by the bot (line-bot.ts) — never with anyone's data.
  async handleWebhook(body: { events?: { type: string; replyToken?: string; source?: { userId?: string }; message?: { type: string; text?: string } }[] }) {
    for (const ev of body?.events ?? []) {
      if (ev.type === 'follow') { await this.reply(ev.replyToken, toMessage({ text: WELCOME, quick: answer('', []).quick })); continue; }
      const userId = ev.source?.userId, text = ev.message?.type === 'text' ? (ev.message.text ?? '').trim() : '';
      if (ev.type !== 'message' || !userId || !text) continue;
      if (/^(หยุด|ยกเลิก|stop)$/i.test(text)) {
        const n = this.store.db.prepare('DELETE FROM line_links WHERE user_id = ?').run(userId).changes;
        await this.reply(ev.replyToken, n ? 'หยุดการแจ้งเตือนคิวแล้ว ขอบคุณที่ใช้บริการ' : 'ไม่มีการแจ้งเตือนคิวที่เปิดอยู่');
        continue;
      }
      const code = text.match(/(?:^|\D)(\d{6})(?:\D|$)/)?.[1];
      if (!code) { await this.reply(ev.replyToken, toMessage(this.answer(text))); continue; }
      const row = this.store.db.prepare('SELECT * FROM line_codes WHERE code = ? AND expires_at > ?').get(code, new Date().toISOString()) as { ticket: string; queue: string } | undefined;
      const t = row ? this.tickets.check(row.ticket) : undefined;
      if (!row || !t?.ok) { await this.reply(ev.replyToken, 'รหัสหมดอายุหรือไม่ถูกต้อง กรุณากด "รับแจ้งเตือนทาง LINE" ในหน้าคิวอีกครั้ง'); continue; }
      this.store.db.prepare('DELETE FROM line_codes WHERE code = ?').run(code);
      this.store.db.prepare('INSERT OR REPLACE INTO line_links (user_id, ticket, patient_id, queue, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, row.ticket, t.ticket.patientId, row.queue, new Date().toISOString());
      await this.reply(ev.replyToken, `เปิดการแจ้งเตือนคิว ${row.queue} แล้ว ✅\nจะแจ้งเมื่อถึงคิวและเมื่อมีการย้ายจุดบริการ · ใช้ได้ถึงสิ้นวันนี้\nพิมพ์ "หยุด" เพื่อหยุดแจ้งเตือน`);
    }
  }
  // The bot's answer to a message (also used by Settings → LINE OA to try messages without LINE).
  answer(text: string) { return answer(text, this.features.on('wayfinding') ? this.wayfinding.list() : []); }

  // ---- Rich menu (administrators) ------------------------------------------------------------------------------------
  // Install the patient menu as every user's default: create it, upload the image the web drew (PNG 2500×1686, ≤ 1 MB),
  // make it the default, then remove menus this system installed before.
  async installRichMenu(png: unknown): Promise<string> {
    if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) throw new AppError('FEATURE_DISABLED', 'ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN');
    if (!viewUrl('queue')) throw new AppError('FEATURE_DISABLED', 'ตั้งค่า LINE_LIFF_ID หรือ PUBLIC_URL ก่อน (ปุ่มเมนูต้องมีที่ให้เปิด)');
    const img = Buffer.isBuffer(png) ? png : png instanceof ArrayBuffer ? Buffer.from(png) : null;
    if (!img || img.length > 1_000_000 || img.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || img.readUInt32BE(16) !== RICH_MENU.width || img.readUInt32BE(20) !== RICH_MENU.height)
      throw new AppError('VALIDATION_ERROR', `รูปเมนูต้องเป็น PNG ${RICH_MENU.width}×${RICH_MENU.height} ไม่เกิน 1 MB`);
    const auth = { authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` };
    const must = async (res: Response, step: string) => {
      if (!res.ok) throw new AppError('UPSTREAM_UNAVAILABLE', `LINE ไม่รับ (${step}): ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
      return res;
    };
    const old = ((await (await must(await fetch('https://api.line.me/v2/bot/richmenu/list', { headers: auth }), 'list')).json()) as { richmenus?: { richMenuId: string; name: string }[] }).richmenus ?? [];
    const created = await (await must(await fetch('https://api.line.me/v2/bot/richmenu', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(richMenuBody()) }), 'create')).json() as { richMenuId: string };
    await must(await fetch(`https://api-data.line.me/v2/bot/richmenu/${created.richMenuId}/content`, { method: 'POST', headers: { ...auth, 'content-type': 'image/png' }, body: new Uint8Array(img) }), 'image');
    await must(await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${created.richMenuId}`, { method: 'POST', headers: auth }), 'default');
    for (const m of old.filter((x) => x.name.startsWith('HDT '))) await fetch(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, { method: 'DELETE', headers: auth }).catch(() => undefined);
    return created.richMenuId;
  }
  // What is set up (true/false only — never the values).
  status() {
    return { messaging: !!process.env.LINE_CHANNEL_ACCESS_TOKEN, webhook: !!process.env.LINE_CHANNEL_SECRET, oa: !!process.env.LINE_OA_ID, login: !!process.env.LINE_LOGIN_CHANNEL_ID,
      liff: !!process.env.LINE_LIFF_ID, publicUrl: !!process.env.PUBLIC_URL, contact: !!process.env.HOSPITAL_CONTACT, menuTarget: !!viewUrl('queue') };
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

  private async reply(replyToken: string | undefined, message: string | ReturnType<typeof toMessage>) {
    if (replyToken) await this.call(`${LINE_API}/reply`, { replyToken, messages: [typeof message === 'string' ? { type: 'text', text: message } : message] });
  }
  private async call(url: string, body: unknown) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }, body: JSON.stringify(body) });
      if (!res.ok) this.log.warn(`LINE ${url.split('/').pop()} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (err) { this.log.warn(`LINE request failed: ${(err as Error).message}`); }
  }
}
