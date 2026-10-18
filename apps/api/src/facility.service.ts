import { Injectable } from '@nestjs/common';
import { DbService } from './db.service';
import { AppError } from './errors';
import { indexFacility, pointInUse, departmentInUse, roomRef, stationLabel, usable, validateFacility, type Department, type Facility, type FacilityData, type FacilityIndex, type Issue,
  type ServicePoint } from './facility-model';
import { sampleFacility } from './facility-template';
import type { Layout, QueueSettings } from './queue.service';

// The facility model's store (docs/FACILITY-MODEL-DESIGN.md §5). The published version lives in the facility_* tables
// and in memory (every lookup reads the index); administrators edit a draft, see its impact, and publish it as a new
// version in one transaction. The first start makes version 1 from the sample hospital and the Settings layout.
// Until the Settings page edits the model itself (F3), a layout change re-makes it — only while nobody has published.
export type VersionInfo = { version: number; publishedAt: string; publishedBy: string; publishedByName?: string; source: 'seed' | 'layout' | 'publish' | 'rollback'; note?: string; summary: ChangeSummary };
// site: the ground around the buildings (roads, car parks, plazas, neighbouring blocks, walking routes) — changed or not.
export type ChangeSummary = Record<'buildings' | 'floors' | 'departments' | 'groups' | 'points' | 'site', { added: number; changed: number; removed: number }>;
export type Change = { kind: keyof ChangeSummary; id: string; name: string; change: 'added' | 'changed' | 'removed' | 'off' | 'on' | 'retired' };
export type Impact = { baseVersion: number; issues: Issue[]; summary: ChangeSummary; changes: Change[]; ok: boolean };
export type Draft = { baseVersion: number; data: FacilityData; updatedAt: string };

const KINDS = ['buildings', 'floors', 'departments', 'groups', 'points'] as const;
const MAX_JSON = 4_000_000, MAX_CHANGES = 300;
type Row = Record<string, unknown>;
const bool = (v: unknown) => v === 1 || v === true;
const opt = <T>(v: T | null | undefined) => (v === null || v === undefined ? undefined : v);
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

@Injectable()
export class FacilityService {
  now = () => new Date();
  private cur!: Facility;
  private ix!: FacilityIndex;
  constructor(private readonly store: DbService) {
    if (!this.store.db.prepare('SELECT 1 FROM facility_versions LIMIT 1').get()) {
      const layout = this.store.getKv<QueueSettings>('queue.settings')?.layout;
      this.write(sampleFacility(layout ?? {}), 'system', 'seed', 'ผังเริ่มต้น (จากผังเดิมและการตั้งค่าแผนก)');
    } else {
      this.load();
      // Until someone publishes by hand, the facility follows the sample hospital and the layout: a newer sample (more
      // fields, fixed ids) reaches installations that have not edited their facility yet.
      this.syncFromLayout(this.store.getKv<QueueSettings>('queue.settings')?.layout, 'system');
    }
  }

  // ---- Reading ----------------------------------------------------------------------------------------------------
  current(): Facility { return this.cur; }
  index(): FacilityIndex { return this.ix; }
  version(): number { return this.cur.version; }
  // What public screens get: the same, without anything retired.
  publicView(): Facility {
    const f = this.cur, live = <T extends { retiredAt?: string }>(l: T[]) => l.filter((x) => !x.retiredAt);
    return { ...f, buildings: live(f.buildings), floors: live(f.floors), departments: live(f.departments), groups: live(f.groups), points: live(f.points) };
  }
  department(id: unknown): Department | undefined { return typeof id === 'string' ? this.ix.department.get(id) : undefined; }
  // A department that takes walk-ins / bookings / appointments now (exists, on, not retired).
  isClinic(id: unknown, feature: 'booking' | 'appointments' | 'walkIn' = 'walkIn'): boolean {
    const d = this.department(id);
    return !!d && departmentInUse(this.ix, d.id) && d.features[feature];
  }
  // The emergency department (ER patients, and the staff scope that covers them): the sample's is 'er'.
  erDepartment(): Department | undefined {
    const list = this.cur.departments.filter((d) => d.type === 'emergency' && !d.retiredAt);
    return list.find((d) => d.queuePrefix) ?? list[0];
  }
  // Known department (also when switched off — existing records keep their department).
  knowsDepartment(id: unknown): boolean { return !!this.department(id); }
  // A doctor's room of a department, by room reference ("opd-201" or a point id), in use.
  roomOf(departmentId: string, ref: unknown): ServicePoint | undefined {
    if (typeof ref !== 'string') return undefined;
    const p = this.ix.point.get(ref) ?? this.ix.point.get(`room:${ref}`), g = p && this.ix.group.get(p.groupId);
    return p && g && g.departmentId === departmentId && g.pointKind === 'room' && g.steps.includes('exam') && pointInUse(this.ix, p.id) ? p : undefined;
  }
  // The name of a queue station as patients read it ("ห้องตรวจ 201", "ช่องจ่ายยา 3"); undefined = not in the model.
  stationName(id: string): string | undefined { return stationLabel(this.ix, id); }

