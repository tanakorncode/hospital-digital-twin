import { Body, Controller, Headers, HttpCode, HttpException, HttpStatus, Post } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { FlowGateway } from './flow.gateway';
import { LiveFeedService } from './live-feed.service';
import { AuditService } from './audit.service';
import { QueueService, type QueueAction, type QueueCommand } from './queue.service';
import { VisitsService, type EnterInput } from './visits.service';

// Trusted inputs from hospital systems (HIS adapter, kiosks). Server-to-server only, with a shared token:
//   Authorization: Bearer <INGEST_TOKEN>        (apps/api/.env — no token set = ingestion switched off)
// POST /ingest/live   — occupancy and service-point counts (aggregates, no patient data)
// POST /ingest/queue  — a queue action from the HIS (e.g. registration done, called at a room), logged as "HIS"
// POST /ingest/visit, /ingest/visit/step — a registered patient joins the live queue / is sent to a further step
// See docs/HIS-INTEGRATION.md.
const HIS_ACTIONS: QueueAction[] = ['open', 'close', 'call', 'recall', 'start', 'hold', 'return', 'done', 'transfer'];
const digest = (s: string) => createHash('sha256').update(s).digest();
const minuteNow = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

@Controller('ingest')
export class IngestController {
  constructor(private readonly liveFeed: LiveFeedService, private readonly queue: QueueService, private readonly gateway: FlowGateway, private readonly visits: VisitsService, private readonly audit: AuditService) {}

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
    this.gateway.publishQueueEvent(r.event);
    return { ok: true, id: r.event.id };
  }

  // A patient registered in the HIS joins the live queue. sourceId = the HIS visit number (VN): sending the same one
  // again returns the same visit and queue number. Response: { ok, created, visit: { id, queue, … } } — use visit.id as
  // patientId and the step position as `step` in /ingest/queue.
  @Post('visit')
  @HttpCode(200)
  visit(@Headers('authorization') auth: string | undefined, @Body() body: EnterInput & { sourceId?: unknown }) {
    this.authorize(auth);
    if (this.queue.getSettings().dataMode !== 'live') throw new HttpException('the queue is in demo mode (an administrator switches on live data in Settings)', HttpStatus.CONFLICT);
    const { sourceId, ...input } = body ?? {};
    const at = input.at ?? minuteNow();
    const r = this.visits.enter({ ...input, at }, { type: 'HIS', id: sourceId as string });
    if (r.created) { this.audit.record({ actorType: 'his', action: 'visit.enter', targetType: 'visit', targetId: r.visit.id }); this.gateway.server.emit('visit', r.visit); }
    return { ok: true, created: r.created, visit: r.visit };
  }
  // The HIS sends the patient on (doctor's orders): { sourceId, kind } adds a step at the end.
  @Post('visit/step')
  @HttpCode(200)
  visitStep(@Headers('authorization') auth: string | undefined, @Body() body: { sourceId?: unknown; kind?: unknown; at?: unknown }) {
    this.authorize(auth);
    const v = typeof body?.sourceId === 'string' ? this.visits.bySource({ type: 'HIS', id: body.sourceId }) : undefined;
    if (!v) throw new HttpException('unknown visit', HttpStatus.NOT_FOUND);
    const visit = this.visits.addStep(v.id, body.kind, body.at ?? minuteNow());
    this.gateway.server.emit('visit', visit);
    return { ok: true, visit };
  }
}
