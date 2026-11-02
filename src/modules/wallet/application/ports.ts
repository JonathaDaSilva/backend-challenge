import type { Money } from '../../../shared/domain/money';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');
export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');

export interface LedgerPageEntry {
  readonly seq: string;
  readonly kind: string;
  readonly entry: WalletLedgerEntry;
}

export interface LedgerTotals {
  readonly balance: Money;
  readonly entries: number;
}

export interface LedgerQuery {
  page(walletId: string, beforeSeq: string | undefined, limit: number): Promise<LedgerPageEntry[]>;
  totals(walletId: string, currency: string): Promise<LedgerTotals>;
}

export interface WalletReconciliation {
  readonly id: string;
  readonly walletId: string;
  readonly storedBalance: Money;
  readonly calculatedBalance: Money;
  readonly difference: Money;
  readonly consistent: boolean;
  readonly checkedEntries: number;
  readonly checkedAt: Date;
}

export interface ReconciliationRepository {
  insert(reconciliation: WalletReconciliation): Promise<void>;
}

export const LEDGER_QUERY = Symbol('LEDGER_QUERY');
export const RECONCILIATION_REPOSITORY = Symbol('RECONCILIATION_REPOSITORY');
