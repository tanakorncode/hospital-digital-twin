import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { DbService } from './db.service';
import { FlowGateway } from './flow.gateway';
import { FlowService } from './flow.service';
import { HealthController } from './health.controller';
import { IngestController } from './ingest.controller';
import { LiveFeedService } from './live-feed.service';
import { QueueService } from './queue.service';
import { TicketsService } from './tickets.service';
@Module({ controllers: [HealthController, IngestController], providers: [DbService, AuthService, FlowGateway, FlowService, LiveFeedService, QueueService, TicketsService] })
export class AppModule {}
