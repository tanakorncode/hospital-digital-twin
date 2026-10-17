// Counters since the API started (spec §15.1): refused requests by error code, retried requests answered from the
// first result, rate-limit hits, LINE webhooks with a bad signature, and HTTP latency. Labels are operation names and
// error codes only — never anything about a patient. In memory: they restart at zero with the API (the database
// report in report.service.ts covers what must last).
const RECENT = 1000;

class Metrics {
  since = new Date().toISOString();
  private counts = new Map<string, number>();
  private latency: number[] = []; // the last RECENT HTTP requests, ms
  private http = { total: 0, errors: 0 };

  inc(name: string, n = 1) { this.counts.set(name, (this.counts.get(name) ?? 0) + n); }
  // A request refused with { ok:false, code }: from a staff screen (socket) or a patient page / public endpoint (REST).
  refused(channel: 'socket' | 'rest', code: string) { this.inc(`refused.${channel}.${code}`); }
  request(ms: number, status: number) {
    this.http.total++;
    if (status >= 500) this.http.errors++;
    this.latency.push(ms);
    if (this.latency.length > RECENT) this.latency.shift();
  }
  snapshot() {
    const sorted = [...this.latency].sort((a, b) => a - b), at = (q: number) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]) : 0;
    return { since: this.since, counters: Object.fromEntries([...this.counts].sort(([a], [b]) => a.localeCompare(b))),
      http: { total: this.http.total, serverErrors: this.http.errors, p50: at(0.5), p95: at(0.95), sample: sorted.length } };
  }
  reset() { this.counts.clear(); this.latency = []; this.http = { total: 0, errors: 0 }; this.since = new Date().toISOString(); }
}
export const metrics = new Metrics();
