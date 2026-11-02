import type { Clock } from '../../../shared/application/clock';
import type { CorrelationContext } from '../../../shared/application/correlation';
import type { IdGenerator } from '../../../shared/application/id-generator';
import { MetricNames, type Metrics } from '../../../shared/application/observability';
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
  readonly metrics: Metrics;
  readonly context: CorrelationContext;
}

export class SubmitWagerTransactionUseCase {
  constructor(private readonly deps: SubmitWagerTransactionDependencies) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
    const { metrics, context } = this.deps;
    context.annotate({ providerId: command.providerId, walletId: command.walletId });
    const payloadHash = wagerPayloadHash({ ...command, money: command.money.toJSON() });
    const started = performance.now();

    try {
      return await this.deps.runner.run(() => this.submit(command, payloadHash));
    } catch (error) {
      if (!(error instanceof DuplicateIdempotencyKeyError)) throw error;
      const existing = await this.deps.transactions.findByIdempotencyKey(command.idempotencyKey);
      if (!existing) throw error;
      return this.replay(existing, command.idempotencyKey, payloadHash);
    } finally {
      metrics.observe(
        MetricNames.WagerProcessingDuration,
        { source: context.value('source') ?? 'unknown', kind: command.kind },
        (performance.now() - started) / 1000,
      );
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
    this.deps.context.annotate({ transactionId: transaction.id });
    const expectedVersion = wallet.version;
    const decision = await processor.decide(transaction, wallet, at);
    await processor.persistNew(transaction, wallet, expectedVersion, decision, at);
    await processor.resolveDependents(transaction, wallet, at);

    return { transaction, idempotentReplay: false };
  }

  private replay(existing: WagerTransaction, idempotencyKey: string, payloadHash: string): SubmitWagerTransactionResult {
    this.deps.context.annotate({ transactionId: existing.id });
    if (!existing.matchesPayload(payloadHash)) throw new IdempotencyConflictError(idempotencyKey, existing.id);
    this.deps.metrics.increment(MetricNames.WagerDuplicates, { type: 'idempotent_replay' });
    return { transaction: existing, idempotentReplay: true };
  }
}
