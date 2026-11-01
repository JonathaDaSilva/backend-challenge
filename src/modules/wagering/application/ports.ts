import type { WagerTransaction } from '../domain/wager-transaction';

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');
