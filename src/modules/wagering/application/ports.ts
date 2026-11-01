import type { WagerTransaction } from '../domain/wager-transaction';

export interface PendingSchedule {
  readonly attempts: number;
  readonly nextAttemptAt: Date;
}

export interface DuePendingReference {
  readonly id: string;
  readonly walletId: string;
}

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction, schedule?: PendingSchedule): Promise<void>;
  update(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  findPendingByReference(providerId: string, referenceExternalTransactionId: string): Promise<WagerTransaction[]>;
  findDuePendingReferences(now: Date, limit: number): Promise<DuePendingReference[]>;
  findPendingSchedule(id: string): Promise<PendingSchedule | undefined>;
  nextPendingReferenceDueAt(): Promise<Date | undefined>;
  reschedule(id: string, schedule: PendingSchedule): Promise<void>;
  isReversed(referenceTransactionId: string): Promise<boolean>;
  linkReversal(reversal: WagerTransaction, referenceTransactionId: string, at: Date): Promise<void>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');
