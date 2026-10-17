import { Injectable } from '@nestjs/common';
import { DbService } from './db.service';
import { AppError } from './errors';

// Wayfinding: the public places patients look for (a department, the pharmacy, the cashier, the lifts…), each with a
// stable code that QR signs carry (/wayfinding?at=CODE: "you are here"; ?to=CODE: "how do I get there").
// Public data only. A place that is closed or moved is retired — with a pointer to where it went, so printed signs
// keep leading somewhere useful.
export type Destination = { code: string; nameTh: string; buildingId: string; level: number; zoneIndex?: number; roomId?: string; landmarkTh?: string;
  descriptionTh?: string; isPublic: boolean; status: 'ACTIVE' | 'RETIRED'; replacedBy?: string; updatedAt: string };
type Row = { code: string; name_th: string; building_id: string; level: number; zone_index: number | null; room_id: string | null; landmark_th: string | null;
  description_th: string | null; is_public: number; status: 'ACTIVE' | 'RETIRED'; replaced_by: string | null; updated_at: string };
const toDest = (r: Row): Destination => ({ code: r.code, nameTh: r.name_th, buildingId: r.building_id, level: r.level, zoneIndex: r.zone_index ?? undefined,
  roomId: r.room_id ?? undefined, landmarkTh: r.landmark_th ?? undefined, descriptionTh: r.description_th ?? undefined, isPublic: !!r.is_public, status: r.status,
  replacedBy: r.replaced_by ?? undefined, updatedAt: r.updated_at });
export const CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,31}$/;
const bad = (reason: string) => new AppError('VALIDATION_ERROR', reason);
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

@Injectable()
export class WayfindingService {
  constructor(private readonly store: DbService) {}

  list(all = false): Destination[] {
    return (this.store.db.prepare(`SELECT * FROM destinations ${all ? '' : "WHERE status = 'ACTIVE' AND is_public = 1"} ORDER BY building_id, level, name_th`).all() as Row[]).map(toDest);
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
    return r ? toDest(r) : undefined;
  }

  // Create or change one place (administrators). The code never changes once printed.
  save(input: Record<string, unknown>, by: string): Destination {
    const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
    if (!CODE_RE.test(code)) throw bad('รหัสจุดหมายใช้ A–Z 0–9 และ - ยาว 2–32 ตัว เช่น OPD-PHARMACY');
    const name = text(input.nameTh, 60);
    if (!name) throw bad('ระบุชื่อจุดหมาย');
    if (typeof input.buildingId !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(input.buildingId)) throw bad('ระบุอาคาร');
    if (!Number.isInteger(input.level) || (input.level as number) < 0 || (input.level as number) > 20) throw bad('ระบุชั้น');
    if (input.zoneIndex !== undefined && input.zoneIndex !== null && (!Number.isInteger(input.zoneIndex) || (input.zoneIndex as number) < 0 || (input.zoneIndex as number) > 20)) throw bad('โซนไม่ถูกต้อง');
    if (input.roomId !== undefined && input.roomId !== null && (typeof input.roomId !== 'string' || !/^[a-z0-9-]{1,30}$/.test(input.roomId))) throw bad('ห้องไม่ถูกต้อง');
    const cur = this.get(code);
    if (cur?.status === 'RETIRED') throw new AppError('INVALID_STATE_TRANSITION', 'จุดหมายนี้เลิกใช้แล้ว — สร้างรหัสใหม่แทน');
    this.store.db.prepare(`INSERT INTO destinations (code, name_th, building_id, level, zone_index, room_id, landmark_th, description_th, is_public, status, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?) ON CONFLICT(code) DO UPDATE SET name_th = excluded.name_th, building_id = excluded.building_id, level = excluded.level,
      zone_index = excluded.zone_index, room_id = excluded.room_id, landmark_th = excluded.landmark_th, description_th = excluded.description_th, is_public = excluded.is_public,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(code, name, input.buildingId, input.level as number, (input.zoneIndex as number | null | undefined) ?? null, (input.roomId as string | null | undefined) ?? null,
        text(input.landmarkTh, 120), text(input.descriptionTh, 200), input.isPublic === false ? 0 : 1, new Date().toISOString(), by);
    return this.get(code)!;
  }
  // Add places not there yet (from the department directory); existing codes are left as they are.
  importMany(list: unknown, by: string): { added: number; kept: number } {
    if (!Array.isArray(list) || list.length > 300) throw bad('รายการไม่ถูกต้อง');
    return this.store.tx(() => {
      let added = 0;
      for (const item of list) {
        const code = typeof (item as { code?: unknown })?.code === 'string' ? (item as { code: string }).code.trim().toUpperCase() : '';
        if (this.get(code)) continue;
        this.save(item as Record<string, unknown>, by); added++;
      }
      return { added, kept: list.length - added };
    });
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
