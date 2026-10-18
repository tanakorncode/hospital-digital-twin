import { OnModuleDestroy } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthService, type Role, type User } from './auth.service';
import { allowOrigin } from './cors';
import { FlowService, FlowUpdate } from './flow.service';
import { LiveFeedService } from './live-feed.service';
import { QueueService, type QueueCommand, type QueueEvent, type QueueSettings, type SettingsCommand } from './queue.service';
import { TicketsService } from './tickets.service';
import { LineService } from './line.service';
import { AuditService } from './audit.service';
import { AppError, fail } from './errors';
import { BookingService } from './booking.service';
import { CheckInService } from './checkin.service';
import { AppointmentService } from './appointment.service';
import { PatientIdentityService } from './patient-identity.service';
import { NotificationService } from './notification.service';
import { WayfindingService } from './wayfinding.service';
import { FeaturesService } from './features.service';
import { IdempotencyService } from './idempotency.service';
import { VisitsService, type EnterInput } from './visits.service';
import { RetentionService } from './retention.service';
import { metrics } from './metrics';
import { ReportService } from './report.service';
import { KioskDeviceService } from './kiosk-device.service';
import { ReceptionService } from './reception.service';
import { FacilityService } from './facility.service';

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
  if (hits.length > max) { metrics.inc(`rateLimited.${kind}`); return true; }
  return false;
}
const SIGN_IN = { ...fail('AUTH_REQUIRED', 'กรุณาเข้าสู่ระบบก่อน'), auth: true };
// Clinic scope (spec §14.2): staff and supervisors may be limited to some clinics — they then find, book, move, cancel
// and check in only for those. No list = every clinic; administrators always cover every clinic. The emergency
// department's id (the sample's 'er') covers ER patients.
export const covers = (u: User, clinic: string | undefined) => u.role === 'admin' || !u.clinics?.length || (!!clinic && u.clinics.includes(clinic));
const OUTSIDE = () => new AppError('FORBIDDEN', 'รายการนี้อยู่นอกแผนกที่คุณรับผิดชอบ');
function mustCover(u: User, clinic: string | undefined) { if (clinic !== undefined && !covers(u, clinic)) throw OUTSIDE(); }
const actor = (u: User) => ({ actorType: 'staff' as const, actorId: `user:${u.id}` });
// Signed-in staff sockets share this room. Everyone else (TV boards, patient pages, anyone who opens a socket) gets the
// queue log without staff names — screens for the public only need numbers, places and states.
const STAFF_ROOM = 'staff';
export const publicEvent = ({ by: _by, ...e }: QueueEvent): QueueEvent => e;
// Settings for public screens: without who changed them last.
export const publicSettings = ({ updatedBy: _by, ...s }: QueueSettings): QueueSettings => s;
// Service errors (AppError) become the usual { ok:false, code, reason } reply.
function attempt<T>(fn: () => T) {
  try { return fn(); } catch (err) { if (err instanceof AppError) { metrics.refused('socket', err.code); return err.toJSON(); } throw err; }
}

