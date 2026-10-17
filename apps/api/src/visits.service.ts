import { Injectable } from '@nestjs/common';
import { DbService } from './db.service';
import { AppError } from './errors';

// Real patients in the queue ("live" data mode). The demo builds its patients in the browser from a simulation;
// a visit is the server-side record that lets a real person — registered at a counter, checked in from a booking,
// or sent by the HIS — appear on the same consoles, map, TV boards and patient page.
// The live queue still runs on the queue log (call / start / done … refer to visit id + step position); the visit
// only says who is in the queue, with which number, and which steps they have been sent to.
// Deliberately without name or HN, so a visit can be shown wherever a queue number can.
export type StepKind = 'registration' | 'screening' | 'exam' | 'lab' | 'xray' | 'followup' | 'pharmacy' | 'finance' | 'triage' | 'treatment';
export type PriorityKey = 'monk' | 'pregnant' | 'wheelchair' | 'disabled' | 'elderly';
export type VisitStep = { kind: StepKind; at: number };
export type Visit = {
  id: string; queue: string; flow: 'opd' | 'er'; clinicKey?: string; dept: string; priority?: PriorityKey; triage?: number;
  arrival: number; steps: VisitStep[]; status: 'active' | 'cancelled';
  bookedSlot?: string; // came with a booking: its time (e.g. 08:00–09:00), shown to staff beside the number
};
export type VisitSource = { type: 'STAFF' | 'HIS' | 'BOOKING' | 'APPOINTMENT'; id: string };
export type EnterInput = { flow?: unknown; clinicKey?: unknown; dept?: unknown; prefix?: unknown; priority?: unknown; triage?: unknown; steps?: unknown; at?: unknown };

const OPD_STEPS: StepKind[] = ['registration', 'screening', 'exam', 'lab', 'xray', 'followup', 'pharmacy', 'finance'];
const ER_STEPS: StepKind[] = ['triage', 'treatment', 'lab', 'xray', 'pharmacy', 'finance'];
const PRIORITIES: PriorityKey[] = ['monk', 'pregnant', 'wheelchair', 'disabled', 'elderly'];
// The usual opening of a visit; the rest (lab, x-ray, follow-up, pharmacy, cashier) is added as the doctor orders it.
const DEFAULT_STEPS = { opd: ['screening', 'exam'] as StepKind[], er: ['triage', 'treatment'] as StepKind[] };
const MAX_STEPS = 16;
export const VISIT_ID_RE = /^v-\d{4,6}$/;
type Row = { id: string; queue: string; flow: 'opd' | 'er'; clinic_key: string | null; dept: string; priority: PriorityKey | null; triage: number | null; arrival: number; steps_json: string; status: 'active' | 'cancelled'; booked_slot: string | null };
const toVisit = (r: Row): Visit => ({ id: r.id, queue: r.queue, flow: r.flow, clinicKey: r.clinic_key ?? undefined, dept: r.dept, priority: r.priority ?? undefined,
  triage: r.triage ?? undefined, arrival: r.arrival, steps: JSON.parse(r.steps_json) as VisitStep[], status: r.status, ...(r.booked_slot ? { bookedSlot: r.booked_slot } : {}) });
const bad = (reason: string) => new AppError('VALIDATION_ERROR', reason);
const minuteOk = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 24 * 60;
// The hospital's local calendar day, as the queue log uses.
const today = () => new Date().toLocaleDateString('sv-SE');

@Injectable()
export class VisitsService {
  constructor(private readonly store: DbService) {}

  list(): Visit[] {
    return (this.store.db.prepare('SELECT * FROM visits WHERE day = ? ORDER BY arrival, id').all(today()) as Row[]).map(toVisit);
  }
  // Today's visits of one patient (checked in from a booking or an appointment) — for their LINE page.
  forProfile(profileId: string): Visit[] {
    return (this.store.db.prepare(`SELECT * FROM visits WHERE day = ? AND patient_profile_id = ? AND status = 'active' ORDER BY arrival`).all(today(), profileId) as Row[]).map(toVisit);
  }
  get(id: unknown): Visit | undefined {
    if (typeof id !== 'string' || !VISIT_ID_RE.test(id)) return undefined;
    const r = this.store.db.prepare('SELECT * FROM visits WHERE day = ? AND id = ?').get(today(), id) as Row | undefined;
    return r ? toVisit(r) : undefined;
  }
  bySource(source: VisitSource): Visit | undefined {
    const r = this.store.db.prepare('SELECT * FROM visits WHERE source_type = ? AND source_id = ? AND day = ?').get(source.type, source.id, today()) as Row | undefined;
    return r ? toVisit(r) : undefined;
  }

