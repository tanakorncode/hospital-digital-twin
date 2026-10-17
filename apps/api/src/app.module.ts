import { Module } from '@nestjs/common';
import { FlowGateway } from './flow.gateway';
import { FlowService } from './flow.service';
import { LiveFeedService } from './live-feed.service';
import { QueueService } from './queue.service';
@Module({ providers: [FlowGateway, FlowService, LiveFeedService, QueueService] })
export class AppModule {}
