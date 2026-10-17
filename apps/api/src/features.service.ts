import { Injectable } from '@nestjs/common';
import { DbService } from './db.service';
import { AppError } from './errors';

// Phase 2 switches, each on its own so one part can be piloted (or switched off in an incident) without the others.
// All start off: a running Phase 1 installation behaves exactly as before until an administrator turns one on.
// Turning a switch off hides the feature and refuses its commands; records already made are kept.
export const PHASE2_FLAGS = ['accountLinking', 'generalBooking', 'appointments', 'notifications', 'wayfinding', 'staffOverrides'] as const;
export type Phase2Flag = (typeof PHASE2_FLAGS)[number];
export type Phase2Flags = Record<Phase2Flag, boolean>;
export const flagText: Record<Phase2Flag, string> = {
  accountLinking: 'เชื่อมบัญชี LINE กับผู้ป่วย', generalBooking: 'จองคิวล่วงหน้า', appointments: 'นัดแพทย์',
  notifications: 'แจ้งเตือนการจองและนัด', wayfinding: 'QR นำทาง', staffOverrides: 'เจ้าหน้าที่แก้ไขแทนผู้ป่วย',
};
const KEY = 'features.phase2';
const OFF = Object.fromEntries(PHASE2_FLAGS.map((f) => [f, false])) as Phase2Flags;

@Injectable()
export class FeaturesService {
  constructor(private readonly store: DbService) {}

  get(): Phase2Flags {
    return { ...OFF, ...(this.store.getKv<Partial<Phase2Flags>>(KEY) ?? {}) };
  }
  on(flag: Phase2Flag) {
    return this.get()[flag];
  }
  // For command handlers: stop here when the feature is switched off.
  require(flag: Phase2Flag) {
    if (!this.on(flag)) throw new AppError('FEATURE_DISABLED', `ยังไม่ได้เปิดใช้: ${flagText[flag]}`);
  }
  // Returns the switches that actually changed (for the audit trail).
  set(patch: unknown): { ok: true; flags: Phase2Flags; changed: Partial<Phase2Flags> } | { ok: false; reason: string } {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, reason: 'คำสั่งไม่ถูกต้อง' };
    const entries = Object.entries(patch as Record<string, unknown>);
    if (!entries.length || entries.some(([k, v]) => !(PHASE2_FLAGS as readonly string[]).includes(k) || typeof v !== 'boolean')) return { ok: false, reason: 'ชื่อหรือค่าของสวิตช์ไม่ถูกต้อง' };
    const before = this.get(), next = { ...before, ...(patch as Partial<Phase2Flags>) };
    const changed = Object.fromEntries(PHASE2_FLAGS.filter((f) => before[f] !== next[f]).map((f) => [f, next[f]])) as Partial<Phase2Flags>;
    this.store.setKv(KEY, next);
    return { ok: true, flags: next, changed };
  }
}
