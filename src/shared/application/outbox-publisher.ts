import type { RetryBackoff } from '../domain/outbox-message';
import type { EventPublisher, OutboxRepository } from './outbox';
import type { TransactionRunner } from './transaction-runner';

export interface OutboxBackoffOptions {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export class OutboxBackoff implements RetryBackoff {
  constructor(
    private readonly options: OutboxBackoffOptions,
    private readonly random: () => number = Math.random,
  ) {}

  delayMs(attempts: number): number {
    const ceiling = Math.min(this.options.baseDelayMs * 2 ** (attempts - 1), this.options.maxDelayMs);
    return Math.round(ceiling / 2 + (this.random() * ceiling) / 2);
  }
}

export interface OutboxPublisherDependencies {
  readonly outbox: OutboxRepository;
  readonly publisher: EventPublisher;
  readonly runner: TransactionRunner;
  readonly backoff: RetryBackoff;
  readonly batchSize: number;
}

export class OutboxPublisher {
  constructor(private readonly deps: OutboxPublisherDependencies) {}

  async processDue(now: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const published = await this.deps.runner.run(() => this.publishBatch(now));
      total += published;
      if (published < this.deps.batchSize) return total;
    }
  }

  nextDueAt(): Promise<Date | undefined> {
    return this.deps.outbox.nextDueAt();
  }

  private async publishBatch(now: Date): Promise<number> {
    const due = await this.deps.outbox.claimDue(now, this.deps.batchSize);
    if (due.length === 0) return 0;

    let failed: ReadonlySet<string>;
    try {
      ({ failed } = await this.deps.publisher.publish(due));
    } catch {
      failed = new Set(due.map((message) => message.id));
    }

    for (const message of due) {
      if (failed.has(message.id)) message.scheduleRetry(now, this.deps.backoff);
      else message.markPublished(now);
    }
    await this.deps.outbox.save(due);
    return due.length;
  }
}
