import { OnModuleDestroy } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthService, type Role, type User } from './auth.service';
import { allowOrigin } from './cors';
import { FlowService, FlowUpdate } from './flow.service';
import { LiveFeedService } from './live-feed.service';
import { QueueService, type QueueCommand, type QueueEvent, type SettingsCommand } from './queue.service';
import { TicketsService } from './tickets.service';
import { LineService } from './line.service';
import { AuditService } from './audit.service';
import { AppError, fail } from './errors';
import { BookingService } from './booking.service';
import { FeaturesService } from './features.service';
import { IdempotencyService } from './idempotency.service';
import { VisitsService, type EnterInput } from './visits.service';

// Who may do what. Public screens (TV boards, the patient's QR page) connect without signing in: they receive the
// queue log, may look up a patient link ('ticket:resolve'), make a family link from a patient link, and send the
// patient's help request ('report') — which must carry that patient's own valid link.
//  staff       — station actions (call, start, done, hold, move…), take on help requests
//  supervisor  — + per-department / per-station assistant settings
//  admin       — + hospital-wide settings, service hours, layout, test clock, user accounts, Phase 2 switches, audit trail
const SYSTEM_BY = 'ระบบ';
const rank: Record<Role, number> = { staff: 1, supervisor: 2, admin: 3 };
const may = (u: User | null, role: Role) => !!u && rank[u.role] >= rank[role];
const userOf = (c: Socket) => (c.data.user ?? null) as User | null;
const DENIED = fail('FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้');
// Per-connection limits (sliding window): staff consoles act often; public screens only look things up.
const LIMITS = { command: [120, 10_000], public: [20, 60_000], login: [10, 60_000] } as const;
const SLOW = fail('RATE_LIMITED', 'ทำรายการถี่เกินไป กรุณารอสักครู่');
function overLimit(c: Socket, kind: keyof typeof LIMITS) {
  const [max, windowMs] = LIMITS[kind], now = Date.now();
  const hits = ((c.data[`rl:${kind}`] as number[] | undefined) ?? []).filter((t) => now - t < windowMs);
  hits.push(now); c.data[`rl:${kind}`] = hits;
  return hits.length > max;
}
const SIGN_IN = { ...fail('AUTH_REQUIRED', 'กรุณาเข้าสู่ระบบก่อน'), auth: true };
const actor = (u: User) => ({ actorType: 'staff' as const, actorId: `user:${u.id}` });
// Signed-in staff sockets share this room. Everyone else (TV boards, patient pages, anyone who opens a socket) gets the
// queue log without staff names — screens for the public only need numbers, places and states.
const STAFF_ROOM = 'staff';
export const publicEvent = ({ by: _by, ...e }: QueueEvent): QueueEvent => e;
// Service errors (AppError) become the usual { ok:false, code, reason } reply.
function attempt<T>(fn: () => T) {
  try { return fn(); } catch (err) { if (err instanceof AppError) return err.toJSON(); throw err; }
}

