import { OnModuleDestroy } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthService, type Role, type User } from './auth.service';
import { allowOrigin } from './cors';
import { FlowService, FlowUpdate } from './flow.service';
import { LiveFeedService } from './live-feed.service';
import { QueueService, type QueueCommand, type SettingsCommand } from './queue.service';
import { TicketsService } from './tickets.service';
import { LineService } from './line.service';
import { AuditService } from './audit.service';
import { fail } from './errors';
import { FeaturesService } from './features.service';

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

@WebSocketGateway({ namespace: '/hospital', cors: { origin: allowOrigin } })
export class FlowGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private unsubscribe?: () => void;
  constructor(private readonly flowService: FlowService, private readonly liveFeed: LiveFeedService, private readonly queue: QueueService, private readonly auth: AuthService, private readonly tickets: TicketsService, private readonly line: LineService, private readonly audit: AuditService, private readonly features: FeaturesService) {}
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
    client.emit('auth:me', user);
    client.emit('features', this.featureList());
    client.emit('flow:snapshot', this.flowService.snapshot());
    client.emit('live:snapshot', this.liveFeed.snapshot());
    client.emit('queue:events', this.queue.list());
    client.emit('queue:settings', this.queue.getSettings());
  }

  // ---- sign-in -----------------------------------------------------------------------------------------------
  @SubscribeMessage('auth:login')
  login(@ConnectedSocket() client: Socket, @MessageBody() body: { username?: string; password?: string }) {
    if (overLimit(client, 'login')) return SLOW;
    const from = String(client.handshake.headers['x-forwarded-for'] ?? client.handshake.address ?? '');
    const res = this.auth.login(body?.username ?? '', body?.password ?? '', from);
    if (!res.ok) return res;
    client.data.user = res.user;
    return res;
  }
  @SubscribeMessage('auth:logout')
  logout(@ConnectedSocket() client: Socket) {
    this.auth.logout(client.handshake.auth?.token);
    client.data.user = null;
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
    if (res.ok) { this.server.emit('queue:event', res.event); void this.line.onQueueEvent(res.event); }
    return res.ok ? { ok: true } : { ok: false, reason: res.reason };
  }
  // Settings: per-group / per-station overrides for supervisors; everything else for administrators.
  @SubscribeMessage('queue:settings:set')
  queueSettings(@ConnectedSocket() client: Socket, @MessageBody() cmd: SettingsCommand) {
    const me = userOf(client), p = cmd?.patch ?? {};
    if (!me) return SIGN_IN;
    const hospitalWide = p.system !== undefined || p.hours !== undefined || p.demoOffset !== undefined || p.layout !== undefined;
    if (!may(me, hospitalWide ? 'admin' : 'supervisor')) return { ok: false, reason: hospitalWide ? 'เฉพาะผู้ดูแลระบบเปลี่ยนค่าของทั้งโรงพยาบาลได้' : 'เฉพาะหัวหน้างานขึ้นไปเปลี่ยนการตั้งค่าได้' };
    const res = this.queue.setSettings({ ...cmd, by: me.name });
    if (res.ok) this.audit.record({ ...actor(me), action: 'settings.update', targetType: 'settings', targetId: cmd.scope, reason: cmd.summary, meta: { reset: res.reset } });
    // New service hours reset today's log: send every screen the whole log again.
    if (res.ok) { this.server.emit('queue:settings', res.settings); if (res.reset) this.server.emit('queue:events', this.queue.list()); else this.server.emit('queue:event', res.event); }
    return res.ok ? { ok: true } : { ok: false, reason: res.reason };
  }
  // Call this method only from a trusted, authenticated ingestion service.
  publishTrustedUpdate(update: FlowUpdate) {
    const result = this.flowService.apply(update);
    if (result.accepted) this.server.to('campus').emit('flow:update', result.update);
    return result;
  }
}