  // Take a patient into the queue: a new visit with the next number for its prefix.
  // The same source (an HIS visit number, a booking) never gives a second visit: the first is returned (created=false).
  // extra: who the patient is (check-in from a booking — kept off the screens) and the booked time.
  enter(input: EnterInput, source?: VisitSource, extra: { profileId?: string; bookedSlot?: string } = {}): { visit: Visit; created: boolean } {
    const flow = input.flow;
    if (flow !== 'opd' && flow !== 'er') throw bad('ระบุประเภทผู้ป่วย (OPD / ER)');
    if (!minuteOk(input.at)) throw bad('เวลาไม่ถูกต้อง');
    let clinicKey: string | undefined, dept: string, prefix: string;
    if (flow === 'opd') {
      if (typeof input.clinicKey !== 'string' || !/^opd-\d-\d{1,2}$/.test(input.clinicKey)) throw bad('ระบุคลินิก');
      if (typeof input.dept !== 'string' || !input.dept.trim() || input.dept.length > 30) throw bad('ระบุชื่อแผนก');
      if (typeof input.prefix !== 'string' || !/^[A-Z]{1,2}$/.test(input.prefix)) throw bad('อักษรนำหน้าคิวไม่ถูกต้อง');
      clinicKey = input.clinicKey; dept = input.dept.trim(); prefix = input.prefix;
    } else { dept = 'ห้องฉุกเฉิน'; prefix = 'ER'; }
    const priority = input.priority;
    if (priority !== undefined && priority !== null && !PRIORITIES.includes(priority as PriorityKey)) throw bad('ประเภทคิวพิเศษไม่ถูกต้อง');
    const triage = input.triage;
    if (triage !== undefined && triage !== null && (flow !== 'er' || !Number.isInteger(triage) || (triage as number) < 1 || (triage as number) > 5)) throw bad('ระดับคัดแยกไม่ถูกต้อง');
    const kinds = input.steps === undefined ? DEFAULT_STEPS[flow] : input.steps;
    const allowed = flow === 'opd' ? OPD_STEPS : ER_STEPS;
    if (!Array.isArray(kinds) || !kinds.length || kinds.length > MAX_STEPS || kinds.some((k) => !allowed.includes(k))) throw bad('ขั้นตอนไม่ถูกต้อง');
    if (source && (typeof source.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(source.id))) throw bad('รหัสอ้างอิงไม่ถูกต้อง');

    return this.store.tx(() => {
      const existing = source && this.bySource(source);
      if (existing) return { visit: existing, created: false };
      const day = today();
      const id = `v-${String(this.next(day, '#visit')).padStart(4, '0')}`;
      const queue = `${prefix}${String(this.next(day, prefix)).padStart(3, '0')}`;
      const at = Math.floor(input.at as number), steps = (kinds as StepKind[]).map((kind) => ({ kind, at }));
      this.store.db.prepare(`INSERT INTO visits (day, id, queue, flow, clinic_key, dept, priority, triage, arrival, steps_json, status, source_type, source_id, created_at, patient_profile_id, booked_slot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`).run(day, id, queue, flow, clinicKey ?? null, dept, (priority as string | undefined) ?? null,
        (triage as number | undefined) ?? null, at, JSON.stringify(steps), source?.type ?? null, source?.id ?? null, new Date().toISOString(), extra.profileId ?? null, extra.bookedSlot ?? null);
      return { visit: this.get(id)!, created: true };
    });
  }

  // Send the patient on to a further step (the doctor orders a lab test, then the pharmacy …). Added at the end only.
  addStep(id: unknown, kind: unknown, at: unknown): Visit {
    return this.store.tx(() => {
      const v = this.get(id);
      if (!v) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบผู้ป่วย');
      if (v.status !== 'active') throw new AppError('INVALID_STATE_TRANSITION', 'รายการนี้ถูกยกเลิกแล้ว');
      if (!(v.flow === 'opd' ? OPD_STEPS : ER_STEPS).includes(kind as StepKind)) throw bad('ขั้นตอนไม่ถูกต้อง');
      if (!minuteOk(at)) throw bad('เวลาไม่ถูกต้อง');
      if (v.steps.length >= MAX_STEPS) throw new AppError('POLICY_REJECTED', 'ขั้นตอนมากเกินไป');
      const steps = [...v.steps, { kind: kind as StepKind, at: Math.floor(at) }];
      this.store.db.prepare('UPDATE visits SET steps_json = ? WHERE day = ? AND id = ?').run(JSON.stringify(steps), today(), v.id);
      return { ...v, steps };
    });
  }

  // Taken in by mistake / left before being seen. Repeating it is harmless.
  cancel(id: unknown): { visit: Visit; changed: boolean } {
    return this.store.tx(() => {
      const v = this.get(id);
      if (!v) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบผู้ป่วย');
      if (v.status === 'cancelled') return { visit: v, changed: false };
      this.store.db.prepare("UPDATE visits SET status = 'cancelled' WHERE day = ? AND id = ?").run(today(), v.id);
      return { visit: { ...v, status: 'cancelled' as const }, changed: true };
    });
  }

  // Next running number for a day and prefix (inside the caller's transaction).
  private next(day: string, prefix: string): number {
    const r = this.store.db.prepare(`INSERT INTO queue_counters (day, prefix, last_no) VALUES (?, ?, 1)
      ON CONFLICT(day, prefix) DO UPDATE SET last_no = last_no + 1 RETURNING last_no`).get(day, prefix) as { last_no: number };
    return r.last_no;
  }
}
