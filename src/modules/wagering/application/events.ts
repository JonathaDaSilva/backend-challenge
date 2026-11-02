import { type EventContext, IntegrationEvent } from '../../../shared/application/integration-event';
import type { MoneyProps } from '../../../shared/domain/money';
import type { Wallet } from '../../wallet/domain/wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import type { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';

interface TransactionData {
  transactionId: string;
  providerId: string | undefined;
  externalTransactionId: string | undefined;
  walletId: string;
  playerId: string;
  roundId: string | undefined;
  gameId: string | undefined;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function transactionData(transaction: WagerTransaction): TransactionData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}

export interface WagerTransactionProcessedData extends TransactionData {
  referenceTransactionId: string | undefined;
  balance: MoneyProps | undefined;
  processedAt: string | undefined;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        referenceTransactionId: transaction.referenceTransactionId,
        balance: transaction.resultBalance?.toJSON(),
        processedAt: transaction.processedAt?.toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionData {
  failureCode: string;
  balance: MoneyProps | undefined;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        failureCode: transaction.failureCode ?? '',
        balance: transaction.resultBalance?.toJSON(),
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionData {
  referenceExternalTransactionId: string | undefined;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.id,
      data: { ...transactionData(transaction), referenceExternalTransactionId: transaction.referenceExternalTransactionId },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
