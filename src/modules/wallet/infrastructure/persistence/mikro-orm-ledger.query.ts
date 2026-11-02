import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../../../shared/domain/money';
import type { LedgerPageEntry, LedgerQuery, LedgerTotals } from '../../application/ports';
import { type LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

interface LedgerRow {
  id: string;
  seq: string;
  wallet_id: string;
  transaction_id: string;
  currency: string;
  direction: string;
  amount: string;
  balance_before: string;
  balance_after: string;
  wallet_version: number;
  created_at: Date | string;
  kind: string;
}

const SELECT_PAGE = `
  select l.id, l.seq::text as seq, l.wallet_id, l.transaction_id, l.currency, l.direction,
         l.amount, l.balance_before, l.balance_after, l.wallet_version, l.created_at, t.kind
    from wallet_ledger_entries l
    join wager_transactions t on t.id = l.transaction_id
   where l.wallet_id = ?`;

export class MikroOrmLedgerQuery implements LedgerQuery {
  constructor(private readonly em: EntityManager) {}

  async page(walletId: string, beforeSeq: string | undefined, limit: number): Promise<LedgerPageEntry[]> {
    const rows =
      beforeSeq === undefined
        ? await this.em.execute<LedgerRow[]>(`${SELECT_PAGE} order by l.seq desc limit ?`, [walletId, limit])
        : await this.em.execute<LedgerRow[]>(`${SELECT_PAGE} and l.seq < ?::bigint order by l.seq desc limit ?`, [
            walletId,
            beforeSeq,
            limit,
          ]);
    return rows.map((row) => ({ seq: row.seq, kind: row.kind, entry: toEntry(row) }));
  }

  async totals(walletId: string, currency: string): Promise<LedgerTotals> {
    const [row] = await this.em.execute<{ balance: string; entries: number }[]>(
      `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(20,2)::text as balance,
              count(*)::int as entries
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    );
    return {
      balance: Money.from({ amount: row?.balance ?? '0.00', currency }),
      entries: row?.entries ?? 0,
    };
  }
}

function toEntry(row: LedgerRow): WalletLedgerEntry {
  const money = (amount: string) => Money.from({ amount, currency: row.currency });
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction as LedgerDirection,
    money: money(row.amount),
    balanceBefore: money(row.balance_before),
    balanceAfter: money(row.balance_after),
    walletVersion: row.wallet_version,
    createdAt: new Date(row.created_at),
  });
}
