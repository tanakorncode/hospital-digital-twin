import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

// Mirrors LiveSnapshot in @hospital/contracts.
export type LiveStatus = 'normal' | 'busy' | 'critical';
export type LiveSnapshot = {
  at: string;
  source: 'demo' | 'his-adapter';
  floors: Record<string, number>; // "buildingId:level" → people currently on that floor
  servicePoints: Record<string, { queue: number; waitMinutes: number; status: LiveStatus }>;
};

type Kind = 'opd' | 'er' | 'inpatient' | 'diagnostics' | 'support';
const HOUR_START = 0, HOUR_END = 23, REF_HOUR = 10;
// Stand-in for the HIS adapter. Uses the same demo baseline (values at REF_HOUR) and daily profiles (00–23) as
// apps/web/lib/scene-data.ts; replace this service with the real adapter's output when it exists.
const profile: Record<Kind, number[]> = {
  opd:         [0.01, 0.01, 0.01, 0.01, 0.01, 0.05, 0.10, 0.35, 0.75, 1.00, 0.95, 0.80, 0.45, 0.60, 0.55, 0.40, 0.25, 0.12, 0.06, 0.03, 0.02, 0.01, 0.01, 0.01],
  er:          [0.40, 0.35, 0.30, 0.28, 0.28, 0.30, 0.35, 0.40, 0.50, 0.55, 0.60, 0.55, 0.50, 0.55, 0.60, 0.65, 0.75, 0.85, 0.90, 0.80, 0.65, 0.60, 0.55, 0.45],
  inpatient:   [0.55, 0.55, 0.55, 0.55, 0.55, 0.58, 0.60, 0.65, 0.70, 0.75, 0.80, 0.95, 1.00, 0.85, 0.75, 0.80, 0.90, 1.00, 0.95, 0.80, 0.65, 0.60, 0.58, 0.55],
  diagnostics: [0.02, 0.02, 0.02, 0.02, 0.02, 0.03, 0.05, 0.15, 0.40, 0.75, 1.00, 0.95, 0.60, 0.55, 0.70, 0.60, 0.40, 0.20, 0.08, 0.04, 0.02, 0.02, 0.02, 0.02],
  support:     [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.10, 0.30, 0.80, 1.00, 1.00, 1.00, 0.70, 0.95, 1.00, 1.00, 0.90, 0.40, 0.15, 0.10, 0.05, 0.05, 0.05, 0.05],
};
// [buildingId, kind, people per floor from level 1 up]
const floors: [string, Kind, number[]][] = [
  ['opd', 'opd', [396, 243, 186, 120]],
  ['inpatient', 'inpatient', [48, 34, 61, 52, 38]],
  ['er', 'er', [27, 18, 6]],
  ['diagnostics', 'diagnostics', [84, 31, 22]],
  ['support', 'support', [18, 42]],
];
const servicePoints: [string, Kind, number, number, LiveStatus][] = [
  ['registration', 'opd', 42, 12, 'normal'],
  ['screening', 'opd', 18, 8, 'normal'],
  ['clinic', 'opd', 276, 52, 'critical'],
  ['lab', 'diagnostics', 35, 18, 'busy'],
  ['pharmacy', 'opd', 96, 28, 'busy'],
  ['finance', 'opd', 28, 9, 'normal'],
  ['radiology', 'diagnostics', 14, 20, 'normal'],
];
const levels: LiveStatus[] = ['normal', 'busy', 'critical'];

