import 'reflect-metadata';
import { join } from 'node:path';
// apps/api/.env (git-ignored): ADMIN_USERNAME, ADMIN_PASSWORD, DB_PATH, SESSION_HOURS, WEB_ORIGIN, PORT.
try { process.loadEnvFile(join(__dirname, '..', '.env')); } catch { /* no .env: defaults */ }
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { allowOrigin } from './cors';
async function bootstrap() {
 const app = await NestFactory.create(AppModule, { rawBody: true }); // raw body: LINE webhook signature
 app.enableCors({ origin: allowOrigin });
 await app.listen(process.env.PORT ?? 4000);
}
bootstrap();
