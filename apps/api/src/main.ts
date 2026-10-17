import 'reflect-metadata';
import { join } from 'node:path';
// apps/api/.env (git-ignored): ADMIN_USERNAME, ADMIN_PASSWORD, DB_PATH, SESSION_HOURS, WEB_ORIGIN, PORT.
try { process.loadEnvFile(join(__dirname, '..', '.env')); } catch { /* no .env: defaults */ }
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { allowOrigin } from './cors';
import { AppErrorFilter } from './errors';
import { metrics } from './metrics';
async function bootstrap() {
 const app = await NestFactory.create(AppModule, { rawBody: true }); // raw body: LINE webhook signature
 app.enableCors({ origin: allowOrigin });
 app.useGlobalFilters(new AppErrorFilter());
 // A request id on every HTTP request (kept from the proxy when it sends one), for matching logs and audit entries.
 // Also times it (latency and server errors for the report; see metrics.ts).
 app.use((req: { headers: Record<string, unknown>; id?: string }, res: { setHeader: (k: string, v: string) => void; on: (e: 'finish', f: () => void) => void; statusCode: number }, next: () => void) => {
  const started = performance.now();
  res.on('finish', () => metrics.request(performance.now() - started, res.statusCode));
  const given = req.headers['x-request-id'];
  req.id = typeof given === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(given) ? given : randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
 });
 await app.listen(process.env.PORT ?? 4000);
}
bootstrap();
