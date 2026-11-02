import { Migration } from '@mikro-orm/migrations';

export class Migration20261101000900_wallet_reconciliations extends Migration {
  override name = 'Migration20261101000900_wallet_reconciliations';

  override up(): void {
    this.addSql(`
      create table wallet_reconciliations (
        id uuid primary key,
        wallet_id uuid not null,
        currency char(3) not null,
        stored_balance numeric(20,2) not null,
        calculated_balance numeric(20,2) not null,
        difference numeric(20,2) not null,
        consistent boolean not null,
        checked_entries integer not null,
        checked_at timestamptz not null,
        constraint wallet_reconciliations_wallet_fk foreign key (wallet_id) references wallets (id),
        constraint wallet_reconciliations_difference_ck check (difference = stored_balance - calculated_balance),
        constraint wallet_reconciliations_consistent_ck check (consistent = (difference = 0)),
        constraint wallet_reconciliations_entries_ck check (checked_entries >= 0)
      );
    `);
    this.addSql('create index wallet_reconciliations_wallet_idx on wallet_reconciliations (wallet_id, checked_at);');
    this.addSql(`
      create trigger wallet_reconciliations_append_only_trg
        before update or delete on wallet_reconciliations
        for each row execute function forbid_mutation();
    `);
    this.addSql('grant select, insert on wallet_reconciliations to wallet_app;');
  }

  override down(): void {
    this.addSql('drop table wallet_reconciliations;');
  }
}
