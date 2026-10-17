import { OnModuleDestroy } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { allowOrigin } from './cors';
import { FlowService, FlowUpdate } from './flow.service';
import { LiveFeedService } from './live-feed.service';
import { QueueService, type QueueCommand, type SettingsCommand } from './queue.service';
@WebSocketGateway({ namespace: '/hospital', cors: { origin: allowOrigin } })
export class FlowGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private unsubscribe?: () => void;
  constructor(private readonly flowService: FlowService, private readonly liveFeed: LiveFeedService, private readonly queue: QueueService) {}
  // Every connected dashboard receives each live snapshot ('live:update').
  afterInit() {
    this.unsubscribe = this.liveFeed.subscribe((snap) => this.server.emit('live:update', snap));
  }
  onModuleDestroy() {
    this.unsubscribe?.();
  }
  handleConnection(client: Socket) {
    // Replace with authenticated session + role/tenant checks before production.
    client.emit('flow:snapshot', this.flowService.snapshot());
    client.emit('live:snapshot', this.liveFeed.snapshot());
    client.emit('queue:events', this.queue.list());
    client.emit('queue:settings', this.queue.getSettings());
  }
  @SubscribeMessage('flow:subscribe')
  subscribe(@ConnectedSocket() client: Socket, @MessageBody() body: { floorId?: string }) {
    // Validate floorId against the authorized scope in production.
    client.join(body?.floorId ? `floor:${body.floorId}` : 'campus');
    return { success: true };
  }
  // Queue staff actions. Every accepted action is broadcast so all consoles, wall TVs and patient pages update.
  // Production: authenticate the user and check they may act for this station before applying.
  @SubscribeMessage('queue:command')
  queueCommand(@MessageBody() cmd: QueueCommand) {
    const res = this.queue.apply(cmd);
    if (res.ok) this.server.emit('queue:event', res.event);
    return res.ok ? { ok: true } : { ok: false, reason: res.reason };
  }
  // Queue assistant settings. Production: only a system admin may change hospital defaults, a department head their groups.
  @SubscribeMessage('queue:settings:set')
  queueSettings(@MessageBody() cmd: SettingsCommand) {
    const res = this.queue.setSettings(cmd);
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
