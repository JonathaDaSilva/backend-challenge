import type { FilterQuery } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { isUniqueViolation } from '../../../../shared/infrastructure/database/constraint-violation';
import { DuplicateExternalTransactionError, DuplicateIdempotencyKeyError } from '../../application/errors';
import type { WagerTransactionRepository } from '../../application/ports';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { WagerTransactionMapper } from './wager-transaction.mapper';
import { WagerTransactionRecord } from './wager-transaction.record';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    try {
      await this.em.insert(WagerTransactionRecord, WagerTransactionMapper.toRecord(transaction));
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

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ idempotencyKey });
  }

  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  private async findOne(where: FilterQuery<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, where, { disableIdentityMap: true });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }
}