  // ---- Drafts -------------------------------------------------------------------------------------------------------
  draft(userId: string): Draft | undefined {
    const r = this.store.db.prepare('SELECT * FROM facility_drafts WHERE user_id = ?').get(userId) as { base_version: number; data_json: string; updated_at: string } | undefined;
    return r ? { baseVersion: r.base_version, data: JSON.parse(r.data_json) as FacilityData, updatedAt: r.updated_at } : undefined;
  }
  // A draft may be unfinished (it is checked on publish), but it must be a facility in shape and size.
  saveDraft(userId: string, data: unknown, baseVersion?: unknown): { draft: Draft; issues: Issue[] } {
    const json = this.shape(data);
    const base = typeof baseVersion === 'number' && Number.isInteger(baseVersion) ? baseVersion : this.cur.version, at = this.now().toISOString();
    this.store.db.prepare(`INSERT INTO facility_drafts (user_id, base_version, data_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET base_version = excluded.base_version, data_json = excluded.data_json, updated_at = excluded.updated_at`).run(userId, base, json, at);
    return { draft: { baseVersion: base, data: JSON.parse(json) as FacilityData, updatedAt: at }, issues: validateFacility(data).issues };
  }
  discardDraft(userId: string): boolean {
    return Number(this.store.db.prepare('DELETE FROM facility_drafts WHERE user_id = ?').run(userId).changes) > 0;
  }

