import { Controller, Get } from '@nestjs/common';
import { DbService } from './db.service';

// For the container orchestrator / uptime monitor: is the process up and can it read its database?
@Controller('health')
export class HealthController {
  constructor(private readonly store: DbService) {}
  @Get()
  check() {
    const row = this.store.db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    return { ok: row?.ok === 1, time: new Date().toISOString(), uptime: Math.round(process.uptime()) };
  }
}
