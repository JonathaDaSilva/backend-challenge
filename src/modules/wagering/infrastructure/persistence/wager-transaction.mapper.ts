import { Money } from '../../../../shared/domain/money';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction';
import type { WagerTransactionRecord } from './wager-transaction.record';

const orNull = <T>(value: T | undefined): T | null => value ?? null;
const orUndefined = <T>(value: T | null): T | undefined => value ?? undefined;

export const WagerTransactionMapper = {
  toDomain(record: WagerTransactionRecord, referenceTransactionId?: string): WagerTransaction {
    const money = (amount: string) => Money.from({ amount, currency: record.currency });
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: orUndefined(record.providerId),
      externalTransactionId: orUndefined(record.externalTransactionId),
      idempotencyKey: orUndefined(record.idempotencyKey),
      payloadHash: orUndefined(record.payloadHash),
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: orUndefined(record.roundId),
      gameId: orUndefined(record.gameId),
      kind: record.kind as WagerTransactionKind,
      money: money(record.amount),
      referenceExternalTransactionId: orUndefined(record.referenceExternalTransactionId),
      createdAt: record.createdAt,
      status: record.status as WagerTransactionStatus,
      referenceTransactionId,
      failureCode: orUndefined(record.failureCode),
      processedAt: orUndefined(record.processedAt),
      resultBalance: record.resultBalanceAmount === null ? undefined : money(record.resultBalanceAmount),
    });
  },

  toRecord(transaction: WagerTransaction): WagerTransactionRecord {
    const state = transaction.toState();
    return {
      id: state.id,
      providerId: orNull(state.providerId),
      externalTransactionId: orNull(state.externalTransactionId),
      idempotencyKey: orNull(state.idempotencyKey),
      payloadHash: orNull(state.payloadHash),
      walletId: state.walletId,
      playerId: state.playerId,
      currency: state.money.currency,
      roundId: orNull(state.roundId),
      gameId: orNull(state.gameId),
      kind: state.kind,
      amount: state.money.toString(),
      referenceExternalTransactionId: orNull(state.referenceExternalTransactionId),
      status: state.status,
      failureCode: orNull(state.failureCode),
      resultBalanceAmount: state.resultBalance?.toString() ?? null,
      attempts: 0,
      nextAttemptAt: null,
      createdAt: state.createdAt,
      processedAt: orNull(state.processedAt),
    };
  },
};
