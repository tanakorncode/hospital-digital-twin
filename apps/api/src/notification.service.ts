import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Appointment } from './appointment.service';
import type { Booking } from './booking.service';
import { DbService } from './db.service';
import { FacilityService } from './facility.service';
import { FeaturesService } from './features.service';
import { PatientIdentityService } from './patient-identity.service';
import { placeOf } from './places';
import type { QueueEvent } from './queue.service';
import { VisitsService, type Visit } from './visits.service';

// Messages to patients over LINE, with a durable outbox:
//  · enqueue() writes a job in the same transaction as the change it reports (callers wrap both in DbService.tx), so a
//    committed booking always gets its message and a rolled-back one never does;
//  · the worker sends due jobs after commit: transient failures (network, 429, 5xx) are retried with backoff and
//    jitter up to 5 attempts, permanent ones (4xx) are marked FAILED for an administrator to look at;
//  · each job has a dedupe key (the same event never makes two jobs) and LINE's X-Line-Retry-Key (a retried send is
//    never delivered twice);
//  · a failed message never undoes the booking or appointment it is about.
// Content: dates, times, queue numbers, codes and where to go — never a name, HN, clinic of a booking, diagnosis or
// result. Booking/appointment messages need the "notifications" switch; LINE itself needs LINE_CHANNEL_ACCESS_TOKEN.
export type Template = 'BOOKING_CONFIRMED' | 'BOOKING_CANCELLED' | 'APPT_CONFIRMED' | 'APPT_REMINDER' | 'APPT_RESCHEDULED' | 'APPT_RESCHEDULE_REJECTED' | 'APPT_CANCELLED'
  | 'CHECKIN_DONE' | 'QUEUE_CALL' | 'QUEUE_RECALL' | 'QUEUE_TRANSFER' | 'QUEUE_HELP';
