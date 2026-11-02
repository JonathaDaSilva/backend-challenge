import type { FilterQuery } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrentModificationError } from '../../../../shared/application/errors';
import { isUniqueViolation } from '../../../../shared/infrastructure/database/constraint-violation';
import { DuplicateExternalTransactionError, DuplicateIdempotencyKeyError } from '../../application/errors';
import type {
  DuePendingReference,
  PendingSchedule,
  WagerTransactionRepository,
} from '../../application/ports';
import { type WagerTransaction, WagerTransactionStatus } from '../../domain/wager-transaction';
import { WagerTransactionMapper } from './wager-transaction.mapper';
import { WagerTransactionRecord } from './wager-transaction.record';
import { WagerTransactionReversalRecord } from './wager-transaction-reversal.record';

const PENDING_REFERENCE = WagerTransactionStatus.PendingReference;

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction, schedule?: PendingSchedule): Promise<void> {
    const record = WagerTransactionMapper.toRecord(transaction);
    if (schedule) {
      record.attempts = schedule.attempts;
      record.nextAttemptAt = schedule.nextAttemptAt;
    }
    try {
      await this.em.insert(WagerTransactionRecord, record);
    } catch (error) {
      if (isUniqueViolation(error, 'wager_tx_idempotency_key_uq')) {
        throw new DuplicateIdempotencyKeyError(`Idempotency-Key ${transaction.idempotencyKey} already exists`);
      }
      if (isUniqueViolation(error, 'wager_tx_provider_external_uq')) {
        throw new DuplicateExternalTransactionError(
          transaction.providerId ?? '',
          transaction.externalTransactionId ?? '',
        );
      }
      throw error;
    }
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const { status, failureCode, processedAt, resultBalanceAmount } = WagerTransactionMapper.toRecord(transaction);
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: transaction.id, status: PENDING_REFERENCE },
      { status, failureCode, processedAt, resultBalanceAmount, nextAttemptAt: null },
    );
    if (affected !== 1) {
      throw new ConcurrentModificationError(`Transaction ${transaction.id} is no longer ${PENDING_REFERENCE}`);
    }
  }

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ idempotencyKey });
  }

  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async findPendingByReference(providerId: string, referenceExternalTransactionId: string): Promise<WagerTransaction[]> {
    const records = await this.em.find(
      WagerTransactionRecord,
      { providerId, referenceExternalTransactionId, status: PENDING_REFERENCE },
      { disableIdentityMap: true, orderBy: { createdAt: 'asc' } },
    );
    return records.map((record) => WagerTransactionMapper.toDomain(record));
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<DuePendingReference[]> {
    const records = await this.em.find(
      WagerTransactionRecord,
      { status: PENDING_REFERENCE, nextAttemptAt: { $lte: now } },
      { disableIdentityMap: true, orderBy: { nextAttemptAt: 'asc' }, limit, fields: ['id', 'walletId'] },
    );
    return records.map((record) => ({ id: record.id, walletId: record.walletId }));
  }

  async findPendingSchedule(id: string): Promise<PendingSchedule | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { id, status: PENDING_REFERENCE },
      { disableIdentityMap: true, fields: ['attempts', 'nextAttemptAt'] },
    );
    if (!record?.nextAttemptAt) return undefined;
    return { attempts: record.attempts, nextAttemptAt: record.nextAttemptAt };
  }

  async nextPendingReferenceDueAt(): Promise<Date | undefined> {
    const [row] = await this.em.execute<{ due: Date | string | null }[]>(
      'select min(next_attempt_at) as due from wager_transactions where status = ?',
      [PENDING_REFERENCE],
    );
    return row?.due ? new Date(row.due) : undefined;
  }

  async reschedule(id: string, schedule: PendingSchedule): Promise<void> {
    await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id, status: PENDING_REFERENCE },
      { attempts: schedule.attempts, nextAttemptAt: schedule.nextAttemptAt },
    );
  }

  async isReversed(referenceTransactionId: string): Promise<boolean> {
    const link = await this.em.findOne(
      WagerTransactionReversalRecord,
      { referenceTransactionId },
      { disableIdentityMap: true, fields: ['reversalTransactionId'] },
    );
    return link !== null;
  }

  async linkReversal(reversal: WagerTransaction, referenceTransactionId: string, at: Date): Promise<void> {
    await this.em.insert(WagerTransactionReversalRecord, {
      reversalTransactionId: reversal.id,
      referenceTransactionId,
      kind: reversal.kind,
      createdAt: at,
    });
  }

  private async findOne(where: FilterQuery<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, where, { disableIdentityMap: true });
    if (!record) return undefined;
    const link = await this.em.findOne(
      WagerTransactionReversalRecord,
      { reversalTransactionId: record.id },
      { disableIdentityMap: true, fields: ['referenceTransactionId'] },
    );
    return WagerTransactionMapper.toDomain(record, link?.referenceTransactionId);
  }
}
