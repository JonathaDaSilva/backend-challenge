import { Migration } from '@mikro-orm/migrations';

export class Migration20261101000100_wallets extends Migration {
  override name = 'Migration20261101000100_wallets';

  override up(): void {
    this.addSql(`
      do $$
      begin
        if not exists (select from pg_roles where rolname = 'wallet_app') then
          create role wallet_app nologin;
        end if;
      end
      $$;
    `);

    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance_amount numeric(20,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_currency_ck check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative_ck check (balance_amount >= 0),
        constraint wallets_version_ck check (version >= 1),
        constraint wallets_player_currency_uq unique (player_id, currency),
        constraint wallets_id_player_currency_uq unique (id, player_id, currency)
      );
    `);

    this.addSql('grant select, insert, update on wallets to wallet_app;');
  }

  override down(): void {
    this.addSql('drop table wallets;');
  }
}
