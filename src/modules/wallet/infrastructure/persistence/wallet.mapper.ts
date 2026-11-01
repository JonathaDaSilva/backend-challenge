import { Money } from '../../../../shared/domain/money';
import { Wallet } from '../../domain/wallet';
import { type LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import type { WalletLedgerEntryRecord } from './wallet-ledger-entry.record';
import type { WalletRecord } from './wallet.record';

export const WalletMapper = {
  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: Money.from({ amount: record.balanceAmount, currency: record.currency }),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },

  toRecord(wallet: Wallet): WalletRecord {
    const state = wallet.toState();
    return {
      id: state.id,
      playerId: state.playerId,
      currency: state.currency,
      balanceAmount: state.balance.toString(),
      version: state.version,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
  },
};

export const LedgerEntryMapper = {
  toDomain(record: WalletLedgerEntryRecord): WalletLedgerEntry {
    const money = (amount: string) => Money.from({ amount, currency: record.currency });
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: record.direction as LedgerDirection,
      money: money(record.amount),
      balanceBefore: money(record.balanceBefore),
      balanceAfter: money(record.balanceAfter),
      walletVersion: record.walletVersion,
      createdAt: record.createdAt,
    });
  },

  toRecord(entry: WalletLedgerEntry): WalletLedgerEntryRecord {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      currency: entry.money.currency,
      direction: entry.direction,
      amount: entry.money.toString(),
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    };
  },
};
