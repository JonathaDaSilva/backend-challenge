import { IsolationLevel, TransactionPropagation } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { TransactionRunner } from '../../application/transaction-runner';
import { isRetryableTransactionError } from './pg-errors';

export interface TransactionRetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
}

const DEFAULT_RETRY: TransactionRetryOptions = { maxAttempts: 3, baseDelayMs: 20 };

/**
 * em.transactional() stores the transactional fork in an AsyncLocalStorage
 * (TransactionContext), so repositories holding the global EntityManager
 * resolve to it automatically through em.execute(), query builders and
 * getKysely(). em.getConnection().execute() bypasses that context and must not
 * be used for writes inside a unit of work.
 */
export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(
    private readonly em: EntityManager,
    private readonly retry: TransactionRetryOptions = DEFAULT_RETRY,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    // A nested run joins the outer transaction. Retrying here would be useless:
    // once PostgreSQL aborts a transaction, only the outermost run can restart it.
    // getContext(false) skips the global-context guard: runs also start outside
    // HTTP requests (SQS consumer, schedulers), where there is no RequestContext.
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

  // Exponential backoff with full jitter, so colliding transactions do not retry in lockstep.
  private backoff(attempt: number): number {
    return Math.random() * this.retry.baseDelayMs * 2 ** (attempt - 1);
  }
}
