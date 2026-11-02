import type { Clock } from '../../../shared/application/clock';
import type { IdGenerator } from '../../../shared/application/id-generator';
import type { TransactionRunner } from '../../../shared/application/transaction-runner';
import type { Money } from '../../../shared/domain/money';
import type { WalletRepository } from '../../wallet/application/ports';
import { WagerTransaction, type WagerTransactionKind } from '../domain/wager-transaction';
import {
  DuplicateIdempotencyKeyError,
  IdempotencyConflictError,
  UnknownWalletError,
  WalletCurrencyMismatchError,
  WalletPlayerMismatchError,
} from './errors';
import { wagerPayloadHash } from './payload-hash';
import type { WagerTransactionRepository } from './ports';
import type { WagerProcessor } from './wager-processor';

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
  readonly transactions: WagerTransactionRepository;
  readonly processor: WagerProcessor;
  readonly runner: TransactionRunner;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export class SubmitWagerTransactionUseCase {
  constructor(private readonly deps: SubmitWagerTransactionDependencies) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
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
    const { wallets, transactions, processor, ids, clock } = this.deps;

    const wallet = await wallets.findByIdForUpdate(command.walletId);
    if (!wallet) throw new UnknownWalletError(command.walletId);

    const existing = await transactions.findByIdempotencyKey(command.idempotencyKey);
    if (existing) return this.replay(existing, command.idempotencyKey, payloadHash);

    if (wallet.playerId !== command.playerId) throw new WalletPlayerMismatchError(wallet.id);
    if (wallet.currency !== command.money.currency) {
      throw new WalletCurrencyMismatchError(wallet.currency, command.money.currency);
    }

    const at = clock.now();
    const transaction = WagerTransaction.create({ ...command, id: ids.next(), payloadHash, at });
    const expectedVersion = wallet.version;
    const decision = await processor.decide(transaction, wallet, at);
    await processor.persistNew(transaction, wallet, expectedVersion, decision, at);
    await processor.resolveDependents(transaction, wallet, at);

    return { transaction, idempotentReplay: false };
  }

  private replay(existing: WagerTransaction, idempotencyKey: string, payloadHash: string): SubmitWagerTransactionResult {
    if (!existing.matchesPayload(payloadHash)) throw new IdempotencyConflictError(idempotencyKey, existing.id);
    return { transaction: existing, idempotentReplay: true };
  }
}
