import assert from 'node:assert/strict';
import { test } from 'node:test';
import { etaOf, generatePatients, knownUntil, livePatients, opdClinics, patientAt, type LiveVisit } from '../lib/patients';
import { DEFAULT_SETTINGS, applyQueueEvents, basePatients, mergeSettings, priorityOf, stationQueue, stationById, type QueueEvent } from '../lib/queue';

const clinic = opdClinics()[0];
const visit = (o: Partial<LiveVisit> = {}): LiveVisit => ({ id: 'v-0001', queue: `${clinic.letter}001`, flow: 'opd', clinicKey: clinic.key, dept: clinic.dept, arrival: 480,
  steps: [{ kind: 'screening', at: 480 }, { kind: 'exam', at: 480 }], status: 'active', ...o });
let n = 0;
const ev = (e: Partial<QueueEvent>): QueueEvent => ({ id: `t-${++n}`, at: 480, station: 'x', action: 'call', patientId: 'v-0001', step: 0, ...e }) as QueueEvent;
const build = (visits: LiveVisit[], events: QueueEvent[]) => applyQueueEvents(livePatients(visits, events), events);
const screen = `screen:${clinic.key}`;

test('a real patient waits at their first step from arrival, with nothing predicted', () => {
  const [p] = build([visit()], []);
  assert.equal(p.live, true);
  assert.equal(p.hn, '', 'no HN in the queue system');
  const s = patientAt(p, 500)!;
  assert.equal(s.step.kind, 'screening');
  assert.equal(s.status, 'waiting');
  assert.equal(etaOf(s, 500), 0, 'no simulated time to promise');
  assert.equal(patientAt(p, 470), null, 'not here before arrival');
});

test('each step starts when staff finish the previous one; after the last ordered step the patient leaves', () => {
  const events = [ev({ station: screen, action: 'call', at: 490 }), ev({ station: screen, action: 'start', at: 491 }), ev({ station: screen, action: 'done', at: 496 })];
  const [p] = build([visit()], events);
  assert.equal(patientAt(p, 493)?.status, 'serving');
  const exam = patientAt(p, 497)!;
  assert.equal(exam.step.kind, 'exam');
  assert.equal(exam.step.start, 496);
  assert.equal(exam.status, 'waiting', 'waits for the exam room until called — never auto-served');
  assert.equal(patientAt(p, 900)?.step.kind, 'exam', 'still waiting hours later: no simulator finishes it');
  const room = `room:${clinic.rooms[0].id}`;
  const all = [...events, ev({ station: room, action: 'call', step: 1, at: 520 }), ev({ station: room, action: 'done', step: 1, at: 530 })];
  const [after] = build([visit()], all);
  assert.equal(patientAt(after, 532)?.step.kind, 'leave');
  assert.equal(patientAt(after, 545), null, 'gone home');
  // The doctor orders the pharmacy: the patient goes there instead of home.
  const [rx] = build([visit({ steps: [...visit().steps, { kind: 'pharmacy', at: 529 }] })], all);
  assert.equal(patientAt(rx, 545)?.step.kind, 'pharmacy');
  assert.equal(patientAt(rx, 545)?.step.start, 530);
});

test('real patients join the right station queue, with the priority set at registration', () => {
  const visits = [visit(), visit({ id: 'v-0002', queue: `${clinic.letter}002`, arrival: 481, priority: 'pregnant' })];
  const ps = build(visits, []);
  assert.deepEqual(priorityOf(ps[1]), { key: 'pregnant', label: 'หญิงตั้งครรภ์' });
  assert.equal(priorityOf(ps[0]), undefined, 'no guessed priority for real patients');
  const q = stationQueue(ps, stationById(screen)!, 490);
  assert.deepEqual(q.waiting.map((x) => x.s.p.queue).sort(), [`${clinic.letter}001`, `${clinic.letter}002`]);
});

test('cancelled visits disappear; ER visits start at triage', () => {
  const ps = build([visit({ status: 'cancelled' }), visit({ id: 'v-0002', queue: 'ER001', flow: 'er', clinicKey: undefined, dept: 'ห้องฉุกเฉิน', triage: 2, steps: [{ kind: 'triage', at: 480 }, { kind: 'treatment', at: 480 }] })], []);
  assert.deepEqual(ps.map((p) => p.queue), ['ER001']);
  assert.equal(patientAt(ps[0], 485)?.step.place.buildingId, 'er');
  assert.equal(ps[0].triage, 2);
});

test('the data mode picks the starting patients; demo stays the simulated day', () => {
  const demo = basePatients(DEFAULT_SETTINGS, [visit()], []);
  assert.equal(demo.length, generatePatients('demo-day').length);
  assert.ok(!demo.some((p) => p.live));
  const live = mergeSettings(DEFAULT_SETTINGS, { dataMode: 'live' });
  assert.equal(live.dataMode, 'live');
  assert.deepEqual(basePatients(live, [visit()], []).map((p) => p.id), ['v-0001']);
  assert.equal(mergeSettings(live, { dataMode: 'demo' }).dataMode, undefined, 'demo is the default, not stored');
});

test('every ordered step of a real patient counts as known (nothing is predicted for them)', () => {
  const [p] = build([visit({ steps: [...visit().steps, { kind: 'pharmacy', at: 480 }] })], []);
  assert.equal(knownUntil(p, 490), 2);
});

test("an appointment with the doctor's room waits for that room only, locked; without a room any room of the clinic", () => {
  if (clinic.rooms.length < 2) return; // needs two rooms to tell them apart
  const [mine, other] = clinic.rooms;
  const steps = [{ kind: 'exam' as const, at: 480 }];
  const ps = build([visit({ steps, examRoom: mine.id }), visit({ id: 'v-0002', queue: `${clinic.letter}002`, steps })], []);
  const waiting = (roomId: string) => stationQueue(ps, stationById(`room:${roomId}`)!, 500).waiting.map((e) => e.s.p.id);
  assert.deepEqual(waiting(mine.id), ['v-0001', 'v-0002']);
  assert.deepEqual(waiting(other.id), ['v-0002'], 'not offered to another doctor');
  const s = patientAt(ps[0], 500)!;
  assert.deepEqual([s.step.assigned, s.step.owner, s.step.locked], [`room:${mine.id}`, true, true]);
  // An unknown room code (layout changed) falls back to the clinic, so the patient is never stuck.
  const [lost] = build([visit({ steps, examRoom: 'opd-999' })], []);
  assert.equal(patientAt(lost, 500)!.step.assigned, undefined);
});
