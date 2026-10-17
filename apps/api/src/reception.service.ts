import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DbService } from './db.service';
import { AppError } from './errors';
import { bestAnswers, categoryOf, normalize, placeIn, whereTh } from './intent-rules';
import type { KioskDevice } from './kiosk-device.service';
import { QueueService } from './queue.service';
import { CODE_RE, routeSteps, WayfindingService, type Destination } from './wayfinding.service';

// Digital Reception (docs/Hospital-Digital-Reception-AI-Implementation-Ready.md, Release A — no LLM). A visitor at a
// kiosk taps a menu, a place, or types a short question; the answer comes from rules and from content the hospital has
// approved — never generated, never about a person. Order of a turn (spec §10): kiosk + session checked by the caller →
// input checked → emergency / place / clinical / personal / approved answers / hours / staff → otherwise "not sure":
// the menu or a member of staff, no guess. Nothing anyone types is stored; only daily counts per kind of question.
export type Topic = 'faq' | 'steps' | 'hours' | 'emergency';
export const TOPICS: Topic[] = ['faq', 'steps', 'hours', 'emergency'];
export type Answer = { id: string; topic: Topic; questionTh: string; keywords: string[]; answerTh: string; destinationCode?: string; owner: string;
  status: 'DRAFT' | 'APPROVED' | 'RETIRED'; version: number; effectiveFrom?: string; effectiveUntil?: string; approvedBy?: string; approvedAt?: string; updatedAt: string };
export type PublicPlace = { code: string; nameTh: string; whereTh: string; buildingId: string; level: number; zoneIndex?: number; roomId?: string; landmarkTh?: string };
// What the kiosk may do with an answer — a closed list; the kiosk ignores anything else.
export type Action =
  | { type: 'show_place'; place: PublicPlace; steps: string[] }
  | { type: 'show_answer'; id: string; topic: Topic; questionTh: string }
  | { type: 'choose'; options: { kind: 'answer' | 'place'; id: string; label: string }[] }
  | { type: 'show_directory' }
  | { type: 'show_menu' }
  | { type: 'offer_staff' }
  | { type: 'show_queue' } // the queue board: waiting counts and numbers being called, as on the TV screens
  | { type: 'my_queue' }; // "my queue": the visitor scans the QR on their own queue slip
export type Intent = 'emergency' | 'wayfinding' | 'clinical' | 'personal' | 'answer' | 'choose' | 'hours' | 'staff' | 'directory' | 'queue_info' | 'my_queue' | 'unknown';
// What the hospital lets kiosks show about the queue (both off until an administrator turns them on):
//  queueInfo — the board: per department/counter, how many wait and which numbers are being called (what the TV shows)
//  myQueue   — a visitor scans the QR on their own slip and sees their number, where to go, how many are ahead
// Neither shows a name, an HN or anything about care; "my queue" needs the slip's own QR (a number typed in is not enough).
export type ReceptionSettings = { queueInfo: boolean; myQueue: boolean };
export type TurnResponse = { turnId: string; status: 'completed'; response: { text: string; intent: Intent; actions: Action[]; sources: { id: string; title: string }[];
  handoff: { required: boolean; reason: string | null } } };
export type HelpRequest = { id: string; kioskId: string; kioskName: string; whereTh?: string; reason: 'asked' | 'emergency'; createdAt: string };
export type Turn = { type: 'text'; text: string } | { type: 'menu'; id: 'directory' | 'steps' | 'hours' | 'queue' | 'staff' } | { type: 'answer'; id: string } | { type: 'place'; code: string };

type Row = { id: string; topic: Topic; question_th: string; keywords: string; answer_th: string; destination_code: string | null; owner: string; status: Answer['status'];
  version: number; effective_from: string | null; effective_until: string | null; approved_by: string | null; approved_at: string | null; updated_at: string };
