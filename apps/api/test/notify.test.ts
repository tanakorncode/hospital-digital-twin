import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { localInstant } from '../src/booking.service';
import { render } from '../src/notification.service';
import { ADMIN_PASSWORD, makeApi, patientController, signIn } from './helpers';

// LINE answers by queue: each push takes the next status (default 200). Accepted pushes are recorded.
type Push = { to: string; text: string; retryKey: string };
let pushes: Push[] = [], answers: (number | 'down')[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'token';
  pushes = []; answers = [];
  globalThis.fetch = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const a = answers.shift() ?? 200;
    if (a === 'down') throw new Error('network down');
    if (String(url).endsWith('/push') && a < 300) { const b = JSON.parse(init.body); pushes.push({ to: b.to, text: b.messages[0].text, retryKey: init.headers['x-line-retry-key'] }); }
    return new Response('{}', { status: a });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; delete process.env.LINE_CHANNEL_ACCESS_TOKEN; });

const U1 = `U${'d'.repeat(32)}`;
const MED = 'opd-2-0';
// Background sends finish in their own time: wait for the outcome (up to 3 s) instead of a fixed sleep.
const waitFor = async (ok: () => boolean) => { for (let i = 0; i < 150 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); };
let n = 0;
const key = () => `nt-key-${String(++n).padStart(6, '0')}`;
type Job = { template: string; status: string; attempt_count: number; scheduled_at: string; last_error: string | null; dedupe_key: string; id: string };

// Monday 2 Nov 2026 10:00; patient 65-1 linked to LINE user U1; all switches on.
async function setup(opts: { notifications?: boolean; link?: boolean } = {}) {
  const api = makeApi();
  const setNow = (d: Date) => { api.booking.now = () => d; api.appts.now = () => d; api.notify.now = () => d; };
  setNow(localInstant('2026-11-02', '10:00'));
  api.identity.verifyIdToken = async (t: string) => t;
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  api.gateway.setFeatures(admin, { patch: { accountLinking: true, generalBooking: true, appointments: true, notifications: opts.notifications ?? true } });
  api.gateway.setBookingPolicy(admin, { serviceCode: MED, displayName: 'จิตเวช', enabled: true, queuePrefix: 'A', maxActivePerPatient: 3 });
  api.gateway.createBookingSlots(admin, { serviceCode: MED, from: '2026-11-03', to: '2026-11-04', weekdays: [2, 3], start: '09:00', end: '11:00', minutes: 60, capacity: 3 });
  api.gateway.setApptPolicy(admin, { clinicCode: MED, displayName: 'จิตเวช', enabled: true, queuePrefix: 'A' });
  api.gateway.createApptSessions(admin, { clinicCode: MED, providerCode: 'D001', providerName: 'นพ.สมชาย', from: '2026-11-04', to: '2026-11-06', weekdays: [3, 4, 5], start: '09:00', end: '10:00', minutes: 30, capacity: 2 });
  const ctl = patientController(api);
  if (opts.link !== false) {
    const auth = `Bearer ${(await ctl.session('1.1.1.1', { idToken: U1 })).token}`;
    api.gateway.confirmLink(admin, { code: ctl.startLink('1.1.1.1', auth).code, hn: '65-123456' });
  }
  const jobs = () => api.db.db.prepare('SELECT * FROM notification_jobs ORDER BY created_at, rowid').all() as Job[];
  const slot = (date: string, time: string) => api.booking.slots(MED, date).find((s) => s.startsAt === localInstant(date, time).toISOString())!.id;
  const apptSlot = (date: string, time: string) => api.appts.slots(MED, date).find((s) => s.startsAt === localInstant(date, time).toISOString())!.id;
  return { api, admin, ctl, setNow, jobs, slot, apptSlot };
}

test('a booking made at the counter sends the patient a confirmation — date, time and code only', async () => {
  const { api, admin, jobs, slot } = await setup();
  const b = (api.gateway.createBooking(admin, { hn: '65-123456', slotId: slot('2026-11-03', '09:00'), key: key() }) as { booking: { code: string } }).booking;
  assert.deepEqual(jobs().map((j) => [j.template, j.status]), [['BOOKING_CONFIRMED', 'PENDING']]);
  await api.notify.process();
  assert.equal(jobs()[0].status, 'SENT');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].to, U1);
  assert.match(pushes[0].text, new RegExp(`พรุ่งนี้ เวลา 09:00 น\\.[\\s\\S]*${b.code}`));
  assert.ok(!/123456|จิตเวช|สมชาย/.test(pushes[0].text), 'no HN, no clinic (it can reveal a condition), no doctor');
});