@Injectable()
export class LiveFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LiveFeedService.name);
  private timer?: NodeJS.Timeout;
  private readonly walk = new Map<string, number>(); // per-entity random walk so values drift plausibly
  private readonly listeners = new Set<(s: LiveSnapshot) => void>();
  private latest: LiveSnapshot = this.simulate(new Date());
  private lastIngest = 0; // while a real feed (HIS adapter) is sending, the demo feed stays quiet

  onModuleInit() {
    if (process.env.DEMO_FEED === 'off') {
      this.log.log('Demo live feed disabled (DEMO_FEED=off)');
      return;
    }
    const every = Number(process.env.DEMO_FEED_MS ?? 3000);
    this.timer = setInterval(() => {
      if (Date.now() - this.lastIngest < 60_000) return;
      this.latest = this.simulate(new Date());
      this.listeners.forEach((l) => l(this.latest));
    }, every);
    this.log.log(`Demo live feed every ${every} ms`);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  snapshot() {
    return this.latest;
  }

  // A snapshot from the HIS adapter (POST /ingest/live). Counts are aggregates only — no patient data.
  ingest(body: unknown): { ok: true } | { ok: false; reason: string } {
    const b = body as Partial<LiveSnapshot> | null;
    if (!b || typeof b !== 'object') return { ok: false, reason: 'body must be a LiveSnapshot object' };
    const at = typeof b.at === 'string' && !Number.isNaN(Date.parse(b.at)) ? b.at : new Date().toISOString();
    if (Math.abs(Date.parse(at) - Date.now()) > 15 * 60_000) return { ok: false, reason: '`at` is more than 15 minutes from server time' };
    const floors: Record<string, number> = {};
    for (const [k, v] of Object.entries(b.floors ?? {})) {
      if (!/^[a-z]+:\d{1,2}$/.test(k) || !Number.isInteger(v) || v < 0 || v > 20000) return { ok: false, reason: `floors["${k}"] must be a whole number 0–20000 ("buildingId:level")` };
      floors[k] = v;
    }
    const servicePoints: LiveSnapshot['servicePoints'] = {};
    for (const [k, v] of Object.entries(b.servicePoints ?? {})) {
      if (!/^[a-z][a-z0-9-]{0,40}$/.test(k) || !v || !Number.isInteger(v.queue) || v.queue < 0 || !Number.isFinite(v.waitMinutes) || v.waitMinutes < 0 || !levels.includes(v.status))
        return { ok: false, reason: `servicePoints["${k}"] needs queue (int ≥ 0), waitMinutes (≥ 0) and status normal|busy|critical` };
      servicePoints[k] = { queue: v.queue, waitMinutes: Math.round(v.waitMinutes), status: v.status };
    }
    this.latest = { at, source: 'his-adapter', floors: { ...this.latest.floors, ...floors }, servicePoints: { ...this.latest.servicePoints, ...servicePoints } };
    this.lastIngest = Date.now();
    this.listeners.forEach((l) => l(this.latest));
    return { ok: true };
  }

  subscribe(listener: (s: LiveSnapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private factor(kind: Kind, at: Date) {
    const p = profile[kind], h = Math.min(HOUR_END, Math.max(HOUR_START, at.getHours()));
    return p[h - HOUR_START] / p[REF_HOUR - HOUR_START];
  }

  private jitter(key: string) {
    const next = Math.min(1.15, Math.max(0.85, (this.walk.get(key) ?? 1) + (Math.random() - 0.5) * 0.06));
    this.walk.set(key, next);
    return next;
  }

  private simulate(at: Date): LiveSnapshot {
    const snap: LiveSnapshot = { at: at.toISOString(), source: 'demo', floors: {}, servicePoints: {} };
    for (const [id, kind, counts] of floors) {
      counts.forEach((n, i) => {
        const key = `${id}:${i + 1}`;
        snap.floors[key] = Math.round(n * this.factor(kind, at) * this.jitter(key));
      });
    }
    for (const [id, kind, queue, wait, status] of servicePoints) {
      const k = this.factor(kind, at) * this.jitter(id);
      const shift = k < 0.5 ? -2 : k < 0.8 ? -1 : k > 1.2 ? 1 : 0;
      snap.servicePoints[id] = {
        queue: Math.round(queue * k),
        waitMinutes: Math.round(wait * (0.4 + 0.6 * k)),
        status: levels[Math.max(0, Math.min(2, levels.indexOf(status) + shift))],
      };
    }
    return snap;
  }
}
