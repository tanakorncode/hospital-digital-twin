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

  onModuleInit() {
    if (process.env.DEMO_FEED === 'off') {
      this.log.log('Demo live feed disabled (DEMO_FEED=off)');
      return;
    }
    const every = Number(process.env.DEMO_FEED_MS ?? 3000);
    this.timer = setInterval(() => {
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
