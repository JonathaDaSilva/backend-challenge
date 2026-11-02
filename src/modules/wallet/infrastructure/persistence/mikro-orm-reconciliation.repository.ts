import type { EntityManager } from '@mikro-orm/postgresql';
import type { ReconciliationRepository, WalletReconciliation } from '../../application/ports';

export class MikroOrmReconciliationRepository implements ReconciliationRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(reconciliation: WalletReconciliation): Promise<void> {
    await this.em.execute(
      `insert into wallet_reconciliations
         (id, wallet_id, currency, stored_balance, calculated_balance, difference, consistent, checked_entries, checked_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reconciliation.id,
        reconciliation.walletId,
        reconciliation.storedBalance.currency,
        reconciliation.storedBalance.toString(),
        reconciliation.calculatedBalance.toString(),
        reconciliation.difference.toString(),
        reconciliation.consistent,
        reconciliation.checkedEntries,
        reconciliation.checkedAt,
      ],
    );
  }
}
