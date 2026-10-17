import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { AuditService } from '../src/audit.service';
import { AppointmentService } from '../src/appointment.service';
import { AuthService } from '../src/auth.service';
import { BookingService } from '../src/booking.service';
import { CheckInService } from '../src/checkin.service';
import { DbService } from '../src/db.service';
import { FeaturesService } from '../src/features.service';
import { IdempotencyService } from '../src/idempotency.service';
import { FlowGateway } from '../src/flow.gateway';
import { FlowService } from '../src/flow.service';
import { LiveFeedService } from '../src/live-feed.service';
import { QueueService } from '../src/queue.service';
import { TicketsService } from '../src/tickets.service';
import { LineService } from '../src/line.service';
import { PatientIdentityService } from '../src/patient-identity.service';
import { PatientController } from '../src/patient.controller';
import { NotificationService } from '../src/notification.service';
import { WayfindingService } from '../src/wayfinding.service';
import { VisitsService } from '../src/visits.service';
import { RetentionService } from '../src/retention.service';
import { ReportService } from '../src/report.service';

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
  const visits = new VisitsService(db);
  const audit = new AuditService(db), features = new FeaturesService(db), idempotency = new IdempotencyService(db);
  const booking = new BookingService(db), appts = new AppointmentService(db), checkin = new CheckInService(db, booking, visits, appts), identity = new PatientIdentityService(db, booking);
  const notify = new NotificationService(db, features, identity, visits), wayfinding = new WayfindingService(db);
  const queue = new QueueService(db, visits), tickets = new TicketsService(db), line = new LineService(db, tickets, notify, wayfinding, features);
  const retention = new RetentionService(db, audit);
  const gateway = new FlowGateway(new FlowService(), new LiveFeedService(), queue, auth, tickets, line, audit, features, visits, idempotency, booking, checkin, appts, identity, notify, wayfinding, retention, new ReportService(db));
  // Broadcasts: `to` = only that room (staff), `except` = everyone else (public screens), neither = everyone.
  const emitted: { event: string; data: unknown; to?: string; except?: string }[] = [];
  // `sockets`: the connected screens (signIn adds its socket), so account changes can reach screens already open.
  const sockets = new Map<string, unknown>();
  (gateway as unknown as { server: unknown }).server = {
    sockets,
    emit: (event: string, data: unknown) => emitted.push({ event, data }),
    to: (room: string) => ({ emit: (event: string, data: unknown) => emitted.push({ event, data, to: room }) }),
    except: (room: string) => ({ emit: (event: string, data: unknown) => emitted.push({ event, data, except: room }) }),
  };
  return { db, auth, queue, tickets, line, audit, features, idempotency, visits, booking, appts, checkin, identity, notify, wayfinding, gateway, emitted, sockets, retention };
}
// A socket as the gateway sees it, optionally signed in with a session token.
export function fakeSocket(token = '') {
  const sent: { event: string; data: unknown }[] = [], rooms = new Set<string>();
  return { handshake: { auth: { token }, headers: {}, address: '127.0.0.1' }, data: {} as Record<string, unknown>, emit: (event: string, data: unknown) => sent.push({ event, data }), join: (r: string) => rooms.add(r), leave: (r: string) => rooms.delete(r), rooms, sent } as never;
}
// Sign in through the gateway; returns a connected socket for that user.
export function signIn(api: ReturnType<typeof makeApi>, username: string, password: string) {
  const r = api.auth.login(username, password, 'test');
  if (!r.ok) throw new Error(r.reason);
  const s = fakeSocket(r.token);
  api.gateway.handleConnection(s);
  api.sockets.set(`s${api.sockets.size}`, s);
  return s;
}
// The patient's REST controller (LINE pages) wired to a test API.
export const patientController = (api: ReturnType<typeof makeApi>) =>
  new PatientController(api.identity, api.features, api.audit, api.booking, api.appts, api.visits, api.tickets, api.idempotency, api.gateway, api.notify);
