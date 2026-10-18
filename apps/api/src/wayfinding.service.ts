import { Injectable } from '@nestjs/common';
import { DbService } from './db.service';
import { AppError } from './errors';
import { buildingName, floorName, mainEntrance } from './facility-names';
import { FacilityService } from './facility.service';
import { pointByRoomRef } from './facility-model';

// Wayfinding: the public places patients look for (a department, the pharmacy, the cashier, the lifts…), each with a
// stable code that QR signs carry (/wayfinding?at=CODE: "you are here"; ?to=CODE: "how do I get there").
// Public data only. A place that is closed or moved is retired — with a pointer to where it went, so printed signs
// keep leading somewhere useful. A place for a department on a floor (departmentId) is drawn where the facility puts
// that department's waiting area on that floor (zoneIndex follows the facility); `problem` tells administrators when
// the department is no longer there.
export type Destination = { code: string; nameTh: string; buildingId: string; level: number; zoneIndex?: number; roomId?: string; departmentId?: string; landmarkTh?: string;
  descriptionTh?: string; isPublic: boolean; status: 'ACTIVE' | 'RETIRED'; replacedBy?: string; updatedAt: string; problem?: string };
type Row = { code: string; name_th: string; building_id: string; level: number; zone_index: number | null; room_id: string | null; department_id: string | null; landmark_th: string | null;
  description_th: string | null; is_public: number; status: 'ACTIVE' | 'RETIRED'; replaced_by: string | null; updated_at: string };
export const CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,31}$/;
const bad = (reason: string) => new AppError('VALIDATION_ERROR', reason);
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// Steps from a place (where a kiosk stands, or the main entrance) to a place — the same rules as the web page's
// directions() (apps/web/lib/wayfinding.ts): building → floor (lifts named first) → the place's own landmark. Building
// and floor level only: turn-by-turn needs the hospital's corridor map, which is not in the system yet.
export function routeSteps(from: Destination | undefined, to: Destination): string[] {
  const steps: string[] = [];
  if (from && from.code === to.code) return ['คุณอยู่ที่นี่แล้ว'];
  const entry = mainEntrance(), start = from ?? entry ?? { buildingId: to.buildingId, level: 1 };
  if (!from) steps.push(entry ? `เริ่มจาก${entry.nameTh} ${floorName(entry.buildingId, entry.level)}` : 'เริ่มจากทางเข้าหลัก');
  if (start.buildingId !== to.buildingId) {
    if (start.level !== 1) steps.push(`ใช้ลิฟต์หรือบันไดลงไป${floorName(start.buildingId, 1)}ของ${buildingName(start.buildingId)}`);
    steps.push(`ออกไปทาง${buildingName(to.buildingId)} ตามป้ายบอกทาง`);
    if (to.level !== 1) steps.push(`ขึ้นลิฟต์หรือบันไดไป${floorName(to.buildingId, to.level)}`);
  } else if (start.level !== to.level) steps.push(`${to.level > start.level ? 'ขึ้น' : 'ลง'}ลิฟต์หรือบันไดไป${floorName(to.buildingId, to.level)}`);
  else steps.push('อยู่ชั้นเดียวกัน เดินตามทางเดินกลาง');
  steps.push(`${to.nameTh}${to.landmarkTh ? ` · ${to.landmarkTh}` : ''}`);
  return steps;
}