const toAnswer = (r: Row): Answer => ({ id: r.id, topic: r.topic, questionTh: r.question_th, keywords: r.keywords.split(',').filter(Boolean), answerTh: r.answer_th,
  destinationCode: r.destination_code ?? undefined, owner: r.owner, status: r.status, version: r.version, effectiveFrom: r.effective_from ?? undefined,
  effectiveUntil: r.effective_until ?? undefined, approvedBy: r.approved_by ?? undefined, approvedAt: r.approved_at ?? undefined, updatedAt: r.updated_at });
const bad = (reason: string) => new AppError('VALIDATION_ERROR', reason);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IDLE_MS = 5 * 60_000, TURNS_PER_MINUTE = 30;
const SETTINGS_KEY = 'reception.settings';
const SAY = {
  emergency: 'หากเป็นเหตุฉุกเฉิน กรุณาแจ้งเจ้าหน้าที่ที่อยู่ใกล้ที่สุดทันที ระบบได้แจ้งเจ้าหน้าที่ให้แล้ว',
  clinical: 'ตู้นี้ให้ข้อมูลการรับบริการและเส้นทางเท่านั้น ไม่สามารถให้คำแนะนำทางการแพทย์ได้ กรุณาสอบถามแพทย์ พยาบาล หรือเจ้าหน้าที่',
  personal: 'ตู้นี้ไม่แสดงข้อมูลส่วนตัวของผู้ป่วย ดูคิวของคุณได้จาก QR บนบัตรคิว หรือ LINE ของโรงพยาบาล หรือสอบถามเคาน์เตอร์',
  queue: 'ข้อมูลคิวทั่วไปยังไม่เปิดให้บริการที่ตู้นี้ ดูคิวของคุณได้จาก QR บนบัตรคิว หรือจอเรียกคิวในพื้นที่รอ',
  board: 'ภาพรวมคิวตอนนี้ · จำนวนคนรอและหมายเลขที่กำลังเรียก',
  myQueue: 'สแกน QR บนบัตรคิวของคุณที่เครื่องอ่านของตู้ ข้อมูลคิวจะแสดงบนหน้าจอเท่านั้น',
  directory: 'เลือกจุดบริการที่ต้องการไป หรือพิมพ์ชื่อเพื่อค้นหา',
  where: 'บอกชื่อจุดบริการที่ต้องการไป หรือเลือกจากรายการ',
  unknown: 'ขออภัย ยังไม่เข้าใจคำถามนี้ ลองเลือกจากเมนู ค้นหาชื่อจุดบริการ หรือเรียกเจ้าหน้าที่',
  choose: 'มีหลายเรื่องที่ใกล้เคียง เลือกเรื่องที่ต้องการ',
  noSteps: 'ยังไม่มีข้อมูลขั้นตอนรับบริการที่อนุมัติแล้ว กรุณาสอบถามเจ้าหน้าที่',
};

@Injectable()
export class ReceptionService {
  now = () => new Date();
  private sessions = new Map<string, { kioskId: string; last: number }>();
  private turns = new Map<string, number[]>(); // kiosk → recent turn times (rate limit)
  private help = new Map<string, HelpRequest>(); // kiosk → its open request (one each)
  private listeners: ((open: HelpRequest[]) => void)[] = [];
  constructor(private readonly store: DbService, private readonly wayfinding: WayfindingService, private readonly queue: QueueService) {}

