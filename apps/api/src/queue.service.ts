import { Injectable } from '@nestjs/common';
import { DbService } from './db.service';

// Mirrors QueueEvent in @hospital/contracts and apps/web/lib/queue.ts. `at` is minutes since midnight.
export type QueueAction = 'open' | 'close' | 'call' | 'recall' | 'start' | 'hold' | 'return' | 'done' | 'transfer' | 'lock' | 'unlock' | 'pause' | 'resume' | 'config' | 'report' | 'resolve';
export type QueueEvent = { id: string; at: number; station: string; action: QueueAction; patientId?: string; step?: number; reason?: string; returnAfter?: number; target?: string; position?: 'keep' | 'end'; by?: string; key?: string };
export type QueueCommand = Omit<QueueEvent, 'id'>;
const ACTIONS: QueueAction[] = ['open', 'close', 'call', 'recall', 'start', 'hold', 'return', 'done', 'transfer', 'lock', 'unlock', 'pause', 'resume', 'report', 'resolve'];
const STATION_ONLY: QueueAction[] = ['open', 'close', 'pause', 'resume'];
const SYSTEM_BY = 'ระบบ';

// Queue assistant settings (mirrors apps/web/lib/queue.ts): hospital defaults, per-group overrides, per-station caps.
type Mode = 'off' | 'suggest' | 'auto';
type Rules = { mode: Mode; cap: number; stallMin: number; slowFactor: number; imbalance: number };
// hours: OPD service hours (whole hours) the simulated day is built on · demoOffset: minutes every screen adds to the real clock (testing).
// layout: departments added on the OPD clinic floors and departments / rooms / counters switched off (ids from the web app).
export type Layout = { off?: string[]; depts?: { name: string; level: number }[] };
export type QueueSettings = { system: Rules; groups: Record<string, Partial<Rules>>; stations: Record<string, { cap?: number }>; hours?: { opdOpen: number; opdClose: number }; demoOffset?: number; layout?: Layout; updatedAt?: string; updatedBy?: string };
export type SettingsCommand = { patch: { system?: Partial<Rules>; groups?: Record<string, Record<string, unknown> | null>; stations?: Record<string, { cap?: number | null } | null>; hours?: { opdOpen: number; opdClose: number } | null; demoOffset?: number | null; layout?: Layout | null }; at: number; scope: string; summary: string; by?: string };
const RULE_CHECK: Record<keyof Rules, (v: unknown) => boolean> = {
  mode: (v) => v === 'off' || v === 'suggest' || v === 'auto',
  cap: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 200,
  stallMin: (v) => Number.isFinite(v) && (v as number) >= 1 && (v as number) <= 60,
  slowFactor: (v) => Number.isFinite(v) && (v as number) >= 1.2 && (v as number) <= 5,
  imbalance: (v) => Number.isInteger(v) && (v as number) >= 2 && (v as number) <= 50,
};

// Append-only log of queue actions, one per day, kept in SQLite (survives restarts; past days stay as history).
// `by` is set by the gateway from the signed-in user, so the audit trail names who really acted.
const DEFAULT_SETTINGS: QueueSettings = { system: { mode: 'suggest', cap: 12, stallMin: 5, slowFactor: 2, imbalance: 4 }, groups: {}, stations: {} };
@Injectable()
export class QueueService {
  private day = today();
  private events: QueueEvent[] = [];
  private seq = 0;
  private settings: QueueSettings;

  constructor(private readonly store: DbService) {
    this.settings = store.getKv<QueueSettings>('queue.settings') ?? DEFAULT_SETTINGS;
    this.load();
  }
  private load() {
    const rows = this.store.db.prepare('SELECT seq, body FROM queue_events WHERE day = ? ORDER BY seq').all(this.day) as { seq: number; body: string }[];
    this.events = rows.map((r) => JSON.parse(r.body) as QueueEvent);
    this.seq = rows.length ? rows[rows.length - 1].seq : 0;
  }
  private append(event: Omit<QueueEvent, 'id'>): QueueEvent {
    const e = { ...event, id: `${this.day}-${++this.seq}` } as QueueEvent;
    this.store.db.prepare('INSERT INTO queue_events (day, seq, id, body) VALUES (?, ?, ?, ?)').run(this.day, this.seq, e.id, JSON.stringify(e));
    this.events.push(e);
    return e;
  }

  list() {
    this.rollover();
    return this.events;
  }

