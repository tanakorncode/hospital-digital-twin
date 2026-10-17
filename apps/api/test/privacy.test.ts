import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localInstant } from '../src/booking.service';
import { WayfindingController } from '../src/wayfinding.controller';
import { ADMIN_PASSWORD, fakeSocket, makeApi, patientController, signIn } from './helpers';

// Pilot gate: public screens (TV boards, patient pages, QR signs) and anything an unsigned socket receives carry no HN,
// no patient record ids, no LINE ids and no staff names — after a full day of real-patient activity.
const HN = '65-424242', LINE = `U${'7'.repeat(32)}`;

test('nothing identifying reaches an unsigned screen, a QR sign or the audit trail', async () => {
  const api = makeApi();
  const now = localInstant('2026-11-03', '08:30');
  api.booking.now = () => now; api.appts.now = () => now; api.notify.now = () => now;
  api.identity.verifyIdToken = async (t: string) => t;
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  api.gateway.setFeatures(admin, { patch: { accountLinking: true, generalBooking: true, appointments: true, notifications: true, wayfinding: true } });
  api.gateway.queueSettings(admin, { patch: { dataMode: 'live' }, at: 400, scope: 'system', summary: 'live' });
  // The TV board connects before anything happens and stays connected all day.
  const tv = fakeSocket();
  api.gateway.handleConnection(tv);
  // A linked patient books, checks in, is called and moved; a walk-in is taken in.
  const ctl = patientController(api);
  const auth = `Bearer ${(await ctl.session('1.1.1.1', { idToken: LINE })).token}`;
  api.gateway.confirmLink(admin, { code: ctl.startLink('1.1.1.1', auth).code, hn: HN });
  api.gateway.setBookingPolicy(admin, { serviceCode: 'opd-2-0', displayName: 'อายุรกรรม', enabled: true, queuePrefix: 'A' });
  api.gateway.createBookingSlots(admin, { serviceCode: 'opd-2-0', from: '2026-11-03', to: '2026-11-03', weekdays: [2], start: '09:00', end: '10:00', minutes: 60, capacity: 5 });
  const slot = api.booking.slots('opd-2-0', '2026-11-03')[0].id;
  const b = ctl.book('1.1.1.1', { slotId: slot }, auth, 'privacy-key-0001').booking;
  const v = (api.gateway.checkInCode(admin, { code: b.code, channel: 'KIOSK', at: 510 }) as { visit: { id: string } }).visit;
  api.gateway.queueCommand(admin, { at: 520, station: 'screen:opd-2-0', action: 'call', patientId: v.id, step: 0 });
  api.gateway.queueCommand(admin, { at: 521, station: 'screen:opd-2-0', action: 'transfer', patientId: v.id, step: 0, target: 'screen:opd-2-0:2' });
  api.gateway.enterVisit(admin, { flow: 'opd', clinicKey: 'opd-2-0', dept: 'อายุรกรรม', prefix: 'A', at: 522, key: 'privacy-key-0002' });
  api.gateway.wayfindingSave(admin, { code: 'OPD-PHARMACY', nameTh: 'ห้องยา', buildingId: 'opd', level: 1 });
  const late = fakeSocket();
  api.gateway.handleConnection(late);

  const profile = api.db.db.prepare('SELECT id FROM patient_profiles').get() as { id: string };
  const secrets = [HN, HN.slice(3), LINE, profile.id, 'ผู้ดูแลระบบ'];
  const leaks = (label: string, data: unknown) => { const s = JSON.stringify(data); for (const x of secrets) assert.ok(!s.includes(x), `${label} contains "${x}"`); };
  const sent = (s: unknown) => (s as { sent: unknown[] }).sent;
  leaks('TV board (connected all day)', sent(tv));
  leaks('a screen connecting later', sent(late));
  leaks('broadcasts to everyone', api.emitted.filter((e) => e.to !== 'staff'));
  const way = new WayfindingController(api.wayfinding, api.features);
  leaks('QR sign data', [way.destinations('1.1.1.1'), way.destination('1.1.1.1', 'OPD-PHARMACY')]);
  leaks('patient page link check', api.tickets.check(api.tickets.issue(v.id, 'x').token));
  // The audit trail names staff by id and patients by an opaque reference — never the HN or the LINE id.
  const trail = JSON.stringify(api.audit.list({ limit: 500 }));
  for (const x of [HN, HN.slice(3), LINE]) assert.ok(!trail.includes(x), `audit contains ${x}`);
  // The patient's own app sees only the last 4 digits of their own HN.
  assert.equal((ctl.me('1.1.1.1', auth) as { hn: string }).hn, '••4242');
  // Staff screens do get the full log (names of who did what) — only through the staff room.
  assert.ok(api.emitted.some((e) => e.to === 'staff' && JSON.stringify(e.data).includes('ผู้ดูแลระบบ')));
});
