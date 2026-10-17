import { OnModuleDestroy } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthService, type Role, type User } from './auth.service';
import { allowOrigin } from './cors';
import { FlowService, FlowUpdate } from './flow.service';
import { LiveFeedService } from './live-feed.service';
import { QueueService, type QueueCommand, type SettingsCommand } from './queue.service';

// Who may do what. Public screens (TV boards, the patient's QR page) connect without signing in: they receive the
// queue log and may only send a patient's help request ('report').
//  staff       — station actions (call, start, done, hold, move…), take on help requests
//  supervisor  — + per-department / per-station assistant settings
//  admin       — + hospital-wide settings, service hours, layout, test clock, user accounts
const SYSTEM_BY = 'ระบบ';
const rank: Record<Role, number> = { staff: 1, supervisor: 2, admin: 3 };
const may = (u: User | null, role: Role) => !!u && rank[u.role] >= rank[role];
const userOf = (c: Socket) => (c.data.user ?? null) as User | null;
const DENIED = { ok: false, reason: 'ไม่มีสิทธิ์ทำรายการนี้' };
const SIGN_IN = { ok: false, reason: 'กรุณาเข้าสู่ระบบก่อน', auth: true };

@WebSocketGateway({ namespace: '/hospital', cors: { origin: allowOrigin } })
export class FlowGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private unsubscribe?: () => void;
  constructor(private readonly flowService: FlowService, private readonly liveFeed: LiveFeedService, private readonly queue: QueueService, private readonly auth: AuthService) {}
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
    client.emit('flow:snapshot', this.flowService.snapshot());
    client.emit('live:snapshot', this.liveFeed.snapshot());
    client.emit('queue:events', this.queue.list());
    client.emit('queue:settings', this.queue.getSettings());
  }

  // ---- sign-in -----------------------------------------------------------------------------------------------
  @SubscribeMessage('auth:login')
  login(@ConnectedSocket() client: Socket, @MessageBody() body: { username?: string; password?: string }) {
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
    return res.ok ? { ok: true, user: res.user, users: this.auth.list() } : res;
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
    if (cmd?.action === 'report') cmd = { ...cmd, by: undefined }; // a patient's help request: no account needed
    else if (!me) return SIGN_IN;
    else if (!may(me, 'staff')) return DENIED;
    // The audit trail names the signed-in user (not a name typed on the screen); the assistant's automatic moves stay "ระบบ".
    else cmd = { ...cmd, by: cmd.by === SYSTEM_BY ? SYSTEM_BY : me.name };
    const res = this.queue.apply(cmd);
    if (res.ok) this.server.emit('queue:event', res.event);
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