@WebSocketGateway({ namespace: '/hospital', cors: { origin: allowOrigin } })
export class FlowGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private unsubscribe?: () => void;
  constructor(private readonly flowService: FlowService, private readonly liveFeed: LiveFeedService, private readonly queue: QueueService, private readonly auth: AuthService, private readonly tickets: TicketsService, private readonly line: LineService, private readonly audit: AuditService, private readonly features: FeaturesService, private readonly visits: VisitsService, private readonly idempotency: IdempotencyService, private readonly booking: BookingService) {}
  // Every connected dashboard receives each live snapshot ('live:update').
  afterInit() {
    this.unsubscribe = this.liveFeed.subscribe((snap) => this.server.emit('live:update', snap));
  }
  onModuleDestroy() {
    this.unsubscribe?.();
  }
  handleConnection(client: Socket) {
    // The session token travels in the socket handshake (works over WebSocket and over the polling relay).
    const user = this.auth.resolve(client.handshake.auth?.token);
    client.data.user = user;
    if (user) void client.join(STAFF_ROOM);
    client.emit('auth:me', user);
    client.emit('features', this.featureList());
    client.emit('flow:snapshot', this.flowService.snapshot());
    client.emit('live:snapshot', this.liveFeed.snapshot());
    this.sendLog(client);
    client.emit('queue:settings', this.queue.getSettings());
    client.emit('visits', this.visits.list());
  }
  private sendLog(client: Socket) {
    const list = this.queue.list();
    client.emit('queue:events', userOf(client) ? list : list.map(publicEvent));
  }
  // One accepted queue action to every screen: in full to staff, without names to the rest.
  publishQueueEvent(e: QueueEvent) {
    this.server.to(STAFF_ROOM).emit('queue:event', e);
    this.server.except(STAFF_ROOM).emit('queue:event', publicEvent(e));
    void this.line.onQueueEvent(e);
  }
  private publishLog() {
    const list = this.queue.list();
    this.server.to(STAFF_ROOM).emit('queue:events', list);
    this.server.except(STAFF_ROOM).emit('queue:events', list.map(publicEvent));
  }

  // ---- sign-in -----------------------------------------------------------------------------------------------
  @SubscribeMessage('auth:login')
  login(@ConnectedSocket() client: Socket, @MessageBody() body: { username?: string; password?: string }) {
    if (overLimit(client, 'login')) return SLOW;
    const from = String(client.handshake.headers['x-forwarded-for'] ?? client.handshake.address ?? '');
    const res = this.auth.login(body?.username ?? '', body?.password ?? '', from);
    if (!res.ok) return res;
    client.data.user = res.user;
    void client.join(STAFF_ROOM);
    this.sendLog(client); // now with the names the public stream leaves out
    return res;
  }
  @SubscribeMessage('auth:logout')
  logout(@ConnectedSocket() client: Socket) {
    this.auth.logout(client.handshake.auth?.token);
    client.data.user = null;
    void client.leave(STAFF_ROOM);
    return { ok: true };
  }
  @SubscribeMessage('users:list')
  users(@ConnectedSocket() client: Socket) {
    return may(userOf(client), 'admin') ? { ok: true, users: this.auth.list() } : DENIED;
  }
  @SubscribeMessage('users:save')
  saveUser(@ConnectedSocket() client: Socket, @MessageBody() body: Parameters<AuthService['save']>[0]) {
    const me = userOf(client);
    if (!may(me, 'admin')) return DENIED;
    const res = this.auth.save(body ?? {}, me!);
    if (!res.ok) return res;
    const b = body ?? {};
    this.audit.record({ ...actor(me!), action: b.id ? 'user.update' : 'user.create', targetType: 'user', targetId: String(res.user.id),
      meta: { role: res.user.role, active: res.user.active, signInReset: !!(b.id && b.password) } });
    return { ok: true, user: res.user, users: this.auth.list() };
  }

  // ---- Phase 2 switches and the audit trail (administrators) ------------------------------------------------------
  private featureList() {
    return { line: this.line.enabled, phase2: this.features.get() };
  }
  @SubscribeMessage('features:set')
  setFeatures(@ConnectedSocket() client: Socket, @MessageBody() body: { patch?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    const res = this.features.set(body?.patch);
    if (!res.ok) return fail('VALIDATION_ERROR', res.reason);
    for (const [flag, on] of Object.entries(res.changed)) this.audit.record({ ...actor(me), action: on ? 'feature.enable' : 'feature.disable', targetType: 'feature', targetId: flag });
    this.server.emit('features', this.featureList());
    return { ok: true, flags: res.flags };
  }
  @SubscribeMessage('audit:list')
  auditList(@ConnectedSocket() client: Socket, @MessageBody() body: { targetType?: string; targetId?: string; limit?: number }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return { ok: true, entries: this.audit.list({ targetType: typeof body?.targetType === 'string' ? body.targetType : undefined, targetId: typeof body?.targetId === 'string' ? body.targetId : undefined, limit: Number(body?.limit) || undefined }) };
  }

  // ---- patient links (/q/<token>) ------------------------------------------------------------------------------
  @SubscribeMessage('ticket:issue')
  issueTicket(@ConnectedSocket() client: Socket, @MessageBody() body: { patientId?: string; renew?: boolean }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'staff')) return DENIED;
    if (typeof body?.patientId !== 'string' || !/^[a-z]-\d{1,6}$/i.test(body.patientId)) return { ok: false, reason: 'ไม่ได้ระบุผู้ป่วย' };
    const ticket = this.tickets.issue(body.patientId, me.name, !!body.renew);
    // Re-issuing cancels the patient's earlier links: record who did it (an ordinary re-show of the same QR is not logged).
    if (body.renew) this.audit.record({ ...actor(me), action: 'ticket.renew', targetType: 'patient', targetId: body.patientId });
    return { ok: true, ticket };
  }
  @SubscribeMessage('ticket:resolve')
  resolveTicket(@ConnectedSocket() client: Socket, @MessageBody() body: { token?: string }) {
    if (overLimit(client, 'public')) return SLOW;
    return this.tickets.check(body?.token);
  }
  @SubscribeMessage('ticket:family')
  familyTicket(@ConnectedSocket() client: Socket, @MessageBody() body: { token?: string; hours?: number }) {
    if (overLimit(client, 'public')) return SLOW;
    return this.tickets.family(body?.token ?? '', Number(body?.hours ?? 12));
  }

  // The patient asks for LINE notifications from their own page (a code to send to the hospital's OA).
  @SubscribeMessage('line:link')
  lineLink(@ConnectedSocket() client: Socket, @MessageBody() body: { token?: string; queue?: string }) {
    if (overLimit(client, 'public')) return SLOW;
    return this.line.startLink(body?.token ?? '', body?.queue ?? '');
  }

  @SubscribeMessage('flow:subscribe')
  subscribe(@ConnectedSocket() client: Socket, @MessageBody() body: { floorId?: string }) {
    client.join(body?.floorId ? `floor:${body.floorId}` : 'campus');
    return { success: true };
  }

  // Queue actions. Every accepted action is broadcast so all consoles, wall TVs and patient pages update.
  @SubscribeMessage('queue:command')
  queueCommand(@ConnectedSocket() client: Socket, @MessageBody() cmd: QueueCommand) {
    const me = userOf(client);
    if (overLimit(client, me ? 'command' : 'public')) return SLOW;
    if (cmd?.action === 'report') { // a patient's help request: no account, but it must come from that patient's own link
      const t = this.tickets.check((cmd as QueueCommand & { ticket?: string }).ticket);
      if (!t.ok) return { ok: false, reason: t.reason };
      if (t.ticket.kind !== 'patient' || t.ticket.patientId !== cmd.patientId) return { ok: false, reason: 'ลิงก์นี้ส่งเรื่องแทนผู้ป่วยไม่ได้' };
    }
    const { ticket: _t, ...clean } = (cmd ?? {}) as QueueCommand & { ticket?: string };
    cmd = clean as QueueCommand;
    if (cmd?.action === 'report') cmd = { ...cmd, by: undefined };
    else if (!me) return SIGN_IN;
    else if (!may(me, 'staff')) return DENIED;
    // The audit trail names the signed-in user (not a name typed on the screen); the assistant's automatic moves stay "ระบบ".
    else cmd = { ...cmd, by: cmd.by === SYSTEM_BY ? SYSTEM_BY : me.name };
    const res = this.queue.apply(cmd);
    if (res.ok) this.publishQueueEvent(res.event);
    return res.ok ? { ok: true } : { ok: false, reason: res.reason };
  }
  // Settings: per-group / per-station overrides for supervisors; everything else for administrators.
  @SubscribeMessage('queue:settings:set')
  queueSettings(@ConnectedSocket() client: Socket, @MessageBody() cmd: SettingsCommand) {
    const me = userOf(client), p = cmd?.patch ?? {};
    if (!me) return SIGN_IN;
    const hospitalWide = p.system !== undefined || p.hours !== undefined || p.demoOffset !== undefined || p.layout !== undefined || p.dataMode !== undefined;
    if (!may(me, hospitalWide ? 'admin' : 'supervisor')) return { ok: false, reason: hospitalWide ? 'เฉพาะผู้ดูแลระบบเปลี่ยนค่าของทั้งโรงพยาบาลได้' : 'เฉพาะหัวหน้างานขึ้นไปเปลี่ยนการตั้งค่าได้' };
    const res = this.queue.setSettings({ ...cmd, by: me.name });
    if (res.ok) this.audit.record({ ...actor(me), action: 'settings.update', targetType: 'settings', targetId: cmd.scope, reason: cmd.summary, meta: { reset: res.reset } });
    // New service hours reset today's log: send every screen the whole log again.
    if (res.ok) { this.server.emit('queue:settings', res.settings); if (res.reset) this.publishLog(); else this.publishQueueEvent(res.event); }
    return res.ok ? { ok: true } : { ok: false, reason: res.reason };
  }
  // ---- Real patients (live data mode) ---------------------------------------------------------------------------
  // Registration / check-in staff take a patient into the queue; the number comes from the server, so two counters
  // can never hand out the same one. `key` makes a retried tap return the first visit instead of a second number.
  @SubscribeMessage('visit:enter')
  enterVisit(@ConnectedSocket() client: Socket, @MessageBody() body: EnterInput & { key?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (overLimit(client, 'command')) return SLOW;
    return attempt(() => {
      if (this.queue.getSettings().dataMode !== 'live') throw new AppError('POLICY_REJECTED', 'ระบบอยู่ในโหมดสาธิต — ผู้ดูแลระบบต้องเปิดโหมดข้อมูลจริงก่อน');
      const { key, ...input } = body ?? {};
      const { result, replayed } = this.idempotency.run(`visit:enter:user:${me.id}`, key, input, () => this.visits.enter(input, undefined).visit);
      if (!replayed) {
        this.audit.record({ ...actor(me), action: 'visit.enter', targetType: 'visit', targetId: result.id });
        this.server.emit('visit', result);
      }
      return { ok: true, visit: result };
    });
  }
  @SubscribeMessage('visit:step')
  addVisitStep(@ConnectedSocket() client: Socket, @MessageBody() body: { visitId?: unknown; kind?: unknown; at?: unknown; key?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (overLimit(client, 'command')) return SLOW;
    return attempt(() => {
      const { key, ...input } = body ?? {};
      const { result, replayed } = this.idempotency.run(`visit:step:user:${me.id}`, key, input, () => this.visits.addStep(input.visitId, input.kind, input.at));
      if (!replayed) this.server.emit('visit', result);
      return { ok: true, visit: result };
    });
  }
  @SubscribeMessage('visit:cancel')
  cancelVisit(@ConnectedSocket() client: Socket, @MessageBody() body: { visitId?: unknown; reason?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    return attempt(() => {
      const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 100) : '';
      if (!reason) throw new AppError('VALIDATION_ERROR', 'ระบุเหตุผลที่ยกเลิก');
      const { visit, changed } = this.visits.cancel(body?.visitId);
      if (changed) {
        this.audit.record({ ...actor(me), action: 'visit.cancel', targetType: 'visit', targetId: visit.id, reason });
        this.server.emit('visit', visit);
      }
      return { ok: true, visit };
    });
  }

  // ---- General booking (stage 2.2) ------------------------------------------------------------------------------
  // Administrators set the rules and the slots; staff book for patients at the counter or on the phone (the path for
  // patients without LINE) and cancel on request. Patients book for themselves from LINE in a later stage.
  // Screens that show bookings refresh on 'booking:changed' (staff only; it carries no patient data).
  private bookingChanged(serviceCode: string, startsAt?: string) {
    this.server.to(STAFF_ROOM).emit('booking:changed', { serviceCode, date: startsAt ? new Date(startsAt).toLocaleDateString('sv-SE') : undefined });
  }
  @SubscribeMessage('booking:policies')
  bookingPolicies(@ConnectedSocket() client: Socket) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    return { ok: true, policies: this.booking.policies(), enabled: this.features.on('generalBooking') };
  }
  @SubscribeMessage('booking:policy:set')
  setBookingPolicy(@ConnectedSocket() client: Socket, @MessageBody() body: Parameters<BookingService['setPolicy']>[0]) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => {
      const p = this.booking.setPolicy(body ?? {}, me.name);
      this.audit.record({ ...actor(me), action: 'booking.policy', targetType: 'booking-policy', targetId: p.serviceCode,
        meta: { version: p.version, enabled: p.enabled, advanceDays: p.advanceDays, cancelCutoffMinutes: p.cancelCutoffMinutes, maxActivePerPatient: p.maxActivePerPatient } });
      this.bookingChanged(p.serviceCode);
      return { ok: true, policy: p };
    });
  }
  @SubscribeMessage('booking:slots')
  bookingSlots(@ConnectedSocket() client: Socket, @MessageBody() body: { serviceCode?: unknown; date?: unknown; bookable?: boolean }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    return attempt(() => ({ ok: true, slots: body?.bookable ? this.booking.bookable(body.serviceCode, body.date) : this.booking.slots(body?.serviceCode, body?.date) }));
  }
  @SubscribeMessage('booking:slots:create')
  createBookingSlots(@ConnectedSocket() client: Socket, @MessageBody() body: Parameters<BookingService['createSlots']>[0]) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => {
      const r = this.booking.createSlots(body ?? {});
      this.audit.record({ ...actor(me), action: 'booking.slots.create', targetType: 'booking-policy', targetId: String(body?.serviceCode), meta: { created: r.created, from: body?.from, to: body?.to } });
      this.bookingChanged(String(body?.serviceCode));
      return { ok: true, ...r };
    });
  }
  @SubscribeMessage('booking:slot:set')
  setBookingSlot(@ConnectedSocket() client: Socket, @MessageBody() body: { slotId?: unknown; status?: unknown; capacity?: unknown; reason?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => {
      const r = this.booking.setSlot(body?.slotId, body ?? {}, `user:${me.id}`);
      this.audit.record({ ...actor(me), action: 'booking.slot.update', targetType: 'booking-slot', targetId: r.slot.id,
        reason: typeof body?.reason === 'string' ? body.reason : undefined, meta: { status: r.slot.status, capacity: r.slot.capacity, cancelledBookings: r.cancelled.length } });
      for (const b of r.cancelled) this.audit.record({ ...actor(me), action: 'booking.cancel', targetType: 'booking', targetId: b.id, reason: b.cancellationReason, meta: { slotCancelled: true } });
      this.bookingChanged(r.slot.serviceCode, r.slot.startsAt);
      return { ok: true, slot: r.slot, cancelled: r.cancelled.length };
    });
  }
  // Book for a patient whose identity staff have checked (as at registration today). `key`: a retried tap returns the
  // same booking instead of taking a second place.
  @SubscribeMessage('booking:create')
  createBooking(@ConnectedSocket() client: Socket, @MessageBody() body: { hn?: unknown; slotId?: unknown; key?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (overLimit(client, 'command')) return SLOW;
    return attempt(() => {
      this.features.require('generalBooking');
      const { key, ...input } = body ?? {};
      const { result, replayed } = this.idempotency.run(`booking:create:user:${me.id}`, key, input, () =>
        this.booking.book(this.booking.profileForHN(input.hn), input.slotId, 'STAFF', `user:${me.id}`));
      if (!replayed) {
        this.audit.record({ ...actor(me), action: 'booking.create', targetType: 'booking', targetId: result.id, meta: { channel: 'STAFF', serviceCode: result.serviceCode } });
        this.bookingChanged(result.serviceCode, result.startsAt);
      }
      return { ok: true, booking: result };
    });
  }
  // Cancel on the patient's request. After the cut-off: supervisors only, with staff overrides switched on.
  @SubscribeMessage('booking:cancel')
  cancelBooking(@ConnectedSocket() client: Socket, @MessageBody() body: { bookingId?: unknown; reason?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    return attempt(() => {
      const r = this.booking.cancel(body?.bookingId, body?.reason, { kind: 'staff', id: me.id, name: me.name, canOverride: may(me, 'supervisor') && this.features.on('staffOverrides') });
      if (r.changed) {
        this.audit.record({ ...actor(me), action: 'booking.cancel', targetType: 'booking', targetId: r.booking.id, reason: r.booking.cancellationReason, meta: { override: r.override } });
        this.bookingChanged(r.booking.serviceCode, r.booking.startsAt);
      }
      return { ok: true, booking: r.booking };
    });
  }
  @SubscribeMessage('booking:list')
  listBookings(@ConnectedSocket() client: Socket, @MessageBody() body: { date?: unknown; serviceCode?: unknown; code?: unknown; hn?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (overLimit(client, 'command')) return SLOW;
    return attempt(() => {
      const list = this.booking.list(body ?? {});
      // Looking a patient up by HN is access to personal data: kept in the trail (without the HN itself).
      if (typeof body?.hn === 'string' && body.hn.trim()) this.audit.record({ ...actor(me), action: 'booking.search.hn', targetType: 'patient-search', meta: { results: list.length } });
      return { ok: true, bookings: list };
    });
  }

  // Call this method only from a trusted, authenticated ingestion service.
  publishTrustedUpdate(update: FlowUpdate) {
    const result = this.flowService.apply(update);
    if (result.accepted) this.server.to('campus').emit('flow:update', result.update);
    return result;
  }
}
