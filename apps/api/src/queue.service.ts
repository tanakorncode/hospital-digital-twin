import { Injectable } from '@nestjs/common';
import { DbService } from './db.service';
import { VisitsService } from './visits.service';

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
// names: a new name for an OPD department, by its clinic key (opd-<floor>-<index>) — the key stays, so bookings,
// appointments and queues that refer to the clinic are unaffected.
// split: how many exam rooms each department of an OPD floor has (in department order, by floor 'opd-<floor>'), instead
// of an even split · roomNames: a room's display name by its id (opd-205) — the id stays.
export type Layout = { off?: string[]; depts?: { name: string; level: number }[]; names?: Record<string, string>; split?: Record<string, number[]>; roomNames?: Record<string, string> };
// dataMode: 'demo' (default) — the simulated day; 'live' — only real patients taken in as visits (no simulation).
export type DataMode = 'demo' | 'live';
export type QueueSettings = { system: Rules; groups: Record<string, Partial<Rules>>; stations: Record<string, { cap?: number }>; hours?: { opdOpen: number; opdClose: number }; demoOffset?: number; layout?: Layout; dataMode?: DataMode; updatedAt?: string; updatedBy?: string };
export type SettingsCommand = { patch: { system?: Partial<Rules>; groups?: Record<string, Record<string, unknown> | null>; stations?: Record<string, { cap?: number | null } | null>; hours?: { opdOpen: number; opdClose: number } | null; demoOffset?: number | null; layout?: Layout | null; dataMode?: DataMode | null }; at: number; scope: string; summary: string; by?: string };
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

  // visits: optional so the queue can be built on its own (tests); the app always passes it.
  constructor(private readonly store: DbService, private readonly visits?: VisitsService) {
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
    // A real patient (visit id): must be in today's queue, at a step they have been sent to.
    if (needsPatient && this.visits && /^v-/.test(cmd.patientId!)) {
      const v = this.visits.get(cmd.patientId);
      if (!v || v.status !== 'active') return { ok: false, reason: 'ไม่พบผู้ป่วยในคิววันนี้' };
      if (cmd.step! < 0 || cmd.step! >= v.steps.length) return { ok: false, reason: 'ไม่พบขั้นตอนนี้ของผู้ป่วย' };
    }
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
    if (p.dataMode !== undefined && p.dataMode !== null && p.dataMode !== 'demo' && p.dataMode !== 'live') return { ok: false, reason: 'โหมดข้อมูลไม่ถูกต้อง' };
    if (p.layout) { const { off = [], depts = [] } = p.layout, perFloor = new Map<number, number>();
      if (!Array.isArray(off) || off.length > 400 || off.some((x) => typeof x !== 'string' || !x || x.length > 80)) return { ok: false, reason: 'รายการเปิด-ปิดไม่ถูกต้อง' };
      if (!Array.isArray(depts) || depts.length > 9) return { ok: false, reason: 'เพิ่มแผนกได้ไม่เกิน 9 แผนก' };
      for (const d of depts) {
        if (!d || typeof d.name !== 'string' || !d.name.trim() || d.name.length > 30 || ![2, 3, 4].includes(d.level)) return { ok: false, reason: 'ข้อมูลแผนกไม่ถูกต้อง' };
        perFloor.set(d.level, (perFloor.get(d.level) ?? 0) + 1);
      }
      if ([...perFloor.values()].some((n) => n > 3)) return { ok: false, reason: 'ชั้นหนึ่งเพิ่มแผนกได้ไม่เกิน 3 แผนก' };
      if (new Set(depts.map((d) => d.name.trim())).size !== depts.length) return { ok: false, reason: 'ชื่อแผนกซ้ำกัน' };
      const names = p.layout.names ?? {};
      if (typeof names !== 'object' || Array.isArray(names) || Object.keys(names).length > 40
        || Object.entries(names).some(([k, v]) => !/^opd-[2-4]-\d{1,2}$/.test(k) || typeof v !== 'string' || !v.trim() || v.length > 30)) return { ok: false, reason: 'ชื่อแผนกที่แก้ไม่ถูกต้อง' };
      if (new Set([...Object.values(names).map((v) => v.trim()), ...depts.map((d) => d.name.trim())]).size !== Object.keys(names).length + depts.length) return { ok: false, reason: 'ชื่อแผนกซ้ำกัน' };
      const split = p.layout.split ?? {}, roomNames = p.layout.roomNames ?? {};
      if (typeof split !== 'object' || Array.isArray(split) || Object.entries(split).some(([k, v]) => !/^opd-[2-4]$/.test(k) || !Array.isArray(v) || !v.length || v.length > 12 || v.some((n) => !Number.isInteger(n) || n < 1 || n > 20)))
        return { ok: false, reason: 'การแบ่งห้องตรวจไม่ถูกต้อง' };
      if (typeof roomNames !== 'object' || Array.isArray(roomNames) || Object.keys(roomNames).length > 80 || Object.entries(roomNames).some(([k, v]) => !/^opd-\d{3}$/.test(k) || typeof v !== 'string' || !v.trim() || v.length > 30))
        return { ok: false, reason: 'ชื่อห้องตรวจไม่ถูกต้อง' }; }
    const next: QueueSettings = { system: { ...this.settings.system, ...(p.system ?? {}) }, groups: { ...this.settings.groups }, stations: { ...this.settings.stations }, hours: this.settings.hours, demoOffset: this.settings.demoOffset, layout: this.settings.layout, dataMode: this.settings.dataMode };
    // New service hours rebuild the simulated day, so today's queue actions no longer point at the same patients: start the log afresh.
    const hoursChanged = p.hours !== undefined && JSON.stringify(p.hours ?? null) !== JSON.stringify(this.settings.hours ?? null);
    if (p.hours !== undefined) { if (p.hours === null) delete next.hours; else next.hours = { opdOpen: p.hours.opdOpen, opdClose: p.hours.opdClose }; }
    if (p.demoOffset !== undefined) { if (p.demoOffset === null) delete next.demoOffset; else next.demoOffset = p.demoOffset; }
    // New departments re-share the floor's rooms and the patients between clinics: same reason to start afresh.
    // Rooms shared out differently also rebuild the simulated day (patients are assigned to rooms).
    const deptsChanged = p.layout !== undefined && JSON.stringify([p.layout?.depts ?? [], p.layout?.split ?? {}]) !== JSON.stringify([this.settings.layout?.depts ?? [], this.settings.layout?.split ?? {}]);
    if (p.layout !== undefined) { if (p.layout === null) delete next.layout; else next.layout = { off: [...new Set(p.layout.off ?? [])], depts: (p.layout.depts ?? []).map((d) => ({ name: d.name.trim(), level: d.level })),
      ...(p.layout.names && Object.keys(p.layout.names).length ? { names: Object.fromEntries(Object.entries(p.layout.names).map(([k, v]) => [k, v.trim()])) } : {}),
      ...(p.layout.split && Object.keys(p.layout.split).length ? { split: p.layout.split } : {}),
      ...(p.layout.roomNames && Object.keys(p.layout.roomNames).length ? { roomNames: Object.fromEntries(Object.entries(p.layout.roomNames).map(([k, v]) => [k, v.trim()])) } : {}) }; }
    if (p.dataMode !== undefined) { if (p.dataMode === null || p.dataMode === 'demo') delete next.dataMode; else next.dataMode = p.dataMode; }
    // Real patients do not depend on the simulated day: their queue log is never cleared by a settings change.
    const reset = (hoursChanged || deptsChanged) && next.dataMode !== 'live';
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
