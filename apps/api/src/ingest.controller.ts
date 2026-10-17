import { Body, Controller, Headers, HttpCode, HttpException, HttpStatus, Post } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { FlowGateway } from './flow.gateway';
import { LineService } from './line.service';
import { LiveFeedService } from './live-feed.service';
import { QueueService, type QueueAction, type QueueCommand } from './queue.service';

// Trusted inputs from hospital systems (HIS adapter, kiosks). Server-to-server only, with a shared token:
//   Authorization: Bearer <INGEST_TOKEN>        (apps/api/.env — no token set = ingestion switched off)
// POST /ingest/live   — occupancy and service-point counts (aggregates, no patient data)
// POST /ingest/queue  — a queue action from the HIS (e.g. registration done, called at a room), logged as "HIS"
// See docs/HIS-INTEGRATION.md.
const HIS_ACTIONS: QueueAction[] = ['open', 'close', 'call', 'recall', 'start', 'hold', 'return', 'done', 'transfer'];
const digest = (s: string) => createHash('sha256').update(s).digest();

@Controller('ingest')
export class IngestController {
  constructor(private readonly liveFeed: LiveFeedService, private readonly queue: QueueService, private readonly gateway: FlowGateway, private readonly line: LineService) {}

  private authorize(header: string | undefined) {
    const token = process.env.INGEST_TOKEN;
    if (!token) throw new HttpException('ingestion is switched off (set INGEST_TOKEN)', HttpStatus.SERVICE_UNAVAILABLE);
    const given = (header ?? '').replace(/^Bearer\s+/i, '');
    if (!given || !timingSafeEqual(digest(given), digest(token))) throw new HttpException('invalid ingest token', HttpStatus.UNAUTHORIZED);
  }

  @Post('live')
  @HttpCode(200)
  live(@Headers('authorization') auth: string | undefined, @Body() body: unknown) {
    this.authorize(auth);
    const r = this.liveFeed.ingest(body);
    if (!r.ok) throw new HttpException(r.reason, HttpStatus.BAD_REQUEST);
    return r;
  }

  @Post('queue')
  @HttpCode(200)
  queueEvent(@Headers('authorization') auth: string | undefined, @Body() body: QueueCommand) {
    this.authorize(auth);
    if (!body || !HIS_ACTIONS.includes(body.action)) throw new HttpException(`action must be one of ${HIS_ACTIONS.join(', ')}`, HttpStatus.BAD_REQUEST);
    const r = this.queue.apply({ ...body, by: 'HIS', key: body.key });
    if (!r.ok) throw new HttpException(r.reason, HttpStatus.CONFLICT);
    this.gateway.server.emit('queue:event', r.event);
    void this.line.onQueueEvent(r.event);
    return { ok: true, id: r.event.id };
  }
}