test('nothing is queued while messages are switched off; nobody to send to → skipped, not retried', async () => {
  const off = await setup({ notifications: false });
  off.api.gateway.createBooking(off.admin, { hn: '65-123456', slotId: off.slot('2026-11-03', '09:00'), key: key() });
  assert.equal(off.jobs().length, 0);
  const unlinked = await setup({ link: false });
  unlinked.api.gateway.createBooking(unlinked.admin, { hn: '65-9', slotId: unlinked.slot('2026-11-03', '09:00'), key: key() });
  await unlinked.api.notify.process();
  assert.deepEqual(unlinked.jobs().map((j) => [j.status, j.last_error]), [['SKIPPED', 'NO_LINKED_LINE']]);
  assert.equal(pushes.length, 0);
});

test('LINE not set up yet: messages are skipped (visible to administrators), the booking is unaffected', async () => {
  const { api, admin, jobs, slot } = await setup();
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const r = api.gateway.createBooking(admin, { hn: '65-123456', slotId: slot('2026-11-03', '09:00'), key: key() }) as { ok: boolean };
  await api.notify.process();
  assert.equal(r.ok, true);
  assert.equal(jobs()[0].last_error, 'LINE_NOT_CONFIGURED');
  const view = api.gateway.notifyJobs(admin, {}) as { counts: Record<string, number>; jobs: Record<string, unknown>[]; line: boolean };
  assert.equal(view.line, false);
  assert.equal(view.counts.SKIPPED, 1);
  assert.ok(!JSON.stringify(view).includes(U1), 'administrators never see LINE ids');
});

test('busy or down: retried later with the same retry key; a rejected message fails and can be sent again', async () => {
  const { api, admin, jobs, slot, setNow } = await setup();
  api.gateway.createBooking(admin, { hn: '65-123456', slotId: slot('2026-11-03', '09:00'), key: key() });
  answers = [500];
  await api.notify.process();
  let j = jobs()[0];
  assert.deepEqual([j.status, j.attempt_count], ['RETRY', 1]);
  assert.ok(new Date(j.scheduled_at) > localInstant('2026-11-02', '10:00'), 'not straight away');
  await api.notify.process();
  assert.equal(pushes.length, 0, 'waits for its time');
  setNow(localInstant('2026-11-02', '10:05'));
  answers = ['down'];
  await api.notify.process();
  assert.deepEqual([jobs()[0].status, jobs()[0].attempt_count], ['RETRY', 2]);
  setNow(localInstant('2026-11-02', '11:00'));
  await api.notify.process();
  assert.equal(jobs()[0].status, 'SENT');
  answers = [];
  // A permanent refusal (e.g. the patient blocked the OA): failed, kept for an administrator.
  api.gateway.createBooking(admin, { hn: '65-123456', slotId: slot('2026-11-04', '09:00'), key: key() });
  answers = [400];
  await api.notify.process();
  j = jobs().find((x) => x.status === 'FAILED')!;
  assert.ok(j);
  assert.equal((api.gateway.notifyRetry(admin, { id: j.id }) as { ok: boolean }).ok, true);
  await waitFor(() => jobs().find((x) => x.id === j.id)!.status === 'SENT');
  assert.equal(jobs().find((x) => x.id === j.id)!.status, 'SENT');
  assert.equal((api.gateway.notifyRetry(admin, { id: j.id }) as { ok: boolean }).ok, false, 'only failed ones');
});

