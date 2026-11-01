import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { TRANSACTION_RUNNER } from '../application/transaction-runner';
import { type AppConfig, loadConfig } from './config';
import { MikroOrmTransactionRunner } from './database/mikro-orm-transaction-runner';
import { createSqsClient } from './sqs/sqs.client';
import { APP_CONFIG, SQS_CLIENT } from './tokens';

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
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new MikroOrmTransactionRunner(em),
    },
  ],
  exports: [APP_CONFIG, SQS_CLIENT, TRANSACTION_RUNNER],
})
export class InfrastructureModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
