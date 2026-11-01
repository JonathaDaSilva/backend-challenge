import { IsolationLevel, TransactionPropagation } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { TransactionRunner } from '../../application/transaction-runner';
import { isRetryableTransactionError } from './pg-errors';

export interface TransactionRetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
}

const DEFAULT_RETRY: TransactionRetryOptions = { maxAttempts: 3, baseDelayMs: 20 };

export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(
    private readonly em: EntityManager,
    private readonly retry: TransactionRetryOptions = DEFAULT_RETRY,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    // getContext(false): o runner também roda fora de requests HTTP (consumer SQS, workers).
    if (this.em.getContext(false).isInTransaction()) {
      return this.em.transactional(() => work(), { propagation: TransactionPropagation.REQUIRED });
    }

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.em.transactional(() => work(), {
          isolationLevel: IsolationLevel.READ_COMMITTED,
        });
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
