import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './shared/infrastructure/config';
import { JsonLogger } from './shared/infrastructure/json-logger';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { logger: new JsonLogger(config.logLevel) });
  app.enableShutdownHooks();
  await app.listen(config.port);
}

void bootstrap();
