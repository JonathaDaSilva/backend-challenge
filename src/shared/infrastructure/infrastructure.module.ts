import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { CLOCK } from '../application/clock';
import { ID_GENERATOR } from '../application/id-generator';
import { METRICS, STRUCTURED_LOGGER } from '../application/observability';
import { TRANSACTION_RUNNER } from '../application/transaction-runner';
import { type AppConfig, loadConfig } from './config';
import { MikroOrmTransactionRunner } from './database/mikro-orm-transaction-runner';
import { InMemoryMetrics } from './in-memory-metrics';
import { NestStructuredLogger } from './nest-structured-logger';
import { createSqsClient } from './sqs/sqs.client';
import { SystemClock } from './system-clock';
import { APP_CONFIG, SQS_CLIENT } from './tokens';
import { UuidV7IdGenerator } from './uuid-v7-id-generator';

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: loadConfig },
    {
      provide: SQS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createSqsClient(config.aws),
    },
    {
      provide: TRANSACTION_RUNNER,
      inject: [EntityManager, APP_CONFIG],
      useFactory: (em: EntityManager, config: AppConfig) =>
        new MikroOrmTransactionRunner(em, undefined, config.database),
    },
    { provide: ID_GENERATOR, useClass: UuidV7IdGenerator },
    { provide: CLOCK, useClass: SystemClock },
    { provide: METRICS, useClass: InMemoryMetrics },
    { provide: STRUCTURED_LOGGER, useClass: NestStructuredLogger },
  ],
  exports: [APP_CONFIG, SQS_CLIENT, TRANSACTION_RUNNER, ID_GENERATOR, CLOCK, METRICS, STRUCTURED_LOGGER],
})
export class InfrastructureModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
