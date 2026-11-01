import { Migration } from '@mikro-orm/migrations';

export class Migration20261101000400_wallet_ledger_entries extends Migration {
  override name = 'Migration20261101000400_wallet_ledger_entries';

  override up(): void {
    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        seq bigint generated always as identity,
        wallet_id uuid not null,
        transaction_id uuid not null,
        currency char(3) not null,
        direction text not null,
        amount numeric(20,2) not null,
        balance_before numeric(20,2) not null,
        balance_after numeric(20,2) not null,
        wallet_version integer not null,
        created_at timestamptz not null,
        constraint wallet_ledger_wallet_fk foreign key (wallet_id) references wallets (id),
        constraint wallet_ledger_transaction_fk foreign key (transaction_id, wallet_id, currency)
          references wager_transactions (id, wallet_id, currency),
        constraint wallet_ledger_direction_ck check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_amount_positive_ck check (amount > 0),
        constraint wallet_ledger_balance_before_ck check (balance_before >= 0),
        constraint wallet_ledger_balance_after_ck check (balance_after >= 0),
        constraint wallet_ledger_wallet_version_ck check (wallet_version >= 1),
        constraint wallet_ledger_balance_math_ck check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
        ),
        constraint wallet_ledger_one_per_transaction_uq unique (transaction_id, wallet_id),
        constraint wallet_ledger_wallet_version_uq unique (wallet_id, wallet_version)
      );
    `);

    this.addSql('create unique index wallet_ledger_cursor_idx on wallet_ledger_entries (wallet_id, seq);');

    this.addSql(`
      create trigger wallet_ledger_append_only_trg
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_mutation();
    `);
    this.addSql(`
      create trigger wallet_ledger_no_truncate_trg
        before truncate on wallet_ledger_entries
        for each statement execute function forbid_mutation();
    `);

    this.addSql('grant select, insert on wallet_ledger_entries to wallet_app;');
  }

  override down(): void {
    this.addSql('drop table wallet_ledger_entries;');
  }
}
