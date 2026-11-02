import { IsolationLevel, TransactionPropagation } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { RunOptions, TransactionRunner } from '../../application/transaction-runner';
import { isRetryableTransactionError } from './pg-errors';

export interface TransactionRetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
}

export interface TransactionTimeouts {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

const DEFAULT_RETRY: TransactionRetryOptions = { maxAttempts: 3, baseDelayMs: 20 };
const DEFAULT_TIMEOUTS: TransactionTimeouts = { lockTimeoutMs: 2000, statementTimeoutMs: 5000 };

export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(
    private readonly em: EntityManager,
    private readonly retry: TransactionRetryOptions = DEFAULT_RETRY,
    private readonly timeouts: TransactionTimeouts = DEFAULT_TIMEOUTS,
  ) {}

  async run<T>(work: () => Promise<T>, options: RunOptions = {}): Promise<T> {
    // getContext(false): o runner também roda fora de requests HTTP (consumer SQS, workers).
    if (this.em.getContext(false).isInTransaction()) {
      return this.em.transactional(() => work(), { propagation: TransactionPropagation.REQUIRED });
    }

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.em.transactional(
          async (em) => {
            await em.execute("select set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)", [
              `${this.timeouts.lockTimeoutMs}ms`,
              `${this.timeouts.statementTimeoutMs}ms`,
            ]);
            return work();
          },
          options.snapshot
            ? { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true }
            : { isolationLevel: IsolationLevel.READ_COMMITTED },
        );
      } catch (error) {
        if (attempt >= this.retry.maxAttempts || !isRetryableTransactionError(error)) throw error;
        await Bun.sleep(this.backoff(attempt));
      }
    }
  }

  private backoff(attempt: number): number {
    return Math.random() * this.retry.baseDelayMs * 2 ** (attempt - 1);
  }
}
