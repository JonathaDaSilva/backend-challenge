import type { WagerTransaction } from '../domain/wager-transaction';

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');
