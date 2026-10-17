import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuthService } from './auth.service';
import { BookingService } from './booking.service';
import { DbService } from './db.service';
import { FeaturesService } from './features.service';
import { FlowGateway } from './flow.gateway';
import { FlowService } from './flow.service';
import { HealthController } from './health.controller';
import { IdempotencyService } from './idempotency.service';
import { IngestController } from './ingest.controller';
import { LineController } from './line.controller';
import { LineService } from './line.service';
import { LiveFeedService } from './live-feed.service';
import { QueueService } from './queue.service';
import { TicketsService } from './tickets.service';
import { VisitsService } from './visits.service';
@Module({ controllers: [HealthController, IngestController, LineController], providers: [DbService, AuditService, IdempotencyService, FeaturesService, AuthService, FlowGateway, FlowService, LiveFeedService, QueueService, TicketsService, LineService, VisitsService, BookingService] })
export class AppModule {}
