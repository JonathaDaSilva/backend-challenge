import type { TransactionRunner } from '../../../shared/application/transaction-runner';
import type { WalletRepository } from '../../wallet/application/ports';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import type { PendingReferencePolicy } from './pending-reference-policy';
import type { DuePendingReference, WagerTransactionRepository } from './ports';
import type { WagerProcessor } from './wager-processor';

export interface PendingReferenceWorkerDependencies {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly processor: WagerProcessor;
  readonly runner: TransactionRunner;
  readonly policy: PendingReferencePolicy;
  readonly batchSize: number;
}

export type RetryOutcome = 'resolved' | 'rescheduled' | 'expired' | 'skipped';

export class PendingReferenceWorker {
  constructor(private readonly deps: PendingReferenceWorkerDependencies) {}

  async processDue(now: Date): Promise<RetryOutcome[]> {
    const outcomes: RetryOutcome[] = [];
    for (;;) {
      const due = await this.deps.transactions.findDuePendingReferences(now, this.deps.batchSize);
      const batch: RetryOutcome[] = [];
      for (const pending of due) batch.push(await this.deps.runner.run(() => this.retry(pending, now)));
      outcomes.push(...batch);
      if (due.length < this.deps.batchSize || batch.every((outcome) => outcome === 'skipped')) return outcomes;
    }
  }

  nextDueAt(): Promise<Date | undefined> {
    return this.deps.transactions.nextPendingReferenceDueAt();
  }

  private async retry(pending: DuePendingReference, now: Date): Promise<RetryOutcome> {
    const { wallets, transactions, processor, policy } = this.deps;

    const wallet = await wallets.findByIdForUpdate(pending.walletId);
    const transaction = await transactions.findById(pending.id);
    const schedule = await transactions.findPendingSchedule(pending.id);
    if (!wallet || !transaction || !schedule || transaction.status !== WagerTransactionStatus.PendingReference) {
      return 'skipped';
    }
    if (schedule.nextAttemptAt > now) return 'skipped';

    const expectedVersion = wallet.version;
    const decision = await processor.decide(transaction, wallet, now);

    if (decision.pending) {
      const attempts = schedule.attempts + 1;
      if (!policy.isExhausted(attempts)) {
        await transactions.reschedule(transaction.id, { attempts, nextAttemptAt: policy.nextAttemptAt(now, attempts) });
        return 'rescheduled';
      }
      await processor.expire(transaction, wallet);
      return 'expired';
    }

    await processor.persistResolved(transaction, wallet, expectedVersion, decision, now);
    await processor.resolveDependents(transaction, wallet, now);
    return 'resolved';
  }
}
