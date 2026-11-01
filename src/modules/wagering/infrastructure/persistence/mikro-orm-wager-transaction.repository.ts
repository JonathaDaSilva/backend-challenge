import type { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionRepository } from '../../application/ports';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { WagerTransactionMapper } from './wager-transaction.mapper';
import { WagerTransactionRecord } from './wager-transaction.record';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, WagerTransactionMapper.toRecord(transaction));
  }
}
