import { Controller, Get } from '@nestjs/common';
import { DbService } from './db.service';

// For the container orchestrator / uptime monitor: is the process up, can it read its database, and is anything
// piling up? Counts only — nothing about any patient.
//   messages.failed > 0 or messages.waiting growing → look at Settings → การแจ้งเตือน
@Controller('health')
export class HealthController {
  constructor(private readonly store: DbService) {}
  @Get()
  check() {
    const row = this.store.db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    const count = (sql: string, at: string) => (this.store.db.prepare(sql).get(at) as { n: number }).n;
    return {
      ok: row?.ok === 1, time: new Date().toISOString(), uptime: Math.round(process.uptime()), schema: this.store.schemaVersion(),
      messages: {
        waiting: count(`SELECT COUNT(*) AS n FROM notification_jobs WHERE status IN ('PENDING','RETRY') AND scheduled_at <= ?`, new Date().toISOString()),
        failed24h: count(`SELECT COUNT(*) AS n FROM notification_jobs WHERE status = 'FAILED' AND updated_at > ?`, new Date(Date.now() - 86_400_000).toISOString()),
      },
    };
  }
}
