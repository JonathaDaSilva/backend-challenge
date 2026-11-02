import type { EntityManager } from '@mikro-orm/postgresql';

export interface InvariantViolation {
  readonly walletId: string;
  readonly problem: string;
}

interface WalletLedgerRow {
  id: string;
  balance: string;
  ledger_balance: string;
  version: number;
  entries: number;
  min_version: number | null;
  max_version: number | null;
}

// Saldo armazenado = soma do ledger; versões do ledger contínuas; versão da wallet = última versão.
export async function findInvariantViolations(em: EntityManager, walletIds: readonly string[]): Promise<InvariantViolation[]> {
  if (walletIds.length === 0) return [];
  const rows = await em.execute<WalletLedgerRow[]>(
    `select w.id,
            w.balance_amount::text as balance,
            coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as ledger_balance,
            w.version,
            count(l.id)::int as entries,
            min(l.wallet_version) as min_version,
            max(l.wallet_version) as max_version
       from wallets w
       left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = any(?::uuid[])
      group by w.id`,
    [`{${walletIds.join(',')}}`],
  );

  const violations: InvariantViolation[] = [];
  for (const row of rows) {
    if (row.balance !== row.ledger_balance) {
      violations.push({ walletId: row.id, problem: `balance ${row.balance} != ledger ${row.ledger_balance}` });
    }
    // Com saldo inicial, o OPENING ocupa a versão 1; aberta com zero, o primeiro lançamento é a versão 2.
    const contiguous = row.max_version !== null && row.min_version !== null && row.max_version - row.min_version + 1 === row.entries;
    if (row.entries > 0 && (!contiguous || (row.min_version !== 1 && row.min_version !== 2))) {
      violations.push({ walletId: row.id, problem: `ledger versions ${row.min_version}..${row.max_version} for ${row.entries} entries` });
    }
    if (row.version !== Math.max(1, row.max_version ?? 0)) {
      violations.push({ walletId: row.id, problem: `wallet version ${row.version} != last ledger version ${row.max_version}` });
    }
  }
  return violations;
}
