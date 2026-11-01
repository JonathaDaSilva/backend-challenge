import type { IdGenerator } from '../../../shared/application/id-generator';
import type { LedgerRepository, WalletRepository } from '../../wallet/application/ports';
import { InsufficientFundsError } from '../../wallet/domain/errors';
import type { Wallet } from '../../wallet/domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { FailureCode } from '../domain/failure-codes';
import { type WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import type { PendingReferencePolicy } from './pending-reference-policy';
import type { WagerTransactionRepository } from './ports';

export interface Decision {
  readonly pending: boolean;
  readonly entry?: WalletLedgerEntry;
  readonly referenceId?: string;
}

export interface WagerProcessorDependencies {
  readonly wallets: WalletRepository;
  readonly ledger: LedgerRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ids: IdGenerator;
  readonly policy: PendingReferencePolicy;
}

// Todos os métodos assumem que a wallet já está travada pelo chamador (SELECT … FOR UPDATE).
export class WagerProcessor {
  constructor(private readonly deps: WagerProcessorDependencies) {}

  async decide(transaction: WagerTransaction, wallet: Wallet, at: Date): Promise<Decision> {
    if (!transaction.affectsBalance()) {
      transaction.markProcessed(undefined, at, wallet.balance);
      return { pending: false };
    }

    let reference: WagerTransaction | undefined;
    if (transaction.requiresReference()) {
      reference = await this.deps.transactions.findByProviderAndExternalId(
        transaction.providerId ?? '',
        transaction.referenceExternalTransactionId ?? '',
      );
      const check = reference ? transaction.checkReversalOf(reference) : 'WAIT';
      if (check === 'WAIT') {
        if (transaction.status === WagerTransactionStatus.Pending) transaction.markPendingReference(wallet.balance);
        return { pending: true };
      }
      if (check !== 'OK') {
        transaction.reject(check, wallet.balance);
        return { pending: false };
      }
      if (reference && (await this.deps.transactions.isReversed(reference.id))) {
        transaction.reject(FailureCode.AlreadyReversed, wallet.balance);
        return { pending: false };
      }
    }

    const movement = { entryId: this.deps.ids.next(), transactionId: transaction.id, money: transaction.money, at };
    let entry: WalletLedgerEntry;
    try {
      entry =
        transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(movement)
          : wallet.credit(movement);
    } catch (error) {
      if (!(error instanceof InsufficientFundsError)) throw error;
      transaction.reject(reference ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds, wallet.balance);
      return { pending: false };
    }

    transaction.markProcessed(reference?.id, at, wallet.balance);
    return reference ? { pending: false, entry, referenceId: reference.id } : { pending: false, entry };
  }

  async persistNew(transaction: WagerTransaction, wallet: Wallet, expectedVersion: number, decision: Decision, at: Date) {
    const schedule = decision.pending
      ? { attempts: 0, nextAttemptAt: this.deps.policy.nextAttemptAt(at, 0) }
      : undefined;
    await this.deps.transactions.insert(transaction, schedule);
    await this.persistEffects(transaction, wallet, expectedVersion, decision, at);
  }

  async persistResolved(
    transaction: WagerTransaction,
    wallet: Wallet,
    expectedVersion: number,
    decision: Decision,
    at: Date,
  ): Promise<void> {
    await this.deps.transactions.update(transaction);
    await this.persistEffects(transaction, wallet, expectedVersion, decision, at);
  }

  async resolveDependents(reference: WagerTransaction, wallet: Wallet, at: Date): Promise<void> {
    if (reference.status !== WagerTransactionStatus.Processed) return;
    if (!reference.providerId || !reference.externalTransactionId) return;

    const pending = await this.deps.transactions.findPendingByReference(
      reference.providerId,
      reference.externalTransactionId,
    );
    for (const dependent of pending) {
      if (dependent.walletId !== wallet.id) continue;
      const expectedVersion = wallet.version;
      const decision = await this.decide(dependent, wallet, at);
      if (decision.pending) continue;
      await this.persistResolved(dependent, wallet, expectedVersion, decision, at);
      await this.resolveDependents(dependent, wallet, at);
    }
  }

  private async persistEffects(
    transaction: WagerTransaction,
    wallet: Wallet,
    expectedVersion: number,
    decision: Decision,
    at: Date,
  ): Promise<void> {
    if (!decision.entry) return;
    await this.deps.wallets.saveBalance(wallet, expectedVersion);
    await this.deps.ledger.append(decision.entry);
    if (decision.referenceId) await this.deps.transactions.linkReversal(transaction, decision.referenceId, at);
  }
}