@WebSocketGateway({ namespace: '/hospital', cors: { origin: allowOrigin } })
export class FlowGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private unsubscribe?: () => void;
  constructor(private readonly flowService: FlowService, private readonly liveFeed: LiveFeedService, private readonly queue: QueueService, private readonly auth: AuthService, private readonly tickets: TicketsService, private readonly line: LineService, private readonly audit: AuditService, private readonly features: FeaturesService, private readonly visits: VisitsService, private readonly idempotency: IdempotencyService, private readonly booking: BookingService, private readonly checkin: CheckInService, private readonly appts: AppointmentService, private readonly identity: PatientIdentityService, private readonly notify: NotificationService, private readonly wayfinding: WayfindingService, private readonly retention: RetentionService, private readonly report: ReportService,
    private readonly kiosks: KioskDeviceService, private readonly reception: ReceptionService, private readonly facility: FacilityService) {
    // A kiosk asks for a member of staff: every staff console sees the open requests (kiosk and place only).
    reception.onHelp((open) => this.server.to(STAFF_ROOM).emit('reception:help', open));
  }
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
    client.data.token = client.handshake.auth?.token;
    if (user) { void client.join(STAFF_ROOM); client.emit('reception:help', this.reception.openHelp()); }
    client.emit('auth:me', user);
    client.emit('features', this.featureList());
    client.emit('flow:snapshot', this.flowService.snapshot());
    client.emit('live:snapshot', this.liveFeed.snapshot());
    this.sendLog(client);
    client.emit('queue:settings', user ? this.queue.getSettings() : publicSettings(this.queue.getSettings()));
    client.emit('facility:updated', user ? this.facility.current() : this.facility.publicView());
    client.emit('visits', this.visits.list());
  }
  // A new facility version to every screen (staff get retired things too, for history).
  private publishFacility() {
    this.server.to(STAFF_ROOM).emit('facility:updated', this.facility.current());
    this.server.except(STAFF_ROOM).emit('facility:updated', this.facility.publicView());
  }
  private sendLog(client: Socket) {
    const list = this.queue.list();
    client.emit('queue:events', userOf(client) ? list : list.map(publicEvent));
  }
  // One accepted queue action to every screen: in full to staff, without names to the rest.
  publishQueueEvent(e: QueueEvent) {
    this.server.to(STAFF_ROOM).emit('queue:event', e);
    this.server.except(STAFF_ROOM).emit('queue:event', publicEvent(e));
    this.line.onQueueEvent(e);
    this.notify.onQueueEvent(e);
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
    client.data.token = res.token;
    void client.join(STAFF_ROOM);
    this.sendLog(client); // now with the names the public stream leaves out
    client.emit('reception:help', this.reception.openHelp());
    client.emit('queue:settings', this.queue.getSettings());
    client.emit('facility:updated', this.facility.current());
    return res;
  }
  @SubscribeMessage('auth:logout')
  logout(@ConnectedSocket() client: Socket) {
    this.auth.logout(client.handshake.auth?.token);
    if (client.data.token !== client.handshake.auth?.token) this.auth.logout(client.data.token);
    client.data.user = null;
    client.data.token = undefined;
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
      meta: { role: res.user.role, active: res.user.active, signInReset: !!(b.id && b.password), clinics: res.user.clinics.length } });
    if (b.id) this.refreshUser(res.user.id);
    return { ok: true, user: res.user, users: this.auth.list() };
  }
  // A changed account takes effect on the screens already open: new role / clinics at once; suspended or signed out
  // (password reset) → the screen is signed out.
  private refreshUser(id: number) {
    const sockets = (this.server as unknown as { sockets?: Map<string, Socket> }).sockets;
    if (!(sockets instanceof Map)) return;
    for (const s of sockets.values()) {
      if (userOf(s)?.id !== id) continue;
      const fresh = this.auth.resolve(s.data.token);
      s.data.user = fresh;
      if (!fresh) void s.leave(STAFF_ROOM);
      s.emit('auth:me', fresh);
    }
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

  // How long records are kept (administrators). 'retention:get' also says what the saved — or the proposed — settings
  // would remove now, so the effect is visible before saving.
  @SubscribeMessage('retention:get')
  retentionGet(@ConnectedSocket() client: Socket, @MessageBody() body: { proposed?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => {
      const proposed = body?.proposed ? this.retention.check(body.proposed) : undefined;
      return { ok: true, settings: this.retention.settings(), last: this.retention.lastRun(), preview: this.retention.run({ dryRun: true, with: proposed }).removed };
    });
  }
  @SubscribeMessage('retention:set')
  retentionSet(@ConnectedSocket() client: Socket, @MessageBody() body: { patch?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => ({ ok: true, settings: this.retention.set(body?.patch, `user:${me.id}`) }));
  }
  @SubscribeMessage('retention:run')
  retentionRun(@ConnectedSocket() client: Socket) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => { const r = this.retention.run(); this.audit.record({ ...actor(me), action: 'retention.run', targetType: 'database', meta: r.removed }); return { ok: true, last: r }; });
  }

  // Reports (spec §15.1). The Phase 2 report: supervisors and administrators, limited to the account's clinics.
  // The operation counters (refusals by code, replays, rate limits, HTTP latency): administrators.
  @SubscribeMessage('report:phase2')
  phase2Report(@ConnectedSocket() client: Socket, @MessageBody() body: { from?: unknown; to?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'supervisor')) return DENIED;
    return attempt(() => ({ ok: true, report: this.report.phase2(body?.from, body?.to, me.role === 'admin' ? [] : me.clinics) }));
  }
  @SubscribeMessage('report:metrics')
  metricsReport(@ConnectedSocket() client: Socket) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return { ok: true, metrics: metrics.snapshot() };
  }

  // ---- Digital Reception (administrators): kiosks, approved answers, use; staff: take on a kiosk's call ----------------
  @SubscribeMessage('reception:kiosks')
  receptionKiosks(@ConnectedSocket() client: Socket) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return { ok: true, kiosks: this.kiosks.list(), enabled: this.features.on('reception'), settings: this.reception.settings() };
  }
  // New kiosk / rename / move. The credential comes back once (new kiosk or rotation) — it is never stored in clear.
  @SubscribeMessage('reception:kiosk:save')
  saveKiosk(@ConnectedSocket() client: Socket, @MessageBody() body: { id?: unknown; name?: unknown; atCode?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => {
      const r = this.kiosks.save(body ?? {}, `user:${me.id}`);
      this.audit.record({ ...actor(me), action: body?.id ? 'reception.kiosk.update' : 'reception.kiosk.create', targetType: 'kiosk', targetId: r.device.id, meta: { at: r.device.atCode ?? null } });
      return { ok: true, ...r };
    });
  }
  @SubscribeMessage('reception:kiosk:rotate')
  rotateKiosk(@ConnectedSocket() client: Socket, @MessageBody() body: { id?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => { const r = this.kiosks.rotate(body?.id); this.audit.record({ ...actor(me), action: 'reception.kiosk.rotate', targetType: 'kiosk', targetId: r.device.id }); return { ok: true, ...r }; });
  }
  @SubscribeMessage('reception:kiosk:revoke')
  revokeKiosk(@ConnectedSocket() client: Socket, @MessageBody() body: { id?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => { const d = this.kiosks.revoke(body?.id); this.audit.record({ ...actor(me), action: 'reception.kiosk.revoke', targetType: 'kiosk', targetId: d.id }); return { ok: true, device: d }; });
  }
  @SubscribeMessage('reception:settings:set')
  receptionSettings(@ConnectedSocket() client: Socket, @MessageBody() body: { patch?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => { const r = this.reception.setSettings(body?.patch);
      if (Object.keys(r.changed).length) this.audit.record({ ...actor(me), action: 'reception.settings', targetType: 'settings', targetId: 'reception', meta: r.changed });
      return { ok: true, settings: r.settings }; });
  }
  @SubscribeMessage('reception:answers')
  receptionAnswers(@ConnectedSocket() client: Socket) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return { ok: true, answers: this.reception.answers() };
  }
  // An edit is a new draft: kiosks keep saying nothing about it until it is approved.
  @SubscribeMessage('reception:answer:save')
  saveAnswer(@ConnectedSocket() client: Socket, @MessageBody() body: Record<string, unknown>) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => { const a = this.reception.saveAnswer(body ?? {}, `user:${me.id}`);
      this.audit.record({ ...actor(me), action: 'reception.answer.save', targetType: 'reception-answer', targetId: a.id, meta: { topic: a.topic, version: a.version } }); return { ok: true, answer: a }; });
  }
  @SubscribeMessage('reception:answer:approve')
  approveAnswer(@ConnectedSocket() client: Socket, @MessageBody() body: { id?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => { const a = this.reception.approve(body?.id, `user:${me.id}`);
      this.audit.record({ ...actor(me), action: 'reception.answer.approve', targetType: 'reception-answer', targetId: a.id, meta: { version: a.version } }); return { ok: true, answer: a }; });
  }
  @SubscribeMessage('reception:answer:retire')
  retireAnswer(@ConnectedSocket() client: Socket, @MessageBody() body: { id?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => { const a = this.reception.retire(body?.id, `user:${me.id}`);
      this.audit.record({ ...actor(me), action: 'reception.answer.retire', targetType: 'reception-answer', targetId: a.id }); return { ok: true, answer: a }; });
  }
  @SubscribeMessage('reception:usage')
  receptionUsage(@ConnectedSocket() client: Socket, @MessageBody() body: { days?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return { ok: true, ...this.reception.usage(body?.days) };
  }
  // Any member of staff can take on a kiosk's call; it disappears from every console.
  @SubscribeMessage('reception:help:ack')
  ackKioskHelp(@ConnectedSocket() client: Socket, @MessageBody() body: { id?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    const r = this.reception.ack(body?.id);
    if (r) this.audit.record({ ...actor(me), action: 'reception.help.ack', targetType: 'kiosk', targetId: r.kioskId, meta: { reason: r.reason } });
    return { ok: true, taken: !!r };
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
  // ---- Facility model (docs/FACILITY-MODEL-DESIGN.md): every screen reads it; administrators edit a draft, check its
  // impact and publish it as a new version (or roll back to an earlier one).
  @SubscribeMessage('facility:get')
  facilityGet(@ConnectedSocket() client: Socket) {
    const me = userOf(client);
    return { ok: true, facility: me ? this.facility.current() : this.facility.publicView() };
  }
  @SubscribeMessage('facility:draft:get')
  facilityDraft(@ConnectedSocket() client: Socket) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return { ok: true, draft: this.facility.draft(`user:${me.id}`) ?? null, version: this.facility.version() };
  }
  @SubscribeMessage('facility:draft:save')
  facilityDraftSave(@ConnectedSocket() client: Socket, @MessageBody() body: { data?: unknown; baseVersion?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => ({ ok: true, ...this.facility.saveDraft(`user:${me.id}`, body?.data, body?.baseVersion) }));
  }
  @SubscribeMessage('facility:draft:discard')
  facilityDraftDiscard(@ConnectedSocket() client: Socket) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return { ok: true, discarded: this.facility.discardDraft(`user:${me.id}`) };
  }
  // What publishing would do — the given data, else the administrator's draft.
  @SubscribeMessage('facility:impact')
  facilityImpact(@ConnectedSocket() client: Socket, @MessageBody() body: { data?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    const data = body?.data ?? this.facility.draft(`user:${me.id}`)?.data;
    if (!data) return { ok: false, code: 'VALIDATION_ERROR', reason: 'ยังไม่มีร่างผัง' };
    return { ok: true, impact: this.facility.impact(data) };
  }
  @SubscribeMessage('facility:publish')
  facilityPublish(@ConnectedSocket() client: Socket, @MessageBody() body: { data?: unknown; note?: unknown; baseVersion?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => {
      const draft = body?.data === undefined ? this.facility.draft(`user:${me.id}`) : undefined;
      if (body?.data === undefined && !draft) return { ok: false, code: 'VALIDATION_ERROR', reason: 'ยังไม่มีร่างผัง' };
      const r = this.facility.publish(`user:${me.id}`, body?.data ?? draft!.data, { note: body?.note, baseVersion: body?.baseVersion ?? draft?.baseVersion });
      this.audit.record({ ...actor(me), action: 'facility.publish', targetType: 'facility', targetId: String(r.facility.version), reason: typeof body?.note === 'string' ? body.note.slice(0, 200) : undefined, meta: r.impact.summary });
      this.publishFacility();
      return { ok: true, version: r.facility.version, impact: r.impact };
    });
  }
  @SubscribeMessage('facility:versions')
  facilityVersions(@ConnectedSocket() client: Socket, @MessageBody() body: { version?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    if (body?.version !== undefined) { const data = this.facility.versionData(body.version); return data ? { ok: true, data } : { ok: false, code: 'RESOURCE_NOT_FOUND', reason: 'ไม่พบเวอร์ชันนี้' }; }
    return { ok: true, current: this.facility.version(), versions: this.facility.versions() };
  }
  // What uses a department or a room / counter (ids), for the settings page.
  @SubscribeMessage('facility:usage')
  facilityUsage(@ConnectedSocket() client: Socket, @MessageBody() body: { ids?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    const ids = Array.isArray(body?.ids) ? body.ids.filter((x): x is string => typeof x === 'string').slice(0, 300) : [];
    return { ok: true, usage: Object.fromEntries(ids.map((id) => [id, this.facility.usage(id)]).filter(([, u]) => (u as unknown[]).length)) };
  }
  @SubscribeMessage('facility:rollback')
  facilityRollback(@ConnectedSocket() client: Socket, @MessageBody() body: { version?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => {
      const r = this.facility.rollback(`user:${me.id}`, body?.version);
      this.audit.record({ ...actor(me), action: 'facility.rollback', targetType: 'facility', targetId: String(r.facility.version), meta: { to: body?.version, ...r.impact.summary } });
      this.publishFacility();
      return { ok: true, version: r.facility.version, impact: r.impact };
    });
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
    // The old departments page still edits the layout: the facility model follows it until it is edited directly.
    if (res.ok && p.layout !== undefined && this.facility.syncFromLayout(res.settings.layout, `user:${me.id}`)) this.publishFacility();
    // New service hours reset today's log: send every screen the whole log again.
    if (res.ok) { this.server.to(STAFF_ROOM).emit('queue:settings', res.settings); this.server.except(STAFF_ROOM).emit('queue:settings', publicSettings(res.settings)); if (res.reset) this.publishLog(); else this.publishQueueEvent(res.event); }
    return res.ok ? { ok: true } : { ok: false, reason: res.reason };
  }
  // ---- Real patients (live data mode) ---------------------------------------------------------------------------
  // Registration / check-in staff take a patient into the queue; the number comes from the server, so two counters
  // can never hand out the same one. `key` makes a retried tap return the first visit instead of a second number.
  @SubscribeMessage('visit:enter')
  enterVisit(@ConnectedSocket() client: Socket, @MessageBody() body: EnterInput & { key?: unknown; hn?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (overLimit(client, 'command')) return SLOW;
    return attempt(() => {
      if (this.queue.getSettings().dataMode !== 'live') throw new AppError('POLICY_REJECTED', 'ระบบอยู่ในโหมดสาธิต — ผู้ดูแลระบบต้องเปิดโหมดข้อมูลจริงก่อน');
      // hn (optional): staff have checked the ID card — the visit then belongs to that patient, so a linked LINE account
      // sees it in "คิวของฉัน" and hears when it is called. It is never shown on any screen.
      const { key, hn, ...input } = (body ?? {}) as EnterInput & { key?: unknown; hn?: unknown };
      const withHn = typeof hn === 'string' && hn.trim() !== '';
      const { result, replayed } = this.idempotency.run(`visit:enter:user:${me.id}`, key, { ...input, hn: withHn ? hn : undefined }, () => {
        mustCover(me, input.flow === 'er' ? this.facility.erDepartment()?.id ?? 'er' : typeof input.clinicKey === 'string' ? input.clinicKey : undefined);
        const profileId = withHn ? this.booking.profileForHN(hn) : undefined;
        const v = this.visits.enter(input, undefined, { profileId }).visit;
        if (profileId) this.notify.checkedIn(v, profileId, v.flow === 'er' ? this.facility.erDepartment()?.name ?? 'ห้องฉุกเฉิน' : `พื้นที่รอ ${v.dept}`);
        return v;
      });
      if (!replayed) {
        this.audit.record({ ...actor(me), action: 'visit.enter', targetType: 'visit', targetId: result.id, meta: { withPatientRecord: withHn } });
        this.server.emit('visit', result);
        this.notify.kick();
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
  bookingChanged(serviceCode: string, startsAt?: string) {
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
      // The change and its messages to patients commit together (outbox).
      const r = this.notify.tx(() => { const x = this.booking.setSlot(body?.slotId, body ?? {}, `user:${me.id}`);
        for (const b of x.cancelled) this.notify.bookingCancelled(b, this.booking.profileOf(b.id)); return x; });
      this.notify.kick();
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
        { mustCover(me, this.booking.slotService(input.slotId)); const profile = this.booking.profileForHN(input.hn), b = this.booking.book(profile, input.slotId, 'STAFF', `user:${me.id}`); this.notify.bookingConfirmed(b, profile); return b; });
      this.notify.kick();
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
      mustCover(me, this.booking.get(body?.bookingId)?.serviceCode);
      const r = this.notify.tx(() => { const x = this.booking.cancel(body?.bookingId, body?.reason, { kind: 'staff', id: me.id, name: me.name, canOverride: may(me, 'supervisor') && this.features.on('staffOverrides') });
        if (x.changed) this.notify.bookingCancelled(x.booking, this.booking.profileOf(x.booking.id)); return x; });
      this.notify.kick();
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
      const list = this.booking.list(body ?? {}).filter((b) => covers(me, b.serviceCode));
      // Looking a patient up by HN is access to personal data: kept in the trail (without the HN itself).
      if (typeof body?.hn === 'string' && body.hn.trim()) this.audit.record({ ...actor(me), action: 'booking.search.hn', targetType: 'patient-search', meta: { results: list.length } });
      return { ok: true, bookings: list };
    });
  }

  // ---- Check-in (stages 2.3 / 2.4) -----------------------------------------------------------------------------------
  // A patient with a booking (BK…) or an appointment (AP…) arrives: at the kiosk (code typed or scanned, only inside the
  // check-in window) or at the counter. Answers with the queue number and the link for the patient's QR — the same
  // ones if it was already done.
  @SubscribeMessage('checkin:code')
  checkInCode(@ConnectedSocket() client: Socket, @MessageBody() body: { code?: unknown; channel?: unknown; at?: unknown; prefix?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (overLimit(client, 'command')) return SLOW;
    return attempt(() => {
      if (this.queue.getSettings().dataMode !== 'live') throw new AppError('POLICY_REJECTED', 'ระบบอยู่ในโหมดสาธิต — เช็กอินเข้าคิวจริงได้เมื่อเปิดโหมดผู้ป่วยจริง');
      const channel = body?.channel === 'KIOSK' ? 'KIOSK' : 'COUNTER';
      const r = this.notify.tx(() => { const x = this.checkin.checkIn(body?.code, { channel, at: body?.at, by: `user:${me.id}`, prefix: body?.prefix, allow: (c) => covers(me, c) });
        const profile = this.visits.profileOf(x.visit.id);
        if (!x.already && profile) { this.notify.checkedIn(x.visit, profile, `พื้นที่รอ ${x.visit.dept}`); if (x.source.kind === 'APPOINTMENT') this.notify.cancel('appointment', x.source.id, 'APPT_REMINDER'); }
        return x; });
      this.notify.kick();
      if (!r.already) {
        const booking = r.source.kind === 'BOOKING';
        this.audit.record({ ...actor(me), action: booking ? 'checkin.booking' : 'checkin.appointment', targetType: booking ? 'booking' : 'appointment', targetId: r.source.id,
          meta: { channel, late: r.late, visit: r.visit.id } });
        this.server.emit('visit', r.visit);
        if (booking) this.bookingChanged(r.visit.clinicKey ?? '', r.source.startsAt); else this.apptChanged();
      }
      const ticket = this.tickets.issue(r.visit.id, me.name);
      const { id: _id, ...source } = r.source;
      return { ok: true, already: r.already, late: r.late, visit: r.visit, ticket: { token: ticket.token, expiresAt: ticket.expiresAt }, source };
    });
  }
  // Older name (stage 2.3 screens).
  @SubscribeMessage('checkin:booking')
  checkInBooking(@ConnectedSocket() client: Socket, @MessageBody() body: { code?: unknown; channel?: unknown; at?: unknown; prefix?: unknown }) {
    return this.checkInCode(client, body);
  }

  // ---- Doctor appointments (stage 2.4) ------------------------------------------------------------------------------
  // Administrators: rules per clinic and doctors' sessions. Staff: make, move, cancel appointments for patients, and
  // decide on requests to move. Supervisors: record a no-show (after the time, with a reason).
  apptChanged() { this.server.to(STAFF_ROOM).emit('appointment:changed', {}); }
  private staffActor(me: User) { return { kind: 'staff' as const, id: me.id, canOverride: may(me, 'supervisor') && this.features.on('staffOverrides') }; }
  @SubscribeMessage('appt:policies')
  apptPolicies(@ConnectedSocket() client: Socket) {
    if (!userOf(client)) return SIGN_IN;
    return { ok: true, policies: this.appts.policies(), enabled: this.features.on('appointments') };
  }
  @SubscribeMessage('appt:policy:set')
  setApptPolicy(@ConnectedSocket() client: Socket, @MessageBody() body: Record<string, unknown>) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => {
      const p = this.appts.setPolicy(body ?? {}, me.name);
      this.audit.record({ ...actor(me), action: 'appointment.policy', targetType: 'appointment-policy', targetId: p.clinicCode,
        meta: { version: p.version, enabled: p.enabled, advanceDays: p.advanceDays, cancelCutoffMinutes: p.cancelCutoffMinutes, rescheduleNeedsApproval: p.rescheduleNeedsApproval } });
      this.apptChanged();
      return { ok: true, policy: p };
    });
  }
  @SubscribeMessage('appt:sessions:create')
  createApptSessions(@ConnectedSocket() client: Socket, @MessageBody() body: Record<string, unknown>) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => {
      const r = this.appts.createSessions(body ?? {});
      this.audit.record({ ...actor(me), action: 'appointment.sessions.create', targetType: 'appointment-policy', targetId: String(body?.clinicCode),
        meta: { provider: body?.providerCode, sessions: r.sessions, conflicts: r.conflicts.length } });
      this.apptChanged();
      return { ok: true, ...r };
    });
  }
  @SubscribeMessage('appt:sessions')
  apptSessions(@ConnectedSocket() client: Socket, @MessageBody() body: { clinicCode?: unknown; date?: unknown }) {
    if (!userOf(client)) return SIGN_IN;
    return attempt(() => ({ ok: true, sessions: this.appts.sessions(body?.clinicCode, body?.date) }));
  }
  @SubscribeMessage('appt:session:set')
  // Close / reopen / cancel a session: administrators. Change only its room (the doctor works in another room today):
  // also supervisors of that clinic — patients of the session already waiting move with the doctor.
  setApptSession(@ConnectedSocket() client: Socket, @MessageBody() body: { sessionId?: unknown; status?: unknown; reason?: unknown; roomId?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, body?.status === undefined && body?.roomId !== undefined ? 'supervisor' : 'admin')) return DENIED;
    return attempt(() => {
      mustCover(me, this.appts.sessionClinic(body?.sessionId));
      const r = this.notify.tx(() => { const x = this.appts.setSession(body?.sessionId, body ?? {}, `user:${me.id}`);
        for (const a of x.cancelled) this.notify.appointmentCancelled(a, this.appts.profileOf(a.id)!, true); return x; });
      this.notify.kick();
      this.audit.record({ ...actor(me), action: 'appointment.session.update', targetType: 'provider-schedule', targetId: r.session.id,
        reason: typeof body?.reason === 'string' ? body.reason : undefined, meta: { status: r.session.status, cancelledAppointments: r.cancelled.length, ...(body?.roomId !== undefined ? { room: r.session.roomId ?? null, movedVisits: r.movedVisits.length } : {}) } });
      for (const a of r.cancelled) this.audit.record({ ...actor(me), action: 'appointment.cancel', targetType: 'appointment', targetId: a.id, reason: a.cancellationReason, meta: { sessionCancelled: true } });
      for (const id of r.movedVisits) { const v = this.visits.get(id); if (v) this.server.emit('visit', v); }
      this.apptChanged();
      return { ok: true, session: r.session, cancelled: r.cancelled.length, movedVisits: r.movedVisits.length };
    });
  }
  // Days with a place left — the pickers offer only these (no empty weekends / holidays).
  @SubscribeMessage('booking:days')
  bookingDays(@ConnectedSocket() client: Socket, @MessageBody() body: { serviceCode?: unknown }) {
    if (!userOf(client)) return SIGN_IN;
    return { ok: true, days: this.booking.openDays(body?.serviceCode) };
  }
  @SubscribeMessage('appt:days')
  apptDays(@ConnectedSocket() client: Socket, @MessageBody() body: { clinicCode?: unknown; providerCode?: unknown; except?: unknown }) {
    if (!userOf(client)) return SIGN_IN;
    const a = typeof body?.except === 'string' ? this.appts.get(body.except) : undefined;
    return { ok: true, days: this.appts.openDays(body?.clinicCode, body?.providerCode, a && { startsAt: a.startsAt, providerCode: a.providerCode }) };
  }
  @SubscribeMessage('appt:slots')
  apptSlots(@ConnectedSocket() client: Socket, @MessageBody() body: { clinicCode?: unknown; date?: unknown; providerCode?: unknown; bookable?: boolean }) {
    if (!userOf(client)) return SIGN_IN;
    return attempt(() => ({ ok: true, slots: body?.bookable ? this.appts.bookable(body.clinicCode, body.date, body.providerCode) : this.appts.slots(body?.clinicCode, body?.date, body?.providerCode) }));
  }
  @SubscribeMessage('appt:create')
  createAppt(@ConnectedSocket() client: Socket, @MessageBody() body: { hn?: unknown; slotId?: unknown; key?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (overLimit(client, 'command')) return SLOW;
    return attempt(() => {
      this.features.require('appointments');
      const { key, ...input } = body ?? {};
      const { result, replayed } = this.idempotency.run(`appointment:create:user:${me.id}`, key, input, () =>
        { mustCover(me, this.appts.slotClinic(input.slotId)); const profile = this.booking.profileForHN(input.hn), a = this.appts.create(profile, input.slotId, 'STAFF', `user:${me.id}`); this.notify.appointmentMade(a, profile); return a; });
      this.notify.kick();
      if (!replayed) { this.audit.record({ ...actor(me), action: 'appointment.create', targetType: 'appointment', targetId: result.id, meta: { clinic: result.clinicCode } }); this.apptChanged(); }
      return { ok: true, appointment: result };
    });
  }
  @SubscribeMessage('appt:cancel')
  cancelAppt(@ConnectedSocket() client: Socket, @MessageBody() body: { appointmentId?: unknown; reason?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    return attempt(() => {
      mustCover(me, this.appts.get(body?.appointmentId)?.clinicCode);
      const r = this.notify.tx(() => { const x = this.appts.cancel(body?.appointmentId, body?.reason, this.staffActor(me));
        if (x.changed) this.notify.appointmentCancelled(x.appointment, this.appts.profileOf(x.appointment.id)!, true); return x; });
      this.notify.kick();
      if (r.changed) { this.audit.record({ ...actor(me), action: 'appointment.cancel', targetType: 'appointment', targetId: r.appointment.id, reason: r.appointment.cancellationReason, meta: { override: r.override } }); this.apptChanged(); }
      return { ok: true, appointment: r.appointment };
    });
  }
  // Staff move an appointment now (the patient asked at the counter / on the phone).
  @SubscribeMessage('appt:reschedule')
  rescheduleAppt(@ConnectedSocket() client: Socket, @MessageBody() body: { appointmentId?: unknown; slotId?: unknown; key?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    return attempt(() => {
      this.features.require('appointments');
      const { key, ...input } = body ?? {};
      const before = this.appts.get(input.appointmentId);
      mustCover(me, before?.clinicCode);
      const { result, replayed } = this.idempotency.run(`appointment:reschedule:user:${me.id}`, key, input, () => {
        const a = this.appts.reschedule(input.appointmentId, input.slotId, this.staffActor(me)); this.notify.appointmentMoved(a, this.appts.profileOf(a.id)!, true); return a; });
      this.notify.kick();
      if (!replayed) { this.audit.record({ ...actor(me), action: 'appointment.reschedule', targetType: 'appointment', targetId: result.id, meta: { from: before?.startsAt, to: result.startsAt } }); this.apptChanged(); }
      return { ok: true, appointment: result };
    });
  }
  @SubscribeMessage('appt:requests')
  apptRequests(@ConnectedSocket() client: Socket, @MessageBody() body: { status?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    return attempt(() => ({ ok: true, requests: this.appts.requests(body?.status).filter((r) => covers(me, r.appointment.clinicCode)) }));
  }
  @SubscribeMessage('appt:decide')
  decideAppt(@ConnectedSocket() client: Socket, @MessageBody() body: { requestId?: unknown; approve?: unknown; note?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    return attempt(() => {
      mustCover(me, this.appts.requestClinic(body?.requestId));
      const r = this.notify.tx(() => { const x = this.appts.decide(body?.requestId, body?.approve, body?.note, this.staffActor(me)), profile = this.appts.profileOf(x.appointment.id)!;
        if (x.status === 'APPROVED') this.notify.appointmentMoved(this.appts.get(x.appointment.id)!, profile, true);
        else if (x.status === 'REJECTED') this.notify.moveRejected(x.appointment, profile, x.id, x.decisionNote);
        return x; });
      this.notify.kick();
      this.audit.record({ ...actor(me), action: r.status === 'APPROVED' ? 'appointment.reschedule.approve' : 'appointment.reschedule.reject', targetType: 'appointment', targetId: r.appointment.id, reason: r.decisionNote });
      this.apptChanged();
      return { ok: true, request: r };
    });
  }
  @SubscribeMessage('appt:noshow')
  noShowAppt(@ConnectedSocket() client: Socket, @MessageBody() body: { appointmentId?: unknown; reason?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'supervisor')) return { ...DENIED, reason: 'เฉพาะหัวหน้างานบันทึกไม่มาตามนัดได้' };
    return attempt(() => {
      mustCover(me, this.appts.get(body?.appointmentId)?.clinicCode);
      const a = this.notify.tx(() => { const x = this.appts.markNoShow(body?.appointmentId, body?.reason, `user:${me.id}`); this.notify.cancel('appointment', x.id); return x; });
      this.audit.record({ ...actor(me), action: 'appointment.noshow', targetType: 'appointment', targetId: a.id, reason: a.noShowReason });
      this.apptChanged();
      return { ok: true, appointment: a };
    });
  }
  @SubscribeMessage('appt:list')
  listAppts(@ConnectedSocket() client: Socket, @MessageBody() body: { date?: unknown; clinicCode?: unknown; code?: unknown; hn?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (overLimit(client, 'command')) return SLOW;
    return attempt(() => {
      const list = this.appts.list(body ?? {}).filter((a) => covers(me, a.clinicCode));
      if (typeof body?.hn === 'string' && body.hn.trim()) this.audit.record({ ...actor(me), action: 'appointment.search.hn', targetType: 'patient-search', meta: { results: list.length } });
      return { ok: true, appointments: list };
    });
  }

  // ---- Linking a patient's LINE account (stage 2.5) ---------------------------------------------------------------
  // At the counter: the patient shows the one-time QR from LINE, staff check the ID card as today, then confirm with the
  // HN. Staff can see whether a patient is linked (never the LINE id) and end a link with a reason.
  @SubscribeMessage('link:confirm')
  confirmLink(@ConnectedSocket() client: Socket, @MessageBody() body: { code?: unknown; hn?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (overLimit(client, 'command')) return SLOW;
    return attempt(() => {
      this.features.require('accountLinking');
      const r = this.identity.confirmLink(body?.code, body?.hn, `user:${me.id}`);
      this.audit.record({ ...actor(me), action: 'line.link', targetType: 'line-link', targetId: r.linkId, meta: { method: 'STAFF_ASSISTED', replaced: r.replaced } });
      return { ok: true, hn: r.hn, replaced: r.replaced };
    });
  }
  @SubscribeMessage('link:status')
  linkStatus(@ConnectedSocket() client: Socket, @MessageBody() body: { hn?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (overLimit(client, 'command')) return SLOW;
    return attempt(() => {
      const r = this.identity.status(body?.hn);
      this.audit.record({ ...actor(me), action: 'line.status', targetType: 'patient-search' });
      return { ok: true, ...r };
    });
  }
  @SubscribeMessage('link:revoke')
  revokeLink(@ConnectedSocket() client: Socket, @MessageBody() body: { hn?: unknown; reason?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    return attempt(() => {
      this.identity.revoke(body?.hn, body?.reason, `user:${me.id}`);
      this.audit.record({ ...actor(me), action: 'line.revoke', targetType: 'line-link', reason: typeof body?.reason === 'string' ? body.reason : undefined });
      return { ok: true };
    });
  }

  // ---- Messages to patients (stage 2.7): what was sent, what failed, send again ------------------------------------------
  @SubscribeMessage('notify:jobs')
  notifyJobs(@ConnectedSocket() client: Socket, @MessageBody() body: { status?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return { ok: true, line: this.notify.lineConfigured, enabled: this.features.on('notifications'), ...this.notify.jobs(body?.status) };
  }
  @SubscribeMessage('notify:retry')
  notifyRetry(@ConnectedSocket() client: Socket, @MessageBody() body: { id?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    if (!this.notify.retry(body?.id)) return fail('INVALID_STATE_TRANSITION', 'ส่งใหม่ได้เฉพาะข้อความที่ส่งไม่สำเร็จ');
    this.audit.record({ ...actor(me), action: 'notify.retry', targetType: 'notification', targetId: String(body?.id) });
    return { ok: true };
  }

  // ---- LINE OA: what is set up, try the bot, install the rich menu ---------------------------------------------------
  @SubscribeMessage('line:status')
  lineStatus(@ConnectedSocket() client: Socket) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return { ok: true, ...this.line.status() };
  }
  // What the bot would answer — no message is sent anywhere.
  @SubscribeMessage('line:try')
  lineTry(@ConnectedSocket() client: Socket, @MessageBody() body: { text?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (overLimit(client, 'command')) return SLOW;
    const text = typeof body?.text === 'string' ? body.text.slice(0, 200) : '';
    return { ok: true, answer: this.line.answer(text) };
  }
  @SubscribeMessage('line:richmenu')
  async lineRichMenu(@ConnectedSocket() client: Socket, @MessageBody() body: { png?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    try {
      const id = await this.line.installRichMenu(body?.png);
      this.audit.record({ ...actor(me), action: 'line.richmenu', targetType: 'line-oa', meta: { richMenuId: id } });
      return { ok: true };
    } catch (err) { if (err instanceof AppError) return err.toJSON(); throw err; }
  }

  // ---- Wayfinding places and QR signs (stage 2.8, administrators) ----------------------------------------------------
  @SubscribeMessage('wayfinding:list')
  wayfindingList(@ConnectedSocket() client: Socket) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return { ok: true, destinations: this.wayfinding.list(true), enabled: this.features.on('wayfinding') };
  }
  @SubscribeMessage('wayfinding:save')
  wayfindingSave(@ConnectedSocket() client: Socket, @MessageBody() body: Record<string, unknown>) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => {
      const d = this.wayfinding.save(body ?? {}, `user:${me.id}`);
      this.audit.record({ ...actor(me), action: 'wayfinding.save', targetType: 'destination', targetId: d.code });
      return { ok: true, destination: d };
    });
  }
  @SubscribeMessage('wayfinding:import')
  wayfindingImport(@ConnectedSocket() client: Socket, @MessageBody() body: { list?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => {
      const r = this.wayfinding.importMany(body?.list, `user:${me.id}`);
      this.audit.record({ ...actor(me), action: 'wayfinding.import', targetType: 'destination', meta: r });
      return { ok: true, ...r };
    });
  }
  @SubscribeMessage('wayfinding:retire')
  wayfindingRetire(@ConnectedSocket() client: Socket, @MessageBody() body: { code?: unknown; replacedBy?: unknown }) {
    const me = userOf(client);
    if (!me) return SIGN_IN;
    if (!may(me, 'admin')) return DENIED;
    return attempt(() => {
      const d = this.wayfinding.retire(body?.code, body?.replacedBy, `user:${me.id}`);
      this.audit.record({ ...actor(me), action: 'wayfinding.retire', targetType: 'destination', targetId: d.code, meta: { replacedBy: d.replacedBy } });
      return { ok: true, destination: d };
    });
  }

  // Call this method only from a trusted, authenticated ingestion service.
  publishTrustedUpdate(update: FlowUpdate) {
    const result = this.flowService.apply(update);
    if (result.accepted) this.server.to('campus').emit('flow:update', result.update);
    return result;
  }
}
