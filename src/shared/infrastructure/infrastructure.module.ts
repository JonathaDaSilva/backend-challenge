import { type BeforeApplicationShutdown, Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { CLOCK } from '../application/clock';
import { ID_GENERATOR } from '../application/id-generator';
import { METRICS, STRUCTURED_LOGGER } from '../application/observability';
import { TRANSACTION_RUNNER } from '../application/transaction-runner';
import { type AppConfig, loadConfig } from './config';
import { MikroOrmTransactionRunner } from './database/mikro-orm-transaction-runner';
import { JsonLogger } from './json-logger';
import { LifecycleState } from './lifecycle-state';
import { PromMetrics } from './prom-metrics';
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
      inject: [EntityManager, APP_CONFIG, PromMetrics],
      useFactory: (em: EntityManager, config: AppConfig, metrics: PromMetrics) =>
        new MikroOrmTransactionRunner(em, undefined, config.database, metrics),
    },
    { provide: ID_GENERATOR, useClass: UuidV7IdGenerator },
    { provide: CLOCK, useClass: SystemClock },
    { provide: PromMetrics, useFactory: () => new PromMetrics() },
    { provide: METRICS, useExisting: PromMetrics },
    {
      provide: STRUCTURED_LOGGER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new JsonLogger(config.logLevel),
    },
    { provide: LifecycleState, useFactory: () => new LifecycleState() },
  ],
  exports: [APP_CONFIG, SQS_CLIENT, TRANSACTION_RUNNER, ID_GENERATOR,
    CLOCK,
    METRICS,
    PromMetrics,
    STRUCTURED_LOGGER,
    LifecycleState,
  ],
})
export class InfrastructureModule implements BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(LifecycleState) private readonly lifecycle: LifecycleState,
  ) {}

  beforeApplicationShutdown(): void {
    this.lifecycle.beginShutdown();
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