  apply(cmd: QueueCommand): { ok: true; event: QueueEvent } | { ok: false; reason: string } {
    this.rollover();
    if (!cmd || !ACTIONS.includes(cmd.action) || typeof cmd.station !== 'string' || !Number.isFinite(cmd.at)) return { ok: false, reason: 'คำสั่งไม่ถูกต้อง' };
    const needsPatient = !STATION_ONLY.includes(cmd.action);
    if (needsPatient && (typeof cmd.patientId !== 'string' || !Number.isInteger(cmd.step))) return { ok: false, reason: 'ไม่ได้ระบุผู้ป่วย' };
    if (cmd.action === 'transfer' && typeof cmd.target !== 'string') return { ok: false, reason: 'ไม่ได้ระบุปลายทาง' };
    if (cmd.position !== undefined && cmd.position !== 'keep' && cmd.position !== 'end') return { ok: false, reason: 'ตำแหน่งคิวไม่ถูกต้อง' };
    if (cmd.by !== undefined && (typeof cmd.by !== 'string' || cmd.by.length > 60)) return { ok: false, reason: 'ชื่อผู้ปฏิบัติงานไม่ถูกต้อง' };
    if (cmd.key !== undefined && (typeof cmd.key !== 'string' || cmd.key.length > 400)) return { ok: false, reason: 'คำสั่งไม่ถูกต้อง' };
    // The assistant may run on several screens at once: the first one wins, and a patient is not moved again within 10 min.
    if (cmd.key && this.events.some((e) => e.key === cmd.key)) return { ok: false, reason: 'ทำรายการนี้ไปแล้ว' };
    if (cmd.action === 'transfer' && cmd.by === SYSTEM_BY && this.events.some((e) => e.action === 'transfer' && e.patientId === cmd.patientId && e.step === cmd.step && cmd.at - e.at < 10))
      return { ok: false, reason: 'เพิ่งย้ายคิวนี้ไป' };
    // Patient "need help" reports: short, and not more than one every 3 minutes per patient (stops accidental repeats).
    if (cmd.action === 'report') {
      if (typeof cmd.reason !== 'string' || !cmd.reason || cmd.reason.length > 100) return { ok: false, reason: 'ระบุเรื่องที่ต้องการแจ้ง' };
      if (this.events.some((e) => e.action === 'report' && e.patientId === cmd.patientId && cmd.at - e.at < 3)) return { ok: false, reason: 'แจ้งเรื่องไปแล้ว เจ้าหน้าที่กำลังดำเนินการ' };
    }
    if (cmd.action === 'resolve' && !this.events.some((e) => e.action === 'report' && e.id === cmd.target)) return { ok: false, reason: 'ไม่พบเรื่องที่แจ้ง' };
    // Two stations must not call the same patient at once.
    if (cmd.action === 'call') {
      const last = [...this.events].reverse().find((e) => e.patientId === cmd.patientId && e.step === cmd.step);
      if (last && last.station !== cmd.station && (last.action === 'call' || last.action === 'recall' || last.action === 'start'))
        return { ok: false, reason: `ผู้ป่วยกำลังถูกเรียกที่จุดอื่นอยู่` };
      if (last && last.action === 'done') return { ok: false, reason: 'ผู้ป่วยรับบริการขั้นนี้เสร็จแล้ว' };
    }
    return { ok: true, event: this.append(cmd) };
  }