  // ---- approved answers (administrators) ---------------------------------------------------------------------------
  answers(): Answer[] {
    return (this.store.db.prepare(`SELECT * FROM reception_answers WHERE status <> 'RETIRED' ORDER BY topic, question_th`).all() as Row[]).map(toAnswer);
  }
  // Answers a kiosk may use now: approved and inside their dates.
  served(): Answer[] {
    const today = this.now().toLocaleDateString('sv-SE');
    return (this.store.db.prepare(`SELECT * FROM reception_answers WHERE status = 'APPROVED' AND (effective_from IS NULL OR effective_from <= ?)
      AND (effective_until IS NULL OR effective_until >= ?)`).all(today, today) as Row[]).map(toAnswer);
  }
  // New answer (no id) or an edit — either way a draft that must be approved before any kiosk uses it.
  saveAnswer(input: Record<string, unknown>, by: string): Answer {
    const topic = input.topic as Topic;
    if (!TOPICS.includes(topic)) throw bad('เลือกหมวด');
    const q = typeof input.questionTh === 'string' ? input.questionTh.trim() : '', a = typeof input.answerTh === 'string' ? input.answerTh.trim() : '';
    const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
    if (!q || q.length > 120) throw bad('ระบุคำถาม/หัวข้อ (ไม่เกิน 120 ตัวอักษร)');
    if (!a || a.length > 600) throw bad('ระบุคำตอบ (ไม่เกิน 600 ตัวอักษร)');
    if (!owner || owner.length > 60) throw bad('ระบุหน่วยงานเจ้าของเนื้อหา');
    const words = (Array.isArray(input.keywords) ? input.keywords : typeof input.keywords === 'string' ? input.keywords.split(',') : [])
      .map((k) => (typeof k === 'string' ? k.trim().replace(/,/g, '') : '')).filter(Boolean);
    if (!words.length || words.length > 20 || words.some((k) => k.length > 30)) throw bad('ระบุคำค้น 1–20 คำ (คั่นด้วยจุลภาค)');
    const dest = typeof input.destinationCode === 'string' && input.destinationCode.trim() ? input.destinationCode.trim().toUpperCase() : null;
    if (dest && !CODE_RE.test(dest)) throw bad('รหัสจุดหมายไม่ถูกต้อง');
    const from = input.effectiveFrom || null, until = input.effectiveUntil || null;
    if ((from && (typeof from !== 'string' || !DATE_RE.test(from))) || (until && (typeof until !== 'string' || !DATE_RE.test(until))) || (from && until && until < from)) throw bad('ช่วงวันที่มีผลไม่ถูกต้อง');
    const at = this.now().toISOString(), keywords = [...new Set(words)].join(',');
    if (input.id !== undefined) {
      const cur = typeof input.id === 'string' ? this.row(input.id) : undefined;
      if (!cur || cur.status === 'RETIRED') throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบคำตอบนี้');
      this.store.db.prepare(`UPDATE reception_answers SET topic = ?, question_th = ?, keywords = ?, answer_th = ?, destination_code = ?, owner = ?, effective_from = ?, effective_until = ?,
        status = 'DRAFT', version = version + ?, approved_by = NULL, approved_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?`)
        .run(topic, q, keywords, a, dest, owner, from as string | null, until as string | null, cur.status === 'APPROVED' ? 1 : 0, at, by, cur.id);
      return toAnswer(this.row(cur.id)!);
    }
    const id = `ra_${randomBytes(6).toString('base64url')}`;
    this.store.db.prepare(`INSERT INTO reception_answers (id, topic, question_th, keywords, answer_th, destination_code, owner, status, version, effective_from, effective_until, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', 1, ?, ?, ?, ?)`).run(id, topic, q, keywords, a, dest, owner, from as string | null, until as string | null, at, by);
    return toAnswer(this.row(id)!);
  }
  approve(id: unknown, by: string): Answer {
    const r = typeof id === 'string' ? this.row(id) : undefined;
    if (!r || r.status === 'RETIRED') throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบคำตอบนี้');
    if (r.status === 'APPROVED') return toAnswer(r);
    this.store.db.prepare(`UPDATE reception_answers SET status = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ?`).run(by, this.now().toISOString(), r.id);
    return toAnswer(this.row(r.id)!);
  }
  retire(id: unknown, by: string): Answer {
    const r = typeof id === 'string' ? this.row(id) : undefined;
    if (!r) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบคำตอบนี้');
    this.store.db.prepare(`UPDATE reception_answers SET status = 'RETIRED', updated_at = ?, updated_by = ? WHERE id = ?`).run(this.now().toISOString(), by, r.id);
    return toAnswer(this.row(r.id)!);
  }

