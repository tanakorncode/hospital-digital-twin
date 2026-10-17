import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePatients, patientAt } from '../lib/patients';
import { DEFAULT_SETTINGS, allStations, applyQueueEvents, canDo, mergeSettings, priorityOf, queueAssist, stationQueue, type QueueEvent } from '../lib/queue';
import { deptScreen, nowStates, screenData } from '../lib/queue-screen';

const base = generatePatients('demo-day');
const M = 10 * 60;
const ev = (e: Partial<QueueEvent>): QueueEvent => ({ id: `t-${Math.random()}`, at: M, station: 'x', action: 'call', ...e }) as QueueEvent;
// someone waiting for an exam room at 10:00
const waitingAt = (m: number) => base.map((p) => patientAt(p, m)).find((s) => s && s.step.kind === 'exam' && m < s.step.called && s.step.stationId)!;

test('settings merge: overrides apply, null clears back to the hospital default', () => {
  const s1 = mergeSettings(DEFAULT_SETTINGS, { groups: { g1: { cap: 5, mode: 'auto' } }, stations: { st1: { cap: 3 } } });
  assert.equal(s1.groups.g1.cap, 5);
  const s2 = mergeSettings(s1, { groups: { g1: { cap: null } }, stations: { st1: null } });
  assert.deepEqual(s2.groups.g1, { mode: 'auto' });
  assert.equal(s2.stations.st1, undefined);
  assert.deepEqual(mergeSettings(s2, { layout: { off: ['room:opd-201'] } }).layout?.off, ['room:opd-201']);
});

test('a staff call shows the patient as being called, and "done" finishes the step', () => {
  const s = waitingAt(M), room = s.step.stationId!;
  const called = applyQueueEvents(base, [ev({ station: room, action: 'call', patientId: s.p.id, step: s.index, at: M })]);
  assert.equal(patientAt(called.find((p) => p.id === s.p.id)!, M + 0.5)?.status, 'calling');
  const done = applyQueueEvents(base, [
    ev({ station: room, action: 'call', patientId: s.p.id, step: s.index, at: M }),
    ev({ station: room, action: 'start', patientId: s.p.id, step: s.index, at: M + 1 }),
    ev({ station: room, action: 'done', patientId: s.p.id, step: s.index, at: M + 6 })]);
  const after = patientAt(done.find((p) => p.id === s.p.id)!, M + 7);
  assert.ok(!after || after.index > s.index, 'moved on to the next step');
});

test('the station queue lets a priority patient in after every N regular calls', () => {
  const st = allStations().find((x) => x.roomId && stationQueue(base, x, M).waiting.length >= 6 && stationQueue(base, x, M).waiting.some((w) => w.priority))!;
  assert.ok(st, 'a busy room with a priority patient waiting');
  const order = stationQueue(base, st, M, { enabled: true, every: 2 }).waiting;
  const first = order.findIndex((w) => w.priority);
  assert.ok(first <= 2, `priority patient at position ${first}`);
  const off = stationQueue(base, st, M, { enabled: false, every: 2 }).waiting;
  assert.deepEqual(off.map((w) => w.key), [...off.map((w) => w.key)].sort((a, b) => a - b), 'without the policy: first come, first served');
});

test('priority lanes come from the patient record', () => {
  const kinds = new Set(base.map(priorityOf).filter(Boolean).map((p) => p!.key));
  for (const k of ['elderly', 'wheelchair', 'monk', 'pregnant', 'disabled']) assert.ok(kinds.has(k as never), k);
});

test('the queue assistant only suggests moves inside the same group (no walking to another clinic)', () => {
  const settings = mergeSettings(DEFAULT_SETTINGS, { system: { cap: 3, imbalance: 2 } });
  const view = queueAssist(base, M, [], settings);
  assert.ok(view.suggestions.length > 0);
  for (const sg of view.suggestions) assert.equal(sg.from.group, sg.to.group);
});

test('public screens show queue numbers only and flag a call', () => {
  const s = waitingAt(M);
  const called = applyQueueEvents(base, [ev({ station: s.step.stationId!, action: 'call', patientId: s.p.id, step: s.index, at: M })]);
  const d = screenData(s.p.clinicKey ? Number(s.p.clinicKey.split('-')[1]) : 2, Number(s.p.clinicKey!.split('-')[2]), nowStates(called, M), M)!;
  assert.ok(d.rows.some((r) => r.queue === s.p.queue && r.calling));
  assert.ok(!JSON.stringify(d).includes(s.p.hn), 'no HN on a public screen');
  assert.equal(deptScreen('ไม่มีแผนกนี้', [], M), null);
});

test('roles: admin ⊃ supervisor ⊃ staff', () => {
  const u = (role: 'admin' | 'supervisor' | 'staff') => ({ id: 1, username: 'u', name: 'U', role, active: true });
  assert.ok(canDo(u('admin'), 'supervisor'));
  assert.ok(canDo(u('supervisor'), 'staff'));
  assert.ok(!canDo(u('staff'), 'supervisor'));
  assert.ok(!canDo(null, 'staff'));
});
