import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN_PASSWORD, fakeSocket, makeApi, signIn } from './helpers';

type T = { ok: boolean; reason?: string; ticket?: { token: string; patientId: string; kind: string; expiresAt: string } };
const report = { at: 600, station: 'room:opd-201', action: 'report' as const, patientId: 'p-0010', step: 3, reason: 'ต้องการรถเข็น / ผู้ช่วย' };

test('only signed-in staff can issue a patient link; it is random and stable until re-issued', () => {
  const api = makeApi();
  assert.equal((api.gateway.issueTicket(fakeSocket(), { patientId: 'p-0010' }) as T).ok, false);
  const admin = signIn(api, 'admin', ADMIN_PASSWORD);
  const a = api.gateway.issueTicket(admin, { patientId: 'p-0010' }) as T, b = api.gateway.issueTicket(admin, { patientId: 'p-0010' }) as T;
  assert.equal(a.ticket!.token.length, 22);
  assert.equal(a.ticket!.token, b.ticket!.token);
  assert.notEqual(a.ticket!.token, (api.gateway.issueTicket(admin, { patientId: 'p-0011' }) as T).ticket!.token);
  assert.equal(new Date(a.ticket!.expiresAt).getHours(), 23, 'valid until the end of the day');
});

test('links resolve to their patient; guesses and old-style links do not', () => {
  const api = makeApi();
  const t = api.tickets.issue('p-0010', 'test');
  assert.equal((api.gateway.resolveTicket({ token: t.token }) as T).ticket?.patientId, 'p-0010');
  assert.equal((api.gateway.resolveTicket({ token: 'A'.repeat(22) }) as T).ok, false);
  assert.equal((api.gateway.resolveTicket({ token: '1se4cp2' }) as T).ok, false);
});

test('family links are separate, read-only and cannot be re-shared', () => {
  const api = makeApi();
  const t = api.tickets.issue('p-0010', 'test');
  const fam = api.gateway.familyTicket({ token: t.token }) as T;
  assert.equal(fam.ticket!.kind, 'family');
  assert.notEqual(fam.ticket!.token, t.token);
  assert.ok(fam.ticket!.expiresAt <= t.expiresAt, 'never outlives the patient link');
  assert.equal((api.gateway.familyTicket({ token: fam.ticket!.token }) as T).ok, false);
});

test('a help request must come from the patient’s own link', () => {
  const api = makeApi();
  const t = api.tickets.issue('p-0010', 'test'), fam = api.tickets.family(t.token);
  assert.ok(fam.ok);
  const pub = fakeSocket();
  assert.equal((api.gateway.queueCommand(pub, report) as T).ok, false, 'no link');
  assert.equal((api.gateway.queueCommand(pub, { ...report, ticket: fam.ticket.token } as never) as T).ok, false, 'family link');
  assert.equal((api.gateway.queueCommand(pub, { ...report, patientId: 'p-0011', ticket: t.token } as never) as T).ok, false, 'someone else');
  assert.equal((api.gateway.queueCommand(pub, { ...report, ticket: t.token } as never) as T).ok, true);
  assert.ok(!JSON.stringify(api.queue.list()).includes(t.token), 'the link is not written to the log');
});

test('re-issuing a slip stops the old link and its family links', () => {
  const api = makeApi();
  const t1 = api.tickets.issue('p-0010', 'test'), fam = api.tickets.family(t1.token);
  assert.ok(fam.ok);
  const t2 = api.tickets.issue('p-0010', 'test', true);
  assert.notEqual(t2.token, t1.token);
  assert.equal(api.tickets.check(t1.token).ok, false);
  assert.equal(api.tickets.check(fam.ticket.token).ok, false);
  assert.ok(api.tickets.check(t2.token).ok);
});

test('expired links are refused', () => {
  const api = makeApi();
  const t = api.tickets.issue('p-0010', 'test');
  api.db.db.prepare('UPDATE tickets SET expires_at = ? WHERE token = ?').run(new Date(Date.now() - 1000).toISOString(), t.token);
  const r = api.tickets.check(t.token);
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'expired');
});