  // Settings outlive the daily log (they are configuration, not today's activity).
  getSettings() {
    return this.settings;
  }
  // reset: the simulated day was rebuilt (new hours or departments), so today's log was cleared — screens need the full list.
  setSettings(cmd: SettingsCommand): { ok: true; settings: QueueSettings; event: QueueEvent; reset: boolean } | { ok: false; reason: string } {
    this.rollover();
    const p = cmd?.patch;
    if (!p || typeof cmd.scope !== 'string' || typeof cmd.summary !== 'string' || cmd.summary.length > 300 || !Number.isFinite(cmd.at)) return { ok: false, reason: 'คำสั่งไม่ถูกต้อง' };
    if (cmd.by !== undefined && (typeof cmd.by !== 'string' || cmd.by.length > 60)) return { ok: false, reason: 'ชื่อผู้ปฏิบัติงานไม่ถูกต้อง' };
    const okRules = (r: Record<string, unknown>, allowNull: boolean) =>
      Object.entries(r).every(([k, v]) => k in RULE_CHECK && ((allowNull && v === null) || RULE_CHECK[k as keyof Rules](v)));
    if (p.system && !okRules(p.system, false)) return { ok: false, reason: 'ค่าตั้งไม่ถูกต้อง' };
    for (const v of Object.values(p.groups ?? {})) if (v !== null && !okRules(v, true)) return { ok: false, reason: 'ค่าตั้งไม่ถูกต้อง' };
    for (const v of Object.values(p.stations ?? {})) if (v !== null && v.cap !== null && v.cap !== undefined && !RULE_CHECK.cap(v.cap)) return { ok: false, reason: 'ค่าตั้งไม่ถูกต้อง' };
    if (p.hours) { const { opdOpen, opdClose } = p.hours;
      if (!Number.isInteger(opdOpen) || !Number.isInteger(opdClose) || opdOpen < 5 || opdOpen > 12 || opdClose < opdOpen + 4 || opdClose > 22) return { ok: false, reason: 'เวลาให้บริการไม่ถูกต้อง' }; }
    if (p.demoOffset !== undefined && p.demoOffset !== null && (!Number.isInteger(p.demoOffset) || Math.abs(p.demoOffset) > 24 * 60)) return { ok: false, reason: 'เวลาทดสอบไม่ถูกต้อง' };
    if (p.layout) { const { off = [], depts = [] } = p.layout, perFloor = new Map<number, number>();
      if (!Array.isArray(off) || off.length > 400 || off.some((x) => typeof x !== 'string' || !x || x.length > 80)) return { ok: false, reason: 'รายการเปิด-ปิดไม่ถูกต้อง' };
      if (!Array.isArray(depts) || depts.length > 9) return { ok: false, reason: 'เพิ่มแผนกได้ไม่เกิน 9 แผนก' };
      for (const d of depts) {
        if (!d || typeof d.name !== 'string' || !d.name.trim() || d.name.length > 30 || ![2, 3, 4].includes(d.level)) return { ok: false, reason: 'ข้อมูลแผนกไม่ถูกต้อง' };
        perFloor.set(d.level, (perFloor.get(d.level) ?? 0) + 1);
      }
      if ([...perFloor.values()].some((n) => n > 3)) return { ok: false, reason: 'ชั้นหนึ่งเพิ่มแผนกได้ไม่เกิน 3 แผนก' };
      if (new Set(depts.map((d) => d.name.trim())).size !== depts.length) return { ok: false, reason: 'ชื่อแผนกซ้ำกัน' }; }
    const next: QueueSettings = { system: { ...this.settings.system, ...(p.system ?? {}) }, groups: { ...this.settings.groups }, stations: { ...this.settings.stations }, hours: this.settings.hours, demoOffset: this.settings.demoOffset, layout: this.settings.layout };
    // New service hours rebuild the simulated day, so today's queue actions no longer point at the same patients: start the log afresh.
    const hoursChanged = p.hours !== undefined && JSON.stringify(p.hours ?? null) !== JSON.stringify(this.settings.hours ?? null);
    if (p.hours !== undefined) { if (p.hours === null) delete next.hours; else next.hours = { opdOpen: p.hours.opdOpen, opdClose: p.hours.opdClose }; }
    if (p.demoOffset !== undefined) { if (p.demoOffset === null) delete next.demoOffset; else next.demoOffset = p.demoOffset; }
    // New departments re-share the floor's rooms and the patients between clinics: same reason to start afresh.
    const deptsChanged = p.layout !== undefined && JSON.stringify(p.layout?.depts ?? []) !== JSON.stringify(this.settings.layout?.depts ?? []);
    if (p.layout !== undefined) { if (p.layout === null) delete next.layout; else next.layout = { off: [...new Set(p.layout.off ?? [])], depts: (p.layout.depts ?? []).map((d) => ({ name: d.name.trim(), level: d.level })) }; }
    const reset = hoursChanged || deptsChanged;
    if (reset) {
      this.events = this.events.filter((e) => e.action === 'config');
      this.store.db.prepare(`DELETE FROM queue_events WHERE day = ? AND json_extract(body, '$.action') <> 'config'`).run(this.day);
    }
    for (const [g, v] of Object.entries(p.groups ?? {})) {
      if (v === null) { delete next.groups[g]; continue; }
      const merged: Record<string, unknown> = { ...(next.groups[g] ?? {}) };
      for (const [k, x] of Object.entries(v)) { if (x === null) delete merged[k]; else merged[k] = x; }
      if (Object.keys(merged).length) next.groups[g] = merged as Partial<Rules>; else delete next.groups[g];
    }
    for (const [id, v] of Object.entries(p.stations ?? {})) { if (v === null || v.cap === null || v.cap === undefined) delete next.stations[id]; else next.stations[id] = { cap: v.cap }; }
    next.updatedAt = new Date().toISOString(); next.updatedBy = cmd.by;
    this.settings = next;
    this.store.setKv('queue.settings', next);
    const event = this.append({ at: cmd.at, station: cmd.scope, action: 'config', reason: cmd.summary, by: cmd.by });
    return { ok: true, settings: next, event, reset };
  }

  private rollover() {
    const d = today();
    if (d !== this.day) { this.day = d; this.load(); }
  }
}
// The hospital's local calendar day (server time zone, e.g. Asia/Bangkok), not UTC.
const today = () => new Date().toLocaleDateString('sv-SE');
