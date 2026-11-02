import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Global,
  Inject,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { CLOCK, type Clock } from '../application/clock';
import { CORRELATION_CONTEXT, type CorrelationContext } from '../application/correlation';
import { EventRecorder } from '../application/event-recorder';
import { ID_GENERATOR, type IdGenerator } from '../application/id-generator';
import { EVENT_PUBLISHER, type EventPublisher, OUTBOX_REPOSITORY, type OutboxRepository } from '../application/outbox';
import { OutboxBackoff, OutboxPublisher } from '../application/outbox-publisher';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../application/transaction-runner';
import { AsyncCorrelationContext } from './async-correlation-context';
import type { AppConfig } from './config';
import { DeadlineScheduler } from './database/deadline-scheduler';
import { SqsEventPublisher } from './sqs/sqs-event-publisher';
import { APP_CONFIG, SQS_CLIENT } from './tokens';

export const OUTBOX_SCHEDULER = Symbol('OUTBOX_SCHEDULER');

@Global()
@Module({
  providers: [
    { provide: CORRELATION_CONTEXT, useClass: AsyncCorrelationContext },
    {
      provide: EventRecorder,
      inject: [OUTBOX_REPOSITORY, ID_GENERATOR, CLOCK, CORRELATION_CONTEXT],
      useFactory: (outbox: OutboxRepository, ids: IdGenerator, clock: Clock, correlation: CorrelationContext) =>
        new EventRecorder(outbox, ids, clock, correlation),
    },
    {
      provide: EVENT_PUBLISHER,
      inject: [SQS_CLIENT, APP_CONFIG],
      useFactory: (sqs: SQSClient, config: AppConfig) => new SqsEventPublisher(sqs, config.events.queueName),
    },
    {
      provide: OutboxPublisher,
      inject: [OUTBOX_REPOSITORY, EVENT_PUBLISHER, TRANSACTION_RUNNER, APP_CONFIG],
      useFactory: (outbox: OutboxRepository, publisher: EventPublisher, runner: TransactionRunner, config: AppConfig) =>
        new OutboxPublisher({
          outbox,
          publisher,
          runner,
          backoff: new OutboxBackoff(config.events),
          batchSize: config.events.batchSize,
        }),
    },
    {
      provide: OUTBOX_SCHEDULER,
      inject: [OutboxPublisher, CLOCK, APP_CONFIG],
      useFactory: (publisher: OutboxPublisher, clock: Clock, config: AppConfig) =>
        new DeadlineScheduler('outbox', publisher, clock, config.databaseUrl),
    },
  ],
  exports: [CORRELATION_CONTEXT, EventRecorder, OutboxPublisher],
})
export class OutboxModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(OUTBOX_SCHEDULER) private readonly scheduler: DeadlineScheduler,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.events.publisherEnabled) await this.scheduler.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.scheduler.stop();
  }
}
