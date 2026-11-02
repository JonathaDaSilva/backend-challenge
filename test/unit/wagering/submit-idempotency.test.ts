import { describe, expect, test } from 'bun:test';
import { IdempotencyConflictError } from '../../../src/modules/wagering/application/errors';
import { wagerPayloadHash } from '../../../src/modules/wagering/application/payload-hash';
import type { WagerTransactionRepository } from '../../../src/modules/wagering/application/ports';
import {
  type SubmitWagerTransactionCommand,
  SubmitWagerTransactionUseCase,
} from '../../../src/modules/wagering/application/submit-wager-transaction.use-case';
import type { WagerProcessor } from '../../../src/modules/wagering/application/wager-processor';
import { WagerTransaction, WagerTransactionKind } from '../../../src/modules/wagering/domain/wager-transaction';
import type { WalletRepository } from '../../../src/modules/wallet/application/ports';
import { Wallet } from '../../../src/modules/wallet/domain/wallet';
import type { CorrelationContext } from '../../../src/shared/application/correlation';
import type { Metrics } from '../../../src/shared/application/observability';
import type { TransactionRunner } from '../../../src/shared/application/transaction-runner';
import { Money } from '../../../src/shared/domain/money';

const at = new Date('2026-11-02T10:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const command = (amount: string): SubmitWagerTransactionCommand => ({
  idempotencyKey: 'provider-a:ext-1',
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: brl(amount),
  referenceExternalTransactionId: undefined,
});

function useCaseWith(existing: WagerTransaction) {
  const { wallet } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('100.00'),
    openingTransactionId: 'opening',
    openingEntryId: 'entry',
    at,
  });
  const processed: string[] = [];
  const counted: string[] = [];
  const useCase = new SubmitWagerTransactionUseCase({
    wallets: { findByIdForUpdate: async () => wallet } as unknown as WalletRepository,
    transactions: { findByIdempotencyKey: async () => existing } as unknown as WagerTransactionRepository,
    processor: {
      decide: () => {
        processed.push('decide');
        return Promise.resolve({ pending: false });
      },
    } as unknown as WagerProcessor,
    runner: { run: (work) => work() } satisfies TransactionRunner,
    ids: { next: () => 'new-id' },
    clock: { now: () => at },
    metrics: { increment: (name: string) => counted.push(name), observe: () => undefined } as Metrics,
    context: { currentCorrelationId: () => undefined, value: () => undefined, annotate: () => undefined } satisfies CorrelationContext,
  });
  return { useCase, processed, counted };
}

function stored(amount: string): WagerTransaction {
  const original = command(amount);
  const transaction = WagerTransaction.create({
    ...original,
    id: 'tx-original',
    payloadHash: wagerPayloadHash({ ...original, money: original.money.toJSON() }),
    at,
  });
  transaction.markProcessed(undefined, at, brl('75.00'));
  return transaction;
}

describe('idempotency in SubmitWagerTransactionUseCase', () => {
  test('the same key with the same payload replays the stored result without processing again', async () => {
    const { useCase, processed, counted } = useCaseWith(stored('25.00'));
    const result = await useCase.execute(command('25.00'));

    expect(result.idempotentReplay).toBe(true);
    expect(result.transaction.id).toBe('tx-original');
    expect(result.transaction.resultBalance?.toString()).toBe('75.00');
    expect(processed).toEqual([]);
    expect(counted).toContain('wager_duplicates_total');
  });

  test('the same key with a divergent payload is a conflict, not a replay', async () => {
    const { useCase, processed } = useCaseWith(stored('25.00'));

    const attempt = useCase.execute(command('26.00'));
    await expect(attempt).rejects.toBeInstanceOf(IdempotencyConflictError);
    await attempt.catch((error: IdempotencyConflictError) => expect(error.transactionId).toBe('tx-original'));
    expect(processed).toEqual([]);
  });
});
