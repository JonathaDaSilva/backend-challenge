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