  // ---- what kiosks may show about the queue (administrators) ---------------------------------------------------------
  settings(): ReceptionSettings { return { queueInfo: false, myQueue: false, ...(this.store.getKv<Partial<ReceptionSettings>>(SETTINGS_KEY) ?? {}) }; }
  setSettings(patch: unknown): { settings: ReceptionSettings; changed: Partial<ReceptionSettings> } {
    const p = (patch ?? {}) as Record<string, unknown>, keys = Object.keys(p);
    if (!keys.length || keys.some((k) => !['queueInfo', 'myQueue'].includes(k) || typeof p[k] !== 'boolean')) throw bad('ค่าที่จะบันทึกไม่ถูกต้อง');
    const before = this.settings(), next = { ...before, ...(p as Partial<ReceptionSettings>) };
    this.store.setKv(SETTINGS_KEY, next);
    return { settings: next, changed: Object.fromEntries(keys.filter((k) => before[k as keyof ReceptionSettings] !== next[k as keyof ReceptionSettings]).map((k) => [k, next[k as keyof ReceptionSettings]])) };
  }

  // ---- a visitor's session at a kiosk ----------------------------------------------------------------------------
  // One visitor at a time per kiosk: a new session ends the kiosk's previous one. Idle for 5 minutes = gone.
  start(kiosk: KioskDevice): { sessionId: string; expiresInSeconds: number } {
    const now = this.now().getTime();
    for (const [k, v] of this.sessions) if (v.kioskId === kiosk.id || now - v.last > IDLE_MS) this.sessions.delete(k);
    const sessionId = randomBytes(18).toString('base64url');
    this.sessions.set(sessionId, { kioskId: kiosk.id, last: now });
    this.count(kiosk.id, 'session_started');
    return { sessionId, expiresInSeconds: IDLE_MS / 1000 };
  }
  end(kiosk: KioskDevice, sessionId: unknown) { if (typeof sessionId === 'string' && this.sessions.get(sessionId)?.kioskId === kiosk.id) this.sessions.delete(sessionId); }
  private touch(kiosk: KioskDevice, sessionId: unknown) {
    const s = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined, now = this.now().getTime();
    if (!s || s.kioskId !== kiosk.id || now - s.last > IDLE_MS) { if (s && s.kioskId === kiosk.id) this.sessions.delete(sessionId as string); throw new AppError('RESOURCE_NOT_FOUND', 'หมดเวลาการใช้งาน เริ่มใหม่ได้เลย'); }
    const recent = (this.turns.get(kiosk.id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= TURNS_PER_MINUTE) throw new AppError('RATE_LIMITED', 'ใช้งานถี่เกินไป กรุณารอสักครู่');
    recent.push(now); this.turns.set(kiosk.id, recent);
    s.last = now;
  }

  // Public places, for the directory and search (no turn needed — nothing is said, nothing counted per person).
  places(q?: unknown): PublicPlace[] {
    const text = typeof q === 'string' ? normalize(q) : '';
    return this.wayfinding.list().filter((d) => !text || d.nameTh.includes(text) || d.code.includes(text.toUpperCase())).slice(0, 60).map(publicPlace);
  }

  turn(kiosk: KioskDevice, sessionId: unknown, input: unknown): TurnResponse {
    this.touch(kiosk, sessionId);
    const t = parseTurn(input);
    const r = this.answer(kiosk, t);
    this.count(kiosk.id, 'turn', r.intent);
    if (r.handoff.required) this.count(kiosk.id, 'handoff_offered', r.handoff.reason ?? '');
    return { turnId: randomBytes(9).toString('base64url'), status: 'completed', response: r };
  }

  private answer(kiosk: KioskDevice, t: Turn): TurnResponse['response'] {
    const out = (intent: Intent, text: string, actions: Action[] = [], extra: Partial<TurnResponse['response']> = {}) =>
      ({ text, intent, actions, sources: [], handoff: { required: false, reason: null }, ...extra });
    const staff = (intent: Intent, text: string, reason: string) => out(intent, text, [{ type: 'offer_staff' }], { handoff: { required: true, reason } });
    const served = this.served();
    const answerOut = (a: Answer) => out('answer', a.answerTh, [{ type: 'show_answer', id: a.id, topic: a.topic, questionTh: a.questionTh }, ...this.placeAction(kiosk, a.destinationCode)],
      { sources: [{ id: `${a.id}@v${a.version}`, title: `${a.questionTh} · ${a.owner}` }] });
    if (t.type === 'answer') {
      const a = served.find((x) => x.id === t.id);
      return a ? answerOut(a) : out('unknown', SAY.unknown, [{ type: 'show_menu' }]);
    }
    if (t.type === 'place') {
      const d = this.wayfinding.list().find((x) => x.code === t.code);
      return d ? this.placeOut(kiosk, d) : out('unknown', 'ไม่พบจุดบริการนี้ ลองค้นหาอีกครั้ง หรือเรียกเจ้าหน้าที่', [{ type: 'show_directory' }]);
    }
    if (t.type === 'menu') {
      if (t.id === 'directory') return out('directory', SAY.directory, [{ type: 'show_directory' }]);
      if (t.id === 'queue') return this.queueOut();
      if (t.id === 'staff') return this.staffOut(kiosk);
      if (t.id === 'hours') return this.hoursOut(served);
      const steps = served.filter((a) => a.topic === 'steps');
      return steps.length === 1 ? answerOut(steps[0]) : steps.length ? this.chooseOut(steps.map((a) => ({ kind: 'answer' as const, id: a.id, label: a.questionTh })))
        : staff('answer', SAY.noSteps, 'no_answer');
    }
    // Free text: rules only, safest first.
    const text = normalize(t.text);
    if (categoryOf(text, ['emergency'])) {
      const approved = served.find((a) => a.topic === 'emergency');
      this.raise(kiosk, 'emergency');
      return out('emergency', approved?.answerTh ?? SAY.emergency, [{ type: 'offer_staff' }],
        { handoff: { required: true, reason: 'emergency' }, sources: approved ? [{ id: `${approved.id}@v${approved.version}`, title: approved.questionTh }] : [] });
    }
    // "My queue" / "how long is the queue" — before places, so "คิวห้องยา" is about the queue, not the way there.
    const personal = categoryOf(text, ['personal']), queue = categoryOf(text, ['queue']);
    if (personal && queue && this.settings().myQueue) return out('my_queue', SAY.myQueue, [{ type: 'my_queue' }]);
    if (queue && !personal && this.settings().queueInfo) return this.queueOut();
    const place = placeIn(text, this.wayfinding.list());
    if (place) return this.placeOut(kiosk, place);
    if (categoryOf(text, ['clinical'])) return staff('clinical', SAY.clinical, 'clinical');
    if (personal) return staff('personal', SAY.personal, 'personal');
    const found = bestAnswers(text, served.filter((a) => a.topic !== 'emergency'));
    if (found.length === 1) return answerOut(found[0]);
    if (found.length > 1) return this.chooseOut(found.slice(0, 4).map((a) => ({ kind: 'answer' as const, id: a.id, label: a.questionTh })));
    const cat = categoryOf(text, ['hours', 'staff', 'where']);
    if (cat === 'hours') return this.hoursOut(served);
    if (cat === 'staff') return this.staffOut(kiosk);
    if (cat === 'where') return out('directory', SAY.where, [{ type: 'show_directory' }]);
    return out('unknown', SAY.unknown, [{ type: 'show_menu' }, { type: 'offer_staff' }]);
  }
  private queueOut(): TurnResponse['response'] {
    const s = this.settings(), actions: Action[] = [];
    if (s.queueInfo) actions.push({ type: 'show_queue' });
    if (s.myQueue) actions.push({ type: 'my_queue' });
    return { text: s.queueInfo ? SAY.board : s.myQueue ? SAY.myQueue : SAY.queue, intent: s.queueInfo ? 'queue_info' : s.myQueue ? 'my_queue' : 'queue_info', actions, sources: [],
      handoff: { required: false, reason: null } };
  }
  private chooseOut(options: { kind: 'answer' | 'place'; id: string; label: string }[]): TurnResponse['response'] {
    return { text: SAY.choose, intent: 'choose', actions: [{ type: 'choose', options }], sources: [], handoff: { required: false, reason: null } };
  }
  private placeAction(kiosk: KioskDevice, code?: string): Action[] {
    const d = code ? this.wayfinding.list().find((x) => x.code === code) : undefined;
    return d ? [{ type: 'show_place', place: publicPlace(d), steps: routeSteps(this.origin(kiosk), d) }] : [];
  }
  private placeOut(kiosk: KioskDevice, d: Destination): TurnResponse['response'] {
    return { text: `${d.nameTh} อยู่ที่${whereTh(d)}${d.landmarkTh ? ` · ${d.landmarkTh}` : ''}`, intent: 'wayfinding', actions: this.placeAction(kiosk, d.code),
      sources: [{ id: `place:${d.code}`, title: 'จุดบริการที่โรงพยาบาลกำหนด' }], handoff: { required: false, reason: null } };
  }
  private hoursOut(served: Answer[]): TurnResponse['response'] {
    const approved = served.filter((a) => a.topic === 'hours');
    if (approved.length === 1) return { text: approved[0].answerTh, intent: 'hours', actions: [{ type: 'show_answer', id: approved[0].id, topic: 'hours', questionTh: approved[0].questionTh }],
      sources: [{ id: `${approved[0].id}@v${approved[0].version}`, title: approved[0].questionTh }], handoff: { required: false, reason: null } };
    if (approved.length > 1) return this.chooseOut(approved.map((a) => ({ kind: 'answer', id: a.id, label: a.questionTh })));
    // No approved wording yet: the OPD hours the hospital set for the queue system.
    const h = this.queue.getSettings().hours ?? { opdOpen: 7, opdClose: 16 }, hh = (n: number) => `${String(n).padStart(2, '0')}.00`;
    return { text: `แผนกผู้ป่วยนอก (OPD) เปิดรับบริการ ${hh(h.opdOpen)}–${hh(h.opdClose)} น. · ห้องฉุกเฉินเปิดตลอด 24 ชั่วโมง`, intent: 'hours', actions: [],
      sources: [{ id: 'service-hours', title: 'เวลาให้บริการในระบบคิว' }], handoff: { required: false, reason: null } };
  }
  private staffOut(kiosk: KioskDevice): TurnResponse['response'] {
    const contact = process.env.HOSPITAL_CONTACT?.trim();
    return { text: `กด "เรียกเจ้าหน้าที่" เพื่อให้เจ้าหน้าที่มาที่ตู้นี้${contact ? ` หรือ${contact}` : ' หรือติดต่อจุดประชาสัมพันธ์'}`, intent: 'staff',
      actions: [{ type: 'offer_staff' }], sources: [], handoff: { required: true, reason: 'asked' } };
  }
  private origin(kiosk: KioskDevice) { return kiosk.atCode ? this.wayfinding.list().find((x) => x.code === kiosk.atCode) : undefined; }

  // ---- a member of staff to the kiosk -------------------------------------------------------------------------------
  // The visitor pressed "เรียกเจ้าหน้าที่" (or an emergency was mentioned): staff consoles show which kiosk and where.
  // One open request per kiosk; it carries no information about the visitor.
  requestHelp(kiosk: KioskDevice, sessionId: unknown): HelpRequest {
    this.touch(kiosk, sessionId);
    return this.raise(kiosk, 'asked');
  }
  private raise(kiosk: KioskDevice, reason: HelpRequest['reason']): HelpRequest {
    const cur = this.help.get(kiosk.id);
    if (cur && (cur.reason === 'emergency' || reason === 'asked')) return cur;
    const at = this.origin(kiosk);
    const req: HelpRequest = { id: randomBytes(6).toString('hex'), kioskId: kiosk.id, kioskName: kiosk.name, whereTh: at ? `${at.nameTh} · ${whereTh(at)}` : undefined, reason, createdAt: this.now().toISOString() };
    this.help.set(kiosk.id, req);
    this.count(kiosk.id, 'help_requested', reason);
    this.emit();
    return req;
  }
  openHelp(): HelpRequest[] { return [...this.help.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  ack(id: unknown): HelpRequest | undefined {
    const r = [...this.help.values()].find((x) => x.id === id);
    if (r) { this.help.delete(r.kioskId); this.emit(); }
    return r;
  }
  helpPending(kiosk: KioskDevice) { return this.help.has(kiosk.id); }
  onHelp(fn: (open: HelpRequest[]) => void) { this.listeners.push(fn); }
  private emit() { const open = this.openHelp(); this.listeners.forEach((f) => f(open)); }

  // ---- counts (no text, no session, no person) ----------------------------------------------------------------------
  count(kioskId: string, event: string, intent = '') {
    this.store.db.prepare(`INSERT INTO reception_usage (day, kiosk_id, event, intent, count) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(day, kiosk_id, event, intent) DO UPDATE SET count = count + 1`).run(this.now().toLocaleDateString('sv-SE'), kioskId, event, intent);
  }
  usage(days: unknown): { from: string; rows: { kioskId: string; event: string; intent: string; count: number }[] } {
    const n = Number.isInteger(days) && (days as number) >= 1 && (days as number) <= 92 ? (days as number) : 30;
    const from = new Date(this.now().getTime() - (n - 1) * 86_400_000).toLocaleDateString('sv-SE');
    return { from, rows: this.store.db.prepare(`SELECT kiosk_id AS kioskId, event, intent, SUM(count) AS count FROM reception_usage WHERE day >= ? GROUP BY kiosk_id, event, intent ORDER BY count DESC`)
      .all(from) as { kioskId: string; event: string; intent: string; count: number }[] };
  }
  private row(id: string) { return this.store.db.prepare('SELECT * FROM reception_answers WHERE id = ?').get(id) as Row | undefined; }
}

const publicPlace = (d: Destination): PublicPlace => ({ code: d.code, nameTh: d.nameTh, whereTh: whereTh(d), buildingId: d.buildingId, level: d.level, zoneIndex: d.zoneIndex,
  roomId: d.roomId, landmarkTh: d.landmarkTh });

// The kiosk's input: one of four shapes, nothing else.
function parseTurn(input: unknown): Turn {
  const i = (input ?? {}) as Record<string, unknown>;
  if (i.type === 'text' && typeof i.text === 'string' && i.text.trim() && i.text.length <= 200) return { type: 'text', text: i.text };
  if (i.type === 'menu' && ['directory', 'steps', 'hours', 'queue', 'staff'].includes(i.id as string)) return { type: 'menu', id: i.id as Extract<Turn, { type: 'menu' }>['id'] };
  if (i.type === 'answer' && typeof i.id === 'string' && /^ra_[A-Za-z0-9_-]{4,20}$/.test(i.id)) return { type: 'answer', id: i.id };
  if (i.type === 'place' && typeof i.code === 'string' && CODE_RE.test(i.code)) return { type: 'place', code: i.code };
  throw bad('คำขอไม่ถูกต้อง');
}