type Payload = Record<string, string | undefined>;
type Target = { type: 'PROFILE' | 'LINE_USER'; id: string };
export type JobView = { id: string; template: Template; status: string; attempts: number; lastError?: string; scheduledAt: string; sentAt?: string; relatedType?: string; createdAt: string };
type JobRow = { id: string; template: Template; payload_json: string; target_type: 'PROFILE' | 'LINE_USER'; target_id: string; status: string; attempt_count: number; related_type: string | null };
const PUSH = 'https://api.line.me/v2/bot/message/push';
const MAX_ATTEMPTS = 5, BATCH = 20;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
// A stable UUID per job and recipient for LINE's X-Line-Retry-Key.
const retryKey = (s: string) => { const h = sha(s); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const dayText = (iso: string, now: Date) => {
  const d = new Date(iso), k = (x: Date) => x.toLocaleDateString('sv-SE'), tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  return k(d) === k(now) ? 'วันนี้' : k(d) === k(tomorrow) ? 'พรุ่งนี้' : d.toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' });
};
const timeText = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export function render(t: Template, p: Payload, now = new Date()): string {
  const when = p.at ? `${dayText(p.at, now)} เวลา ${timeText(p.at)} น.` : '';
  switch (t) {
    case 'BOOKING_CONFIRMED': return `✅ จองคิวเรียบร้อย\n${when}\nรหัสจอง ${p.code}\nวันนั้นเช็กอินที่ตู้หรือเคาน์เตอร์ · ดูรายละเอียดในเมนู "จองคิว"`;
    case 'BOOKING_CANCELLED': return `การจองคิว ${when} ถูกยกเลิก${p.reason ? `\nเหตุผล: ${p.reason}` : ''}\nจองใหม่ได้ในเมนู "จองคิว"`;
    case 'APPT_CONFIRMED': return `📅 มีนัดหมายใหม่\n${when}\nดูรายละเอียดในเมนู "นัดหมาย"`;
    case 'APPT_REMINDER': return `⏰ เตือนนัด ${when}\nมาถึงแล้วเช็กอินที่ตู้ด้วยรหัส ${p.code}\nไม่สะดวก? ขอเลื่อนได้ในเมนู "นัดหมาย"`;
    case 'APPT_RESCHEDULED': return `📅 นัดหมายของคุณเปลี่ยนเป็น ${when}\nดูรายละเอียดในเมนู "นัดหมาย"`;
    case 'APPT_RESCHEDULE_REJECTED': return `คำขอเลื่อนนัดไม่ได้รับการอนุมัติ${p.note ? `\n${p.note}` : ''}\nนัดเดิม ${when} ยังคงเดิม`;
    case 'APPT_CANCELLED': return `นัดหมาย ${when} ถูกยกเลิก${p.reason ? `\nเหตุผล: ${p.reason}` : ''}\nกรุณาติดต่อคลินิกหากต้องการนัดใหม่`;
    case 'CHECKIN_DONE': return `เช็กอินแล้ว · หมายเลขคิว ${p.queue}\nไปรอที่ ${p.where}\nดูลำดับคิวในเมนู "คิวของฉัน"`;
    case 'QUEUE_CALL': return `🔔 ถึงคิว ${p.queue} แล้ว\nเชิญที่ ${p.place}`;
    case 'QUEUE_RECALL': return `🔔 เรียกคิว ${p.queue} อีกครั้ง\nเชิญที่ ${p.place}`;
    case 'QUEUE_TRANSFER': return `คิว ${p.queue} ย้ายไป ${p.place}\nกรุณาดูหน้าคิวสำหรับที่รอใหม่`;
    case 'QUEUE_HELP': return `เจ้าหน้าที่ (${p.who}) รับเรื่องของคิว ${p.queue} แล้ว กำลังไปหาคุณ`;
  }
}
// The queue message for a staff action, if it is one patients hear about.
export function queueTemplate(e: QueueEvent, named?: (station: string) => string | undefined): { template: Template; place?: string; who?: string } | undefined {
  if (e.action === 'call') return { template: 'QUEUE_CALL', place: placeOf(e.station, named) };
  if (e.action === 'recall') return { template: 'QUEUE_RECALL', place: placeOf(e.station, named) };
  if (e.action === 'transfer' && e.target) return { template: 'QUEUE_TRANSFER', place: placeOf(e.target, named) };
  if (e.action === 'resolve' && e.reason?.startsWith('assign:')) return { template: 'QUEUE_HELP', who: e.reason.slice(7) };
  return undefined;
}

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Notify');
  now = () => new Date();
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly facility: FacilityService;
  constructor(private readonly store: DbService, private readonly features: FeaturesService, private readonly identity: PatientIdentityService, private readonly visits: VisitsService,
    facility?: FacilityService) { this.facility = facility ?? new FacilityService(store); }
  // A station's name for patients (from the facility model).
  placeName = (station: string) => placeOf(station, (s) => this.facility.stationName(s));
  onModuleInit() {
    // A job left half-done by a restart goes back to the queue (LINE's retry key keeps it from arriving twice).
    this.store.db.prepare(`UPDATE notification_jobs SET status = 'RETRY', updated_at = ? WHERE status = 'PROCESSING'`).run(this.now().toISOString());
    this.timer = setInterval(() => void this.process(), 5000); this.timer.unref();
  }
  onModuleDestroy() { clearInterval(this.timer); }
  get lineConfigured() { return !!process.env.LINE_CHANNEL_ACCESS_TOKEN; }

  // ---- the outbox ---------------------------------------------------------------------------------------------------
  enqueue(j: { template: Template; payload: Payload; target: Target; related?: { type: string; id: string }; at?: Date; dedupe: string }) {
    const now = this.now().toISOString();
    return this.store.db.prepare(`INSERT OR IGNORE INTO notification_jobs (id, template, payload_json, related_type, related_id, target_type, target_id, scheduled_at, status, dedupe_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`).run(`nj_${randomBytes(9).toString('base64url')}`, j.template, JSON.stringify(j.payload), j.related?.type ?? null, j.related?.id ?? null,
      j.target.type, j.target.id, (j.at ?? this.now()).toISOString(), j.dedupe, now, now).changes === 1;
  }
  cancel(relatedType: string, relatedId: string, template?: Template) {
    return this.store.db.prepare(`UPDATE notification_jobs SET status = 'CANCELLED', updated_at = ? WHERE related_type = ? AND related_id = ? AND status IN ('PENDING','RETRY')
      AND (? IS NULL OR template = ?)`).run(this.now().toISOString(), relatedType, relatedId, template ?? null, template ?? null).changes;
  }
  // Run DB work and its messages as one transaction.
  tx<T>(fn: () => T): T { return this.store.tx(fn); }
  // Send soon (after the current transaction has committed).
  kick() { setImmediate(() => void this.process()); }
  private get on() { return this.features.on('notifications'); }

  // ---- what happens → which message ----------------------------------------------------------------------------------
  bookingConfirmed(b: Booking, profileId: string) {
    if (this.on) this.enqueue({ template: 'BOOKING_CONFIRMED', payload: { at: b.startsAt, code: b.code }, target: { type: 'PROFILE', id: profileId }, related: { type: 'booking', id: b.id }, dedupe: `booking-confirmed:${b.id}` });
  }
  bookingCancelled(b: Booking, profileId: string) {
    if (this.on) this.enqueue({ template: 'BOOKING_CANCELLED', payload: { at: b.startsAt, reason: b.cancellationReason }, target: { type: 'PROFILE', id: profileId }, related: { type: 'booking', id: b.id }, dedupe: `booking-cancelled:${b.id}` });
  }
  appointmentMade(a: Appointment, profileId: string) {
    if (!this.on) return;
    this.enqueue({ template: 'APPT_CONFIRMED', payload: { at: a.startsAt }, target: { type: 'PROFILE', id: profileId }, related: { type: 'appointment', id: a.id }, dedupe: `appt-confirmed:${a.id}` });
    this.remind(a, profileId);
  }
  // Moved: the old reminder goes, a new one comes; `tell` = say so (the patient did not move it themselves).
  appointmentMoved(a: Appointment, profileId: string, tell: boolean) {
    this.cancel('appointment', a.id, 'APPT_REMINDER');
    if (!this.on) return;
    if (tell) this.enqueue({ template: 'APPT_RESCHEDULED', payload: { at: a.startsAt }, target: { type: 'PROFILE', id: profileId }, related: { type: 'appointment', id: a.id }, dedupe: `appt-moved:${a.id}:${a.startsAt}` });
    this.remind(a, profileId);
  }
  appointmentCancelled(a: Appointment, profileId: string, tell: boolean) {
    this.cancel('appointment', a.id);
    if (this.on && tell) this.enqueue({ template: 'APPT_CANCELLED', payload: { at: a.startsAt, reason: a.cancellationReason }, target: { type: 'PROFILE', id: profileId }, related: { type: 'appointment', id: a.id }, dedupe: `appt-cancelled:${a.id}` });
  }
  moveRejected(a: Appointment, profileId: string, requestId: string, note?: string) {
    if (this.on) this.enqueue({ template: 'APPT_RESCHEDULE_REJECTED', payload: { at: a.startsAt, note }, target: { type: 'PROFILE', id: profileId }, related: { type: 'appointment', id: a.id }, dedupe: `appt-rejected:${requestId}` });
  }
  checkedIn(v: Visit, profileId: string, where: string) {
    if (this.on) this.enqueue({ template: 'CHECKIN_DONE', payload: { queue: v.queue, where }, target: { type: 'PROFILE', id: profileId }, related: { type: 'visit', id: v.id }, dedupe: `checkin:${v.id}` });
  }
  // The day before at 18:00; if that has passed but the appointment is still more than 2 hours away, now.
  private remind(a: Appointment, profileId: string) {
    const start = new Date(a.startsAt), at = new Date(start); at.setDate(at.getDate() - 1); at.setHours(18, 0, 0, 0);
    const now = this.now();
    if (at <= now) { if (start.getTime() - now.getTime() < 2 * 3600_000) return; at.setTime(now.getTime()); }
    this.enqueue({ template: 'APPT_REMINDER', payload: { at: a.startsAt, code: a.code }, target: { type: 'PROFILE', id: profileId }, related: { type: 'appointment', id: a.id }, at, dedupe: `appt-reminder:${a.id}:${a.startsAt}` });
  }
  // A staff action on a real patient whose LINE account is linked (visits from bookings / appointments).
  onQueueEvent(e: QueueEvent) {
    if (!this.on || !e.patientId?.startsWith('v-')) return;
    const q = queueTemplate(e, (s) => this.facility.stationName(s)), v = q && this.visits.get(e.patientId), profile = v && this.visits.profileOf(v.id);
    if (!q || !v || !profile) return;
    if (this.enqueue({ template: q.template, payload: { queue: v.queue, place: q.place, who: q.who }, target: { type: 'PROFILE', id: profile }, related: { type: 'visit', id: v.id }, dedupe: `queue:${e.id}:profile` })) this.kick();
  }
  // LINE users who also get this patient's messages as a linked account (so the slip subscription is not doubled).
  linkedSubjects(patientId: string) { const p = this.visits.profileOf(patientId); return p ? this.identity.subjectsOf(p) : []; }

  // ---- the worker -----------------------------------------------------------------------------------------------------
  async process() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const now = this.now().toISOString();
        const due = this.store.db.prepare(`SELECT * FROM notification_jobs WHERE status IN ('PENDING','RETRY') AND scheduled_at <= ? ORDER BY scheduled_at LIMIT ?`).all(now, BATCH) as JobRow[];
        if (!due.length) break;
        for (const j of due) {
          // Claim it: only one worker (or one tick) ever sends a job.
          if (this.store.db.prepare(`UPDATE notification_jobs SET status = 'PROCESSING', updated_at = ? WHERE id = ? AND status IN ('PENDING','RETRY')`).run(now, j.id).changes !== 1) continue;
          await this.send(j);
        }
      }
    } finally { this.running = false; }
  }
  private async send(j: JobRow) {
    if (!this.lineConfigured) return this.finish(j, 'SKIPPED', 'LINE_NOT_CONFIGURED');
    const to = j.target_type === 'LINE_USER' ? [j.target_id] : this.identity.subjectsOf(j.target_id);
    if (!to.length) return this.finish(j, 'SKIPPED', 'NO_LINKED_LINE');
    const text = render(j.template, JSON.parse(j.payload_json) as Payload, this.now());
    let worst: 'ok' | 'transient' | 'permanent' = 'ok', status: number | undefined, error: string | undefined;
    for (const user of to) {
      try {
        const res = await fetch(PUSH, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`, 'x-line-retry-key': retryKey(`${j.id}:${user}`) },
          body: JSON.stringify({ to: user, messages: [{ type: 'text', text }] }) });
        if (res.ok || res.status === 409) continue; // 409: LINE already accepted this retry key
        status = res.status; error = (await res.text().catch(() => '')).slice(0, 200);
        const kind = res.status === 429 || res.status >= 500 ? 'transient' : 'permanent';
        if (kind === 'permanent' || worst === 'ok') worst = kind;
      } catch (e) { error = (e as Error).message.slice(0, 200); if (worst === 'ok') worst = 'transient'; }
    }
    if (worst === 'ok') return this.finish(j, 'SENT');
    const attempts = j.attempt_count + 1;
    if (worst === 'permanent' || attempts >= MAX_ATTEMPTS) { this.log.warn(`LINE message ${j.template} failed: ${status ?? ''} ${error ?? ''}`); return this.finish(j, 'FAILED', error, status, attempts); }
    const wait = 30_000 * 2 ** (attempts - 1) * (0.8 + Math.random() * 0.4);
    this.store.db.prepare(`UPDATE notification_jobs SET status = 'RETRY', attempt_count = ?, last_error = ?, scheduled_at = ?, updated_at = ? WHERE id = ?`)
      .run(attempts, error ?? null, new Date(this.now().getTime() + wait).toISOString(), this.now().toISOString(), j.id);
    this.logOutcome(j.id, 'RETRY', status, error);
  }
  private finish(j: JobRow, outcome: 'SENT' | 'FAILED' | 'SKIPPED', error?: string, status?: number, attempts = j.attempt_count + 1) {
    const now = this.now().toISOString();
    this.store.db.prepare(`UPDATE notification_jobs SET status = ?, attempt_count = ?, last_error = ?, sent_at = ?, updated_at = ? WHERE id = ?`)
      .run(outcome, attempts, error ?? null, outcome === 'SENT' ? now : null, now, j.id);
    this.logOutcome(j.id, outcome, status, error);
  }
  private logOutcome(jobId: string, outcome: string, status?: number, error?: string) {
    this.store.db.prepare('INSERT INTO notification_logs (job_id, outcome, http_status, error, created_at) VALUES (?, ?, ?, ?, ?)').run(jobId, outcome, status ?? null, error ?? null, this.now().toISOString());
  }

  // ---- for administrators -----------------------------------------------------------------------------------------------
  // Recent jobs, without recipients (no LINE ids, no patient references).
  jobs(status?: unknown): { jobs: JobView[]; counts: Record<string, number> } {
    const st = typeof status === 'string' && status ? status : null;
    const rows = this.store.db.prepare(`SELECT * FROM notification_jobs WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT 100`).all(st, st) as (JobRow & Record<string, string>)[];
    const counts = Object.fromEntries((this.store.db.prepare(`SELECT status, COUNT(*) AS n FROM notification_jobs WHERE created_at > ? GROUP BY status`)
      .all(new Date(this.now().getTime() - 7 * 86_400_000).toISOString()) as { status: string; n: number }[]).map((r) => [r.status, r.n]));
    return { counts, jobs: rows.map((r) => ({ id: r.id, template: r.template, status: r.status, attempts: r.attempt_count, lastError: r.last_error || undefined,
      scheduledAt: r.scheduled_at, sentAt: r.sent_at || undefined, relatedType: r.related_type ?? undefined, createdAt: r.created_at })) };
  }
  // Messages due and not yet sent, and those that failed in the last 24 hours (counts only — the dashboard).
  backlog(): { waiting: number; failed24h: number } {
    const n = (sql: string, at: string) => (this.store.db.prepare(sql).get(at) as { n: number }).n, now = this.now();
    return { waiting: n(`SELECT COUNT(*) AS n FROM notification_jobs WHERE status IN ('PENDING','RETRY') AND scheduled_at <= ?`, now.toISOString()),
      failed24h: n(`SELECT COUNT(*) AS n FROM notification_jobs WHERE status = 'FAILED' AND updated_at > ?`, new Date(now.getTime() - 86_400_000).toISOString()) };
  }
  retry(id: unknown) {
    const n = typeof id === 'string' ? this.store.db.prepare(`UPDATE notification_jobs SET status = 'PENDING', scheduled_at = ?, updated_at = ? WHERE id = ? AND status IN ('FAILED','SKIPPED')`)
      .run(this.now().toISOString(), this.now().toISOString(), id).changes : 0;
    if (n) this.kick();
    return n === 1;
  }
}
