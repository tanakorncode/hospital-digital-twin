import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { allowOrigin } from './cors';
async function bootstrap() {
 const app = await NestFactory.create(AppModule);
 app.enableCors({ origin: allowOrigin });
 await app.listen(process.env.PORT ?? 4000);
}
bootstrap();
