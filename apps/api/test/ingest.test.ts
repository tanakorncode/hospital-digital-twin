import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IngestController } from '../src/ingest.controller';
import { LiveFeedService } from '../src/live-feed.service';
import { makeApi } from './helpers';

const TOKEN = 'test-ingest-token-0123456789';
function setup() {
  const api = makeApi(), live = new LiveFeedService();
  const ctl = new IngestController(live, api.queue, api.gateway);
  return { api, live, ctl };
}
const status = (fn: () => unknown) => { try { fn(); return 200; } catch (e) { return (e as { getStatus: () => number }).getStatus(); } };

test('ingestion is off without INGEST_TOKEN and refuses a wrong token', () => {
  const { ctl } = setup();
  delete process.env.INGEST_TOKEN;
  assert.equal(status(() => ctl.live(`Bearer ${TOKEN}`, {})), 503);
  process.env.INGEST_TOKEN = TOKEN;
  assert.equal(status(() => ctl.live('Bearer wrong', {})), 401);
  assert.equal(status(() => ctl.live(undefined, {})), 401);
});

test('a live snapshot from the HIS replaces the demo values and is marked as HIS', () => {
  process.env.INGEST_TOKEN = TOKEN;
  const { ctl, live } = setup();
  const seen: unknown[] = []; live.subscribe((s) => seen.push(s));
  ctl.live(`Bearer ${TOKEN}`, { at: new Date().toISOString(), floors: { 'opd:2': 180 }, servicePoints: { pharmacy: { queue: 40, waitMinutes: 22, status: 'busy' } } });
  const snap = live.snapshot();
  assert.equal(snap.source, 'his-adapter');
  assert.equal(snap.floors['opd:2'], 180);
  assert.equal(snap.servicePoints.pharmacy.queue, 40);
  assert.equal(seen.length, 1, 'pushed to every screen');
});

test('malformed or stale snapshots are refused', () => {
  process.env.INGEST_TOKEN = TOKEN;
  const { ctl } = setup();
  assert.equal(status(() => ctl.live(`Bearer ${TOKEN}`, { floors: { 'opd:2': -5 } })), 400);
  assert.equal(status(() => ctl.live(`Bearer ${TOKEN}`, { servicePoints: { lab: { queue: 3, waitMinutes: 2, status: 'panic' } } })), 400);
  assert.equal(status(() => ctl.live(`Bearer ${TOKEN}`, { at: '2020-01-01T00:00:00Z' })), 400);
});

test('queue actions from the HIS are logged as "HIS" and broadcast; patient help requests are not accepted here', () => {
  process.env.INGEST_TOKEN = TOKEN;
  const { ctl, api } = setup();
  const r = ctl.queueEvent(`Bearer ${TOKEN}`, { at: 600, station: 'counter:registration:1', action: 'done', patientId: 'p-0001', step: 1 });
  assert.ok(r.ok);
  assert.equal(api.queue.list().at(-1)!.by, 'HIS');
  assert.ok(api.emitted.some((e) => e.event === 'queue:event'));
  assert.equal(status(() => ctl.queueEvent(`Bearer ${TOKEN}`, { at: 600, station: 'x', action: 'report', patientId: 'p-0001', step: 1 })), 400);
});
