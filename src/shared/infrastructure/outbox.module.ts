import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Global,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { CLOCK, type Clock } from '../application/clock';
import { CORRELATION_CONTEXT, type CorrelationContext } from '../application/correlation';
import { EventRecorder } from '../application/event-recorder';
import { ID_GENERATOR, type IdGenerator } from '../application/id-generator';
import { METRICS, type Metrics } from '../application/observability';
import { EVENT_PUBLISHER, type EventPublisher, OUTBOX_REPOSITORY, type OutboxRepository } from '../application/outbox';
import { OutboxBackoff, OutboxPublisher } from '../application/outbox-publisher';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../application/transaction-runner';
import { AsyncCorrelationContext } from './async-correlation-context';
import type { AppConfig } from './config';
import { DeadlineScheduler } from './database/deadline-scheduler';
import { LifecycleState } from './lifecycle-state';
import { PromMetrics } from './prom-metrics';
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
      inject: [OUTBOX_REPOSITORY, EVENT_PUBLISHER, TRANSACTION_RUNNER, APP_CONFIG, METRICS],
      useFactory: (
        outbox: OutboxRepository,
        publisher: EventPublisher,
        runner: TransactionRunner,
        config: AppConfig,
        metrics: Metrics,
      ) =>
        new OutboxPublisher({
          outbox,
          publisher,
          runner,
          backoff: new OutboxBackoff(config.events),
          batchSize: config.events.batchSize,
          metrics,
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
export class OutboxModule implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(OUTBOX_SCHEDULER) private readonly scheduler: DeadlineScheduler,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PromMetrics) private readonly metrics: PromMetrics,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LifecycleState) private readonly lifecycle: LifecycleState,
  ) {}

  onModuleInit(): void {
    const stats = () => this.outbox.stats(this.clock.now());
    this.metrics.registerGauge('outbox_pending_events', 'Outbox events not yet published', async () => (await stats()).pending);
    this.metrics.registerGauge(
      'outbox_oldest_pending_age_seconds',
      'Age of the oldest unpublished outbox event (outbox lag)',
      async () => (await stats()).oldestPendingAgeSeconds,
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.events.publisherEnabled) await this.scheduler.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.lifecycle.beginShutdown();
    await this.scheduler.stop();
  }
}