@Injectable()
export class WayfindingService {
  private readonly facility: FacilityService;
  constructor(private readonly store: DbService, facility?: FacilityService) {
    this.facility = facility ?? new FacilityService(store);
    this.linkDepartments();
  }
  // Places made before they could name their department: linked by the department's name on that floor, else by the
  // position of its waiting band there.
  private linkDepartments() {
    const rows = this.store.db.prepare('SELECT code, name_th, building_id, level, zone_index FROM destinations WHERE department_id IS NULL').all() as Row[];
    const set = this.store.db.prepare('UPDATE destinations SET department_id = ? WHERE code = ?');
    for (const r of rows) {
      const bands = this.facility.bandsOn(r.building_id, r.level);
      const byName = bands.find((id) => this.facility.department(id)?.name === r.name_th), byZone = r.zone_index !== null ? bands[r.zone_index] : undefined;
      const id = byName ?? (byZone && this.facility.department(byZone)?.name === r.name_th ? byZone : undefined);
      if (id) set.run(id, r.code);
    }
  }
  private toDest(r: Row): Destination {
    const d: Destination = { code: r.code, nameTh: r.name_th, buildingId: r.building_id, level: r.level, zoneIndex: r.zone_index ?? undefined, roomId: r.room_id ?? undefined,
      departmentId: r.department_id ?? undefined, landmarkTh: r.landmark_th ?? undefined, descriptionTh: r.description_th ?? undefined, isPublic: !!r.is_public, status: r.status,
      replacedBy: r.replaced_by ?? undefined, updatedAt: r.updated_at };
    if (!d.departmentId) delete d.departmentId;
    if (d.departmentId) {
      const dept = this.facility.department(d.departmentId), zone = this.facility.bandsOn(d.buildingId, d.level).indexOf(d.departmentId);
      if (!dept || dept.retiredAt) d.problem = 'แผนกนี้เลิกใช้แล้ว';
      else if (zone < 0) d.problem = `แผนก${dept.name}ไม่อยู่บน${buildingName(d.buildingId)} ${floorName(d.buildingId, d.level)}แล้ว — แก้ที่ตั้งหรือเลิกใช้จุดนี้`;
      else d.zoneIndex = zone;
    }
    if (!this.facility.floorAt(d.buildingId, d.level)) d.problem = d.problem ?? 'ไม่มีชั้นนี้ในผังโรงพยาบาลแล้ว';
    if (d.status !== 'ACTIVE' || !d.problem) delete d.problem;
    if (d.zoneIndex === undefined) delete d.zoneIndex;
    return d;
  }

  list(all = false): Destination[] {
    return (this.store.db.prepare(`SELECT * FROM destinations ${all ? '' : "WHERE status = 'ACTIVE' AND is_public = 1"} ORDER BY building_id, level, name_th`).all() as Row[]).map((r) => this.toDest(r));
  }
  // A public place by code. Retired: where it went instead (followed up to 5 steps), or that it is no longer in use.
  lookup(code: unknown): { destination: Destination } | { retired: true; replacedBy?: Destination } {
    const c = typeof code === 'string' ? code.trim().toUpperCase() : '';
    if (!CODE_RE.test(c)) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบจุดหมายนี้');
    let d = this.get(c);
    if (!d || !d.isPublic) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบจุดหมายนี้');
    if (d.status === 'ACTIVE') return { destination: d };
    for (let i = 0; i < 5 && d?.status === 'RETIRED' && d.replacedBy; i++) d = this.get(d.replacedBy);
    return d && d.status === 'ACTIVE' && d.isPublic ? { retired: true, replacedBy: d } : { retired: true };
  }
  get(code: string): Destination | undefined {
    const r = this.store.db.prepare('SELECT * FROM destinations WHERE code = ?').get(code) as Row | undefined;
    return r ? this.toDest(r) : undefined;
  }