  // ---- Impact and publishing ----------------------------------------------------------------------------------------
  // What publishing `data` would do: the checks (errors block it), what changes, and what still points at things that
  // would go away or be switched off (bookings, appointments, doctor sessions, staff, today's queue, QR signs).
  impact(data: unknown): Impact {
    const { data: next, issues } = validateFacility(data);
    if (!next) return { baseVersion: this.cur.version, issues, summary: emptySummary(), changes: [], ok: false };
    const { summary, changes } = diff(this.cur, next);
    issues.push(...this.references(next));
    return { baseVersion: this.cur.version, issues, summary, changes: changes.slice(0, MAX_CHANGES), ok: !issues.some((i) => i.level === 'error') };
  }
  publish(userId: string, data: unknown, opts: { note?: unknown; baseVersion?: unknown } = {}): { facility: Facility; impact: Impact } {
    if (opts.baseVersion !== undefined && opts.baseVersion !== this.cur.version)
      throw new AppError('INVALID_STATE_TRANSITION', `ผังถูกเผยแพร่เวอร์ชัน ${this.cur.version} ไปแล้วระหว่างที่แก้ — เปิดร่างใหม่จากเวอร์ชันล่าสุด`);
    this.shape(data);
    const impact = this.impact(data);
    const firstError = impact.issues.find((i) => i.level === 'error');
    if (firstError) throw new AppError('VALIDATION_ERROR', `${firstError.message}${impact.issues.filter((i) => i.level === 'error').length > 1 ? ' (และข้อผิดพลาดอื่น — ดูผลกระทบก่อนเผยแพร่)' : ''}`);
    if (!impact.changes.length) throw new AppError('VALIDATION_ERROR', 'ร่างนี้เหมือนผังปัจจุบัน ไม่มีอะไรให้เผยแพร่');
    const note = typeof opts.note === 'string' ? opts.note.trim().slice(0, 200) || undefined : undefined;
    this.store.tx(() => { this.write(validateFacility(data).data!, userId, 'publish', note, impact.summary); this.discardDraft(userId); });
    return { facility: this.cur, impact };
  }
  versions(limit = 50): VersionInfo[] {
    // Who published it, by the account's name (the id stays in published_by).
    return (this.store.db.prepare(`SELECT v.version, v.published_at, v.published_by, v.source, v.note, v.summary_json, u.name AS by_name FROM facility_versions v
      LEFT JOIN users u ON v.published_by = 'user:' || u.id ORDER BY v.version DESC LIMIT ?`).all(Math.min(200, Math.max(1, limit))) as Row[])
      .map((r) => strip({ version: r.version as number, publishedAt: r.published_at as string, publishedBy: r.published_by as string, publishedByName: opt(r.by_name as string | null), source: r.source as VersionInfo['source'],
        note: opt(r.note as string | null), summary: JSON.parse(r.summary_json as string) as ChangeSummary }));
  }
  versionData(version: unknown): FacilityData | undefined {
    const r = typeof version === 'number' ? this.store.db.prepare('SELECT snapshot_json FROM facility_versions WHERE version = ?').get(version) as { snapshot_json: string } | undefined : undefined;
    return r ? (JSON.parse(r.snapshot_json) as FacilityData) : undefined;
  }
  // Publish an earlier version again (as a new version, through the same checks).
  rollback(userId: string, version: unknown): { facility: Facility; impact: Impact } {
    const data = this.versionData(version);
    if (!data) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบเวอร์ชันนี้');
    if (version === this.cur.version) throw new AppError('VALIDATION_ERROR', 'เวอร์ชันนี้คือผังปัจจุบันอยู่แล้ว');
    const impact = this.impact(data);
    const firstError = impact.issues.find((i) => i.level === 'error');
    if (firstError) throw new AppError('VALIDATION_ERROR', `ย้อนไปเวอร์ชัน ${String(version)} ไม่ได้: ${firstError.message}`);
    this.store.tx(() => this.write(data, userId, 'rollback', `ย้อนกลับไปเวอร์ชัน ${String(version)}`, impact.summary));
    return { facility: this.cur, impact };
  }
  // The Settings layout changed (the old departments page, until F3 replaces it): re-make the model from it, as long
  // as every version so far was made that way. Returns true when a new version was published.
  syncFromLayout(layout: Layout | undefined, by: string): boolean {
    if (this.store.db.prepare(`SELECT 1 FROM facility_versions WHERE source NOT IN ('seed','layout') LIMIT 1`).get()) return false;
    const next = sampleFacility(layout ?? {}), { summary, changes } = diff(this.cur, next);
    if (!changes.length) return false;
    this.store.tx(() => this.write(next, by, 'layout', 'ตามการตั้งค่าแผนกและจุดบริการ', summary));
    return true;
  }

  // What uses a department or a point now (for the settings page: why it can only be retired, what switching it off
  // touches). Counts only, nothing about any patient.
  usage(id: unknown): { what: string; count: number }[] {
    if (typeof id !== 'string') return [];
    const nowIso = this.now().toISOString(), day = localDay(this.now());
    const count = (sql: string, ...args: (string | number)[]) => (this.store.db.prepare(sql).get(...args) as { n: number }).n;
    const d = this.ix.department.get(id), p = this.ix.point.get(id);
    const list: [string, number][] = d ? [
      ['การจองล่วงหน้า', count(`SELECT COUNT(*) AS n FROM bookings b JOIN booking_slots s ON s.id = b.slot_id WHERE b.service_code = ? AND b.status = 'CONFIRMED' AND s.starts_at >= ?`, id, nowIso)],
      ['นัดหมายล่วงหน้า', count(`SELECT COUNT(*) AS n FROM appointments a JOIN appointment_slots s ON s.id = a.slot_id WHERE a.clinic_code = ? AND a.status = 'CONFIRMED' AND s.starts_at >= ?`, id, nowIso)],
      ['ตารางออกตรวจ', count(`SELECT COUNT(*) AS n FROM provider_schedules WHERE clinic_code = ? AND status = 'OPEN' AND ends_at >= ?`, id, nowIso)],
      ['ผู้ป่วยในคิววันนี้', count(`SELECT COUNT(*) AS n FROM visits WHERE day = ? AND clinic_key = ? AND status = 'active'`, day, id)],
      ['เจ้าหน้าที่ที่ดูแล', count('SELECT COUNT(*) AS n FROM user_clinics WHERE clinic_key = ?', id)],
    ] : p ? [
      ['ตารางออกตรวจที่ระบุห้องนี้', count(`SELECT COUNT(*) AS n FROM provider_schedules WHERE room_id IN (?, ?) AND status = 'OPEN' AND ends_at >= ?`, roomRef(p), p.id, nowIso)],
      ['ผู้ป่วยวันนี้ที่รอห้องนี้', count(`SELECT COUNT(*) AS n FROM visits WHERE day = ? AND exam_room IN (?, ?) AND status = 'active'`, day, roomRef(p), p.id)],
      ['การเรียกคิววันนี้', count(`SELECT COUNT(*) AS n FROM queue_events WHERE day = ? AND json_extract(body, '$.station') = ?`, day, p.id)],
      ['ป้าย QR นำทาง', count(`SELECT COUNT(*) AS n FROM destinations WHERE room_id IN (?, ?) AND status = 'ACTIVE'`, roomRef(p), p.id)],
    ] : [];
    return list.filter(([, n]) => n > 0).map(([what, n]) => ({ what, count: n }));
  }