test('a retried send uses the same LINE retry key, so the patient never gets it twice', async () => {
  const { api, admin, slot, setNow } = await setup();
  api.gateway.createBooking(admin, { hn: '65-123456', slotId: slot('2026-11-03', '09:00'), key: key() });
  answers = [503];
  await api.notify.process();
  const keys: string[] = [];
  globalThis.fetch = (async (_u: string, init: { headers: Record<string, string> }) => { keys.push(init.headers['x-line-retry-key']); return new Response('{}', { status: 409 }); }) as typeof fetch;
  setNow(localInstant('2026-11-02', '12:00'));
  await api.notify.process();
  assert.match(keys[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(api.db.db.prepare("SELECT status FROM notification_jobs").get()!.status, 'SENT', '409 = LINE already has it');
});

test('appointments: confirmation now, a reminder at 18:00 the day before; moving or cancelling replaces or removes it', async () => {
  const { api, admin, jobs, apptSlot } = await setup();
  const a = (api.gateway.createAppt(admin, { hn: '65-123456', slotId: apptSlot('2026-11-05', '09:00'), key: key() }) as { appointment: { id: string; code: string } }).appointment;
  const remind = () => jobs().filter((j) => j.template === 'APPT_REMINDER');
  assert.deepEqual(jobs().map((j) => j.template), ['APPT_CONFIRMED', 'APPT_REMINDER']);
  assert.equal(remind()[0].scheduled_at, localInstant('2026-11-04', '18:00').toISOString());
  api.gateway.rescheduleAppt(admin, { appointmentId: a.id, slotId: apptSlot('2026-11-06', '09:30'), key: key() });
  assert.deepEqual(remind().map((j) => [j.status, j.scheduled_at]), [['CANCELLED', localInstant('2026-11-04', '18:00').toISOString()], ['PENDING', localInstant('2026-11-05', '18:00').toISOString()]]);
  assert.ok(jobs().some((j) => j.template === 'APPT_RESCHEDULED'));
  api.gateway.cancelAppt(admin, { appointmentId: a.id, reason: 'แพทย์ติดประชุม' });
  assert.ok(remind().every((j) => j.status === 'CANCELLED'), 'no reminder for a cancelled appointment');
  assert.ok(jobs().some((j) => j.template === 'APPT_CANCELLED' && j.status === 'PENDING'));
});

test('patients who change their own appointment get no "it changed" message, only the new reminder', async () => {
  const { api, admin, ctl, jobs, apptSlot } = await setup();
  await api.notify.process(); // clear the link-time jobs (none)
  const a = (api.gateway.createAppt(admin, { hn: '65-123456', slotId: apptSlot('2026-11-05', '09:00'), key: key() }) as { appointment: { id: string } }).appointment;
  api.gateway.setApptPolicy(admin, { clinicCode: MED, rescheduleNeedsApproval: false });
  const auth = `Bearer ${(await ctl.session('1.1.1.1', { idToken: U1 })).token}`;
  ctl.rescheduleAppointment('1.1.1.1', a.id, { slotId: apptSlot('2026-11-06', '09:00') }, auth);
  assert.ok(!jobs().some((j) => j.template === 'APPT_RESCHEDULED'));
  assert.equal(jobs().filter((j) => j.template === 'APPT_REMINDER' && j.status === 'PENDING').length, 1);
});

test('a rejected move request is explained; the same event never makes two messages', async () => {
  const { api, admin, jobs, apptSlot } = await setup();
  const a = (api.gateway.createAppt(admin, { hn: '65-123456', slotId: apptSlot('2026-11-05', '09:00'), key: key() }) as { appointment: { id: string } }).appointment;
  const req = api.appts.requestReschedule(a.id, apptSlot('2026-11-06', '09:00'), '', { kind: 'staff', id: 1, canOverride: false }).request!;
  api.gateway.decideAppt(admin, { requestId: req.id, approve: false, note: 'วันนั้นแพทย์ไม่ออกตรวจ' });
  api.gateway.decideAppt(admin, { requestId: req.id, approve: false, note: 'ซ้ำ' });
  assert.equal(jobs().filter((j) => j.template === 'APPT_RESCHEDULE_REJECTED').length, 1);
  assert.match(render('APPT_RESCHEDULE_REJECTED', { at: localInstant('2026-11-05', '09:00').toISOString(), note: 'วันนั้นแพทย์ไม่ออกตรวจ' }, localInstant('2026-11-02', '10:00')),
    /ไม่ได้รับการอนุมัติ\nวันนั้นแพทย์ไม่ออกตรวจ\nนัดเดิม วันพฤหัสบดีที่ 5 พฤศจิกายน เวลา 09:00 น\. ยังคงเดิม/);
});

test('a linked patient hears about check-in and being called without the slip code', async () => {
  const { api, admin, jobs, slot, setNow } = await setup();
  api.gateway.queueSettings(admin, { patch: { dataMode: 'live' }, at: 400, scope: 'system', summary: 'live' });
  const b = (api.gateway.createBooking(admin, { hn: '65-123456', slotId: slot('2026-11-03', '09:00'), key: key() }) as { booking: { code: string } }).booking;
  setNow(localInstant('2026-11-03', '08:30'));
  const v = (api.gateway.checkInCode(admin, { code: b.code, channel: 'COUNTER', at: 510 }) as { visit: { id: string; queue: string } }).visit;
  api.gateway.queueCommand(admin, { at: 520, station: 'screen:opd-2-0', action: 'call', patientId: v.id, step: 0 });
  assert.deepEqual(jobs().map((j) => j.template), ['BOOKING_CONFIRMED', 'CHECKIN_DONE', 'QUEUE_CALL']);
  await api.notify.process();
  assert.match(pushes.at(-1)!.text, new RegExp(`ถึงคิว ${v.queue} แล้ว\\nเชิญที่ จุดซักประวัติ ชั้น 2`));
});

test('a job half-sent when the API stopped goes back to the queue on start', async () => {
  const { api, admin, jobs, slot } = await setup();
  api.gateway.createBooking(admin, { hn: '65-123456', slotId: slot('2026-11-03', '09:00'), key: key() });
  api.db.db.prepare("UPDATE notification_jobs SET status = 'PROCESSING'").run();
  api.notify.onModuleInit(); api.notify.onModuleDestroy();
  assert.equal(jobs()[0].status, 'RETRY');
});