  // Create or change one place (administrators). The code never changes once printed.
  save(input: Record<string, unknown>, by: string): Destination {
    const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
    if (!CODE_RE.test(code)) throw bad('รหัสจุดหมายใช้ A–Z 0–9 และ - ยาว 2–32 ตัว เช่น OPD-PHARMACY');
    const name = text(input.nameTh, 60);
    if (!name) throw bad('ระบุชื่อจุดหมาย');
    // Building, floor, department and room as the facility has them.
    const b = typeof input.buildingId === 'string' ? this.facility.index().building.get(input.buildingId) : undefined;
    if (!b || b.retiredAt) throw bad('ระบุอาคาร (อาคารในผังโรงพยาบาล)');
    if (!Number.isInteger(input.level) || !this.facility.floorAt(b.id, input.level as number)) throw bad('ระบุชั้น (ชั้นของอาคารนี้ในผังโรงพยาบาล)');
    if (input.zoneIndex !== undefined && input.zoneIndex !== null && (!Number.isInteger(input.zoneIndex) || (input.zoneIndex as number) < 0 || (input.zoneIndex as number) > 30)) throw bad('โซนไม่ถูกต้อง');
    const dept = input.departmentId === undefined || input.departmentId === null || input.departmentId === '' ? null : typeof input.departmentId === 'string' ? this.facility.department(input.departmentId) : undefined;
    if (dept === undefined || (dept && dept.retiredAt)) throw bad('แผนกไม่ถูกต้อง (แผนกในผังโรงพยาบาล)');
    const room = input.roomId === undefined || input.roomId === null || input.roomId === '' ? null : typeof input.roomId === 'string' ? pointByRoomRef(this.facility.index(), input.roomId) : undefined;
    if (room === undefined) throw bad('ห้องไม่ถูกต้อง (ห้องในผังโรงพยาบาล)');
    const cur = this.get(code);
    if (cur?.status === 'RETIRED') throw new AppError('INVALID_STATE_TRANSITION', 'จุดหมายนี้เลิกใช้แล้ว — สร้างรหัสใหม่แทน');
    this.store.db.prepare(`INSERT INTO destinations (code, name_th, building_id, level, zone_index, room_id, department_id, landmark_th, description_th, is_public, status, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?) ON CONFLICT(code) DO UPDATE SET name_th = excluded.name_th, building_id = excluded.building_id, level = excluded.level,
      zone_index = excluded.zone_index, room_id = excluded.room_id, department_id = excluded.department_id, landmark_th = excluded.landmark_th, description_th = excluded.description_th,
      is_public = excluded.is_public, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(code, name, b.id, input.level as number, (input.zoneIndex as number | null | undefined) ?? null, (input.roomId as string | null | undefined) || null, dept?.id ?? null,
        text(input.landmarkTh, 120), text(input.descriptionTh, 200), input.isPublic === false ? 0 : 1, new Date().toISOString(), by);
    return this.get(code)!;
  }
  // Add places not there yet (from the department directory): a department that already has a place on that floor,
  // or a code already in use, is left as it is. Without a code, one is made: <BUILDING>-<floor><letter> (OPD-3D).
  importMany(list: unknown, by: string): { added: number; kept: number } {
    if (!Array.isArray(list) || list.length > 300) throw bad('รายการไม่ถูกต้อง');
    return this.store.tx(() => {
      let added = 0;
      for (const raw of list) {
        const item = (raw ?? {}) as Record<string, unknown>;
        let code = typeof item.code === 'string' ? item.code.trim().toUpperCase() : '';
        if (code && this.get(code)) continue;
        if (typeof item.departmentId === 'string' && this.store.db.prepare(`SELECT 1 FROM destinations WHERE department_id = ? AND building_id = ? AND level = ? AND status = 'ACTIVE'`)
          .get(item.departmentId, String(item.buildingId), Number(item.level))) continue;
        if (!code) code = this.freeCode(String(item.buildingId), Number(item.level));
        this.save({ ...item, code }, by); added++;
      }
      return { added, kept: list.length - added };
    });
  }
  private freeCode(buildingId: string, level: number) {
    const base = `${buildingId.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) || 'PLACE'}-${level}`;
    for (let i = 0; i < 26; i++) { const c = `${base}${String.fromCharCode(65 + i)}`; if (!this.get(c)) return c; }
    for (let n = 1; ; n++) { const c = `${base}-${n}`; if (!this.get(c)) return c; }
  }
  // Out of use; signs for it lead to `replacedBy` (an active place) if given.
  retire(code: unknown, replacedBy: unknown, by: string): Destination {
    const d = typeof code === 'string' ? this.get(code.trim().toUpperCase()) : undefined;
    if (!d) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบจุดหมายนี้');
    const to = typeof replacedBy === 'string' && replacedBy.trim() ? this.get(replacedBy.trim().toUpperCase()) : undefined;
    if (replacedBy && (!to || to.status !== 'ACTIVE' || to.code === d.code)) throw bad('จุดหมายแทนต้องเป็นจุดที่ยังใช้งาน');
    this.store.db.prepare(`UPDATE destinations SET status = 'RETIRED', replaced_by = ?, updated_at = ?, updated_by = ? WHERE code = ?`).run(to?.code ?? null, new Date().toISOString(), by, d.code);
    return this.get(d.code)!;
  }
}