  // ---- Internals -----------------------------------------------------------------------------------------------------
  private shape(data: unknown): string {
    const json = JSON.stringify(data ?? null);
    const d = data as Partial<FacilityData> | null;
    if (!d || typeof d !== 'object' || KINDS.some((k) => !Array.isArray(d[k]))) throw new AppError('VALIDATION_ERROR', 'ข้อมูลผังไม่ครบ (อาคาร ชั้น แผนก กลุ่มบริการ จุดบริการ)');
    if (json.length > MAX_JSON) throw new AppError('VALIDATION_ERROR', 'ผังใหญ่เกินที่รองรับ');
    return json;
  }
  // References to things the new facility removes (error: retire them instead) or switches off / retires (warning).
  private references(next: FacilityData): Issue[] {
    const out: Issue[] = [], nx = indexFacility(next), nowIso = this.now().toISOString(), day = localDay(this.now());
    const count = (sql: string, ...args: (string | number)[]) => (this.store.db.prepare(sql).get(...args) as { n: number }).n;
    for (const d of this.cur.departments) {
      const gone = !nx.department.has(d.id), offNow = !gone && departmentInUse(this.ix, d.id) && !departmentInUse(nx, d.id);
      if (!gone && !offNow) continue;
      const refs = [
        ['การจองล่วงหน้า', count(`SELECT COUNT(*) AS n FROM bookings b JOIN booking_slots s ON s.id = b.slot_id WHERE b.service_code = ? AND b.status = 'CONFIRMED' AND s.starts_at >= ?`, d.id, nowIso)],
        ['นัดหมายล่วงหน้า', count(`SELECT COUNT(*) AS n FROM appointments a JOIN appointment_slots s ON s.id = a.slot_id WHERE a.clinic_code = ? AND a.status = 'CONFIRMED' AND s.starts_at >= ?`, d.id, nowIso)],
        ['ตารางออกตรวจ', count(`SELECT COUNT(*) AS n FROM provider_schedules WHERE clinic_code = ? AND status = 'OPEN' AND ends_at >= ?`, d.id, nowIso)],
        ['ผู้ป่วยในคิววันนี้', count(`SELECT COUNT(*) AS n FROM visits WHERE day = ? AND clinic_key = ? AND status = 'active'`, day, d.id)],
        ...(gone ? [['เจ้าหน้าที่ที่ดูแลแผนกนี้', count('SELECT COUNT(*) AS n FROM user_clinics WHERE clinic_key = ?', d.id)] as [string, number]] : []),
      ].filter(([, n]) => (n as number) > 0) as [string, number][];
      if (!refs.length) continue;
      const list = refs.map(([what, n]) => `${what} ${n} รายการ`).join(', ');
      out.push(gone ? { level: 'error', at: d.id, message: `ลบแผนก${d.name}ไม่ได้: ยังมี${list} — ใช้ "เลิกใช้" แทน` }
        : { level: 'warning', at: d.id, message: `ปิดแผนก${d.name}: ยังมี${list} — ต้องย้ายหรือยกเลิกเอง` });
    }
    for (const p of this.cur.points) {
      const gone = !nx.point.has(p.id), offNow = !gone && pointInUse(this.ix, p.id) && !pointInUse(nx, p.id);
      if (!gone && !offNow) continue;
      const ref = roomRef(p);
      const refs = ([
        ['ตารางออกตรวจที่ระบุห้องนี้', count(`SELECT COUNT(*) AS n FROM provider_schedules WHERE room_id IN (?, ?) AND status = 'OPEN' AND ends_at >= ?`, ref, p.id, nowIso)],
        ['ผู้ป่วยวันนี้ที่รอห้องนี้', count(`SELECT COUNT(*) AS n FROM visits WHERE day = ? AND exam_room IN (?, ?) AND status = 'active'`, day, ref, p.id)],
        ['การเรียกคิววันนี้', count(`SELECT COUNT(*) AS n FROM queue_events WHERE day = ? AND json_extract(body, '$.station') = ?`, day, p.id)],
        ['ป้าย QR นำทาง', gone ? count(`SELECT COUNT(*) AS n FROM destinations WHERE room_id IN (?, ?) AND status = 'ACTIVE'`, ref, p.id) : 0],
      ] as [string, number][]).filter(([, n]) => n > 0);
      if (!refs.length) continue;
      const name = this.stationName(p.id) ?? p.id, list = refs.map(([what, n]) => `${what} ${n} รายการ`).join(', ');
      out.push(gone ? { level: 'error', at: p.id, message: `ลบ${name}ไม่ได้: ยังมี${list} — ใช้ "ปิด" หรือ "เลิกใช้" แทน` }
        : { level: 'warning', at: p.id, message: `ปิด${name}: ยังมี${list}` });
    }
    return out;
  }
  private write(data: FacilityData, by: string, source: VersionInfo['source'], note?: string, summary: ChangeSummary = diff(undefined, data).summary) {
    const db = this.store.db, at = this.now().toISOString();
    this.store.tx(() => {
      for (const t of ['facility_buildings', 'facility_floors', 'facility_departments', 'facility_service_groups', 'facility_service_points', 'facility_site']) db.prepare(`DELETE FROM ${t}`).run();
      const b = db.prepare('INSERT INTO facility_buildings (id, name, short_name, kind, map_json, sort, active, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      data.buildings.forEach((x, i) => b.run(x.id, x.name, x.shortName ?? '', x.kind, JSON.stringify(x.map), i, x.active ? 1 : 0, x.retiredAt ?? null));
      const f = db.prepare('INSERT INTO facility_floors (id, building_id, level, name, description, sort, active, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      data.floors.forEach((x, i) => f.run(x.id, x.buildingId, x.level, x.name, x.description ?? '', i, x.active ? 1 : 0, x.retiredAt ?? null));
      const d = db.prepare('INSERT INTO facility_departments (id, name, short_name, type, queue_prefix, features_json, first_group_id, sort, active, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      data.departments.forEach((x, i) => d.run(x.id, x.name, x.shortName ?? null, x.type, x.queuePrefix ?? null, JSON.stringify(x.features), x.firstGroupId ?? null, i, x.active ? 1 : 0, x.retiredAt ?? null));
      const g = db.prepare('INSERT INTO facility_service_groups (id, department_id, name, floor_id, point_kind, point_noun, steps_json, serves, min_open, options_json, sort, active, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      data.groups.forEach((x, i) => g.run(x.id, x.departmentId, x.name, x.floorId, x.pointKind, x.pointNoun, JSON.stringify(x.steps), x.serves, x.minOpen, x.options ? JSON.stringify(x.options) : null, i, x.active ? 1 : 0, x.retiredAt ?? null));
      const p = db.prepare('INSERT INTO facility_service_points (id, group_id, number, name, room_code, floor_id, room_kind, in_room_id, map_json, sort, active, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      data.points.forEach((x, i) => p.run(x.id, x.groupId, x.number, x.name ?? null, x.roomCode ?? null, x.floorId ?? null, x.roomKind ?? null, x.inRoomId ?? null, x.map ? JSON.stringify(x.map) : null, i, x.active ? 1 : 0, x.retiredAt ?? null));
      db.prepare('INSERT INTO facility_site (id, site_json) VALUES (1, ?)').run(JSON.stringify(data.site));
      const version = ((db.prepare('SELECT MAX(version) AS v FROM facility_versions').get() as { v: number | null }).v ?? 0) + 1;
      db.prepare('INSERT INTO facility_versions (version, published_at, published_by, source, note, summary_json, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(version, at, by, source, note ?? null, JSON.stringify(summary), JSON.stringify(data));
    });
    this.load();
  }
  // The published version from the tables (the version row holds the same, but the tables are what is current).
  private load() {
    const db = this.store.db, all = (t: string) => db.prepare(`SELECT * FROM ${t} ORDER BY sort`).all() as Row[];
    const state = (r: Row) => strip({ active: bool(r.active), retiredAt: opt(r.retired_at as string | null) });
    const data: FacilityData = {
      buildings: all('facility_buildings').map((r) => ({ id: r.id as string, name: r.name as string, shortName: r.short_name as string, kind: r.kind as never, map: JSON.parse(r.map_json as string), ...state(r) })),
      floors: all('facility_floors').map((r) => ({ id: r.id as string, buildingId: r.building_id as string, level: r.level as number, name: r.name as string, description: r.description as string, ...state(r) })),
      departments: all('facility_departments').map((r) => strip({ id: r.id as string, name: r.name as string, shortName: opt(r.short_name as string | null), type: r.type as never,
        queuePrefix: opt(r.queue_prefix as string | null), features: JSON.parse(r.features_json as string), firstGroupId: opt(r.first_group_id as string | null), ...state(r) })),
      groups: all('facility_service_groups').map((r) => strip({ id: r.id as string, departmentId: r.department_id as string, name: r.name as string, floorId: (r.floor_id as string | null) ?? null,
        pointKind: r.point_kind as never, pointNoun: r.point_noun as string, steps: JSON.parse(r.steps_json as string), serves: r.serves as never, minOpen: r.min_open as number,
        options: r.options_json ? JSON.parse(r.options_json as string) : undefined, ...state(r) })),
      points: all('facility_service_points').map((r) => strip({ id: r.id as string, groupId: r.group_id as string, number: r.number as number, name: opt(r.name as string | null),
        roomCode: opt(r.room_code as string | null), floorId: opt(r.floor_id as string | null), roomKind: opt(r.room_kind as never), inRoomId: opt(r.in_room_id as string | null),
        map: r.map_json ? JSON.parse(r.map_json as string) : undefined, ...state(r) })),
      site: JSON.parse((db.prepare('SELECT site_json FROM facility_site WHERE id = 1').get() as { site_json: string }).site_json),
    };
    const v = db.prepare('SELECT version, published_at FROM facility_versions ORDER BY version DESC LIMIT 1').get() as { version: number; published_at: string };
    this.cur = { ...data, version: v.version, publishedAt: v.published_at };
    this.ix = indexFacility(this.cur);
  }
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const emptySummary = (): ChangeSummary => Object.fromEntries([...KINDS, 'site'].map((k) => [k, { added: 0, changed: 0, removed: 0 }])) as ChangeSummary;
// What differs between two facilities, entity by entity (order changes count as a change of the moved thing).
function diff(a: FacilityData | undefined, b: FacilityData): { summary: ChangeSummary; changes: Change[] } {
  const summary = emptySummary(), changes: Change[] = [];
  const canon = (x: object) => JSON.stringify(Object.entries(x).filter(([, v]) => v !== undefined).sort(([p], [q]) => (p < q ? -1 : 1)));
  for (const k of KINDS) {
    const before = new Map((a?.[k] ?? []).map((x, i) => [x.id, { x, i }] as const)), after = new Map(b[k].map((x, i) => [x.id, { x, i }] as const));
    const nameOf = (x: { id: string; name?: string; number?: number }) => x.name || (x.number !== undefined ? String(x.number) : x.id);
    for (const [id, { x, i }] of after) {
      const old = before.get(id);
      if (!old) { summary[k].added++; changes.push({ kind: k, id, name: nameOf(x), change: 'added' }); continue; }
      if (canon(old.x) === canon(x) && old.i === i) continue;
      summary[k].changed++;
      const was = old.x as { active: boolean; retiredAt?: string }, now = x as { active: boolean; retiredAt?: string };
      changes.push({ kind: k, id, name: nameOf(x), change: !was.retiredAt && now.retiredAt ? 'retired' : usable(was) && !usable(now) ? 'off' : !usable(was) && usable(now) ? 'on' : 'changed' });
    }
    for (const [id, { x }] of before) if (!after.has(id)) { summary[k].removed++; changes.push({ kind: k, id, name: nameOf(x), change: 'removed' }); }
  }
  if (a && JSON.stringify(a.site ?? null) !== JSON.stringify(b.site ?? null)) { summary.site.changed = 1; changes.push({ kind: 'site', id: 'site', name: 'ผังพื้นที่รอบอาคาร', change: 'changed' }); }
  return { summary, changes };
}
