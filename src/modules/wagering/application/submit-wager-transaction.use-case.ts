import type { Clock } from '../../../shared/application/clock';
import type { IdGenerator } from '../../../shared/application/id-generator';
import type { TransactionRunner } from '../../../shared/application/transaction-runner';
import type { Money } from '../../../shared/domain/money';
import { WalletNotFoundError } from '../../wallet/application/errors';
import type { LedgerRepository, WalletRepository } from '../../wallet/application/ports';
import { InsufficientFundsError } from '../../wallet/domain/errors';
import type { Wallet } from '../../wallet/domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import {
  DuplicateIdempotencyKeyError,
  IdempotencyConflictError,
  UnsupportedKindError,
  WalletCurrencyMismatchError,
  WalletPlayerMismatchError,
} from './errors';
import { wagerPayloadHash } from './payload-hash';
import type { WagerTransactionRepository } from './ports';

export interface SubmitWagerTransactionCommand {
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
}

export interface SubmitWagerTransactionResult {
  readonly transaction: WagerTransaction;
  readonly idempotentReplay: boolean;
}

export interface SubmitWagerTransactionDependencies {
  readonly wallets: WalletRepository;
  readonly ledger: LedgerRepository;
  readonly transactions: WagerTransactionRepository;
  readonly runner: TransactionRunner;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

const SUPPORTED_KINDS = new Set([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss]);

export const FailureCodes = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
} as const;

export class SubmitWagerTransactionUseCase {
  constructor(private readonly deps: SubmitWagerTransactionDependencies) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
    if (!SUPPORTED_KINDS.has(command.kind)) throw new UnsupportedKindError(command.kind);

    const payloadHash = wagerPayloadHash({ ...command, money: command.money.toJSON() });

    try {
      return await this.deps.runner.run(() => this.submit(command, payloadHash));
    } catch (error) {
      if (!(error instanceof DuplicateIdempotencyKeyError)) throw error;
      const existing = await this.deps.transactions.findByIdempotencyKey(command.idempotencyKey);
      if (!existing) throw error;
      return this.replay(existing, command.idempotencyKey, payloadHash);
    }
  }

  private async submit(command: SubmitWagerTransactionCommand, payloadHash: string) {
    const { wallets, transactions, ids, clock } = this.deps;

    const wallet = await wallets.findByIdForUpdate(command.walletId);
    if (!wallet) throw new WalletNotFoundError(command.walletId);

    const existing = await transactions.findByIdempotencyKey(command.idempotencyKey);
    if (existing) return this.replay(existing, command.idempotencyKey, payloadHash);

    if (wallet.playerId !== command.playerId) throw new WalletPlayerMismatchError(wallet.id);
    if (wallet.currency !== command.money.currency) {
      throw new WalletCurrencyMismatchError(wallet.currency, command.money.currency);
    }

    const at = clock.now();
    const transaction = WagerTransaction.create({ ...command, id: ids.next(), payloadHash, at });

    if (transaction.affectsBalance()) {
      await this.applyMovement(wallet, transaction, at);
    } else {
      transaction.markProcessed(undefined, at, wallet.balance);
      await transactions.insert(transaction);
    }

    return { transaction, idempotentReplay: false };
  }

  private async applyMovement(wallet: Wallet, transaction: WagerTransaction, at: Date): Promise<void> {
    const expectedVersion = wallet.version;
    const movement = { entryId: this.deps.ids.next(), transactionId: transaction.id, money: transaction.money, at };

    let entry: WalletLedgerEntry;
    try {
      entry =
        transaction.ledgerDirectionFor() === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    } catch (error) {
      if (!(error instanceof InsufficientFundsError)) throw error;
      transaction.reject(FailureCodes.InsufficientFunds, wallet.balance);
      await this.deps.transactions.insert(transaction);
      return;
    }

    transaction.markProcessed(undefined, at, wallet.balance);
    await this.deps.transactions.insert(transaction);
    await this.deps.wallets.saveBalance(wallet, expectedVersion);
    await this.deps.ledger.append(entry);
  }

  private replay(existing: WagerTransaction, idempotencyKey: string, payloadHash: string): SubmitWagerTransactionResult {
    if (!existing.matchesPayload(payloadHash)) throw new IdempotencyConflictError(idempotencyKey, existing.id);
    return { transaction: existing, idempotentReplay: true };
  }
}
