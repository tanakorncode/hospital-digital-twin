import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { AuditService } from '../src/audit.service';
import { AuthService } from '../src/auth.service';
import { DbService } from '../src/db.service';
import { FeaturesService } from '../src/features.service';
import { IdempotencyService } from '../src/idempotency.service';
import { FlowGateway } from '../src/flow.gateway';
import { FlowService } from '../src/flow.service';
import { LiveFeedService } from '../src/live-feed.service';
import { QueueService } from '../src/queue.service';
import { TicketsService } from '../src/tickets.service';
import { LineService } from '../src/line.service';

Logger.overrideLogger(false); // keep test output clean

// A fresh in-memory API (no network, no files) for each test.
export const ADMIN_PASSWORD = 'test-admin-password';
export function makeApi() {
  process.env.DB_PATH = ':memory:';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  const db = new DbService();
  const auth = new AuthService(db);
  auth.onModuleInit();
  const queue = new QueueService(db), tickets = new TicketsService(db), line = new LineService(db, tickets);
  const audit = new AuditService(db), features = new FeaturesService(db), idempotency = new IdempotencyService(db);
  const gateway = new FlowGateway(new FlowService(), new LiveFeedService(), queue, auth, tickets, line, audit, features);
  const emitted: { event: string; data: unknown }[] = [];
  (gateway as unknown as { server: unknown }).server = { emit: (event: string, data: unknown) => emitted.push({ event, data }), to: () => ({ emit: () => undefined }) };
  return { db, auth, queue, tickets, line, audit, features, idempotency, gateway, emitted };
}
// A socket as the gateway sees it, optionally signed in with a session token.
export function fakeSocket(token = '') {
  const sent: { event: string; data: unknown }[] = [];
  return { handshake: { auth: { token }, headers: {}, address: '127.0.0.1' }, data: {} as Record<string, unknown>, emit: (event: string, data: unknown) => sent.push({ event, data }), join: () => undefined, sent } as never;
}
// Sign in through the gateway; returns a connected socket for that user.
export function signIn(api: ReturnType<typeof makeApi>, username: string, password: string) {
  const r = api.auth.login(username, password, 'test');
  if (!r.ok) throw new Error(r.reason);
  const s = fakeSocket(r.token);
  api.gateway.handleConnection(s);
  return s;
}
