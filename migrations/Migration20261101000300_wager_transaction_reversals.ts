import { Migration } from '@mikro-orm/migrations';

export class Migration20261101000300_wager_transaction_reversals extends Migration {
  override name = 'Migration20261101000300_wager_transaction_reversals';

  override up(): void {
    this.addSql(`
      create function forbid_mutation() returns trigger
      language plpgsql as $$
      begin
        raise exception '% is append-only', tg_table_name
          using errcode = 'restrict_violation', constraint = tg_table_name || '_append_only';
      end
      $$;
    `);

    this.addSql(`
      create table wager_transaction_reversals (
        reversal_transaction_id uuid primary key,
        reference_transaction_id uuid not null,
        kind text not null,
        created_at timestamptz not null,
        constraint wager_tx_reversals_reversal_fk foreign key (reversal_transaction_id)
          references wager_transactions (id),
        constraint wager_tx_reversals_reference_fk foreign key (reference_transaction_id)
          references wager_transactions (id),
        constraint wager_tx_reversals_kind_ck check (kind in ('REFUND', 'ROLLBACK')),
        constraint wager_tx_reversals_not_self_ck check (reversal_transaction_id <> reference_transaction_id),
        constraint wager_tx_reversals_single_uq unique (reference_transaction_id, kind)
      );
    `);

    this.addSql(`
      create function assert_reversal_matches_reference() returns trigger
      language plpgsql as $$
      declare
        reversal wager_transactions%rowtype;
        reference wager_transactions%rowtype;
      begin
        select * into reversal from wager_transactions where id = new.reversal_transaction_id;
        select * into reference from wager_transactions where id = new.reference_transaction_id;

        if reversal.id is null or reference.id is null then
          return new;
        end if;

        if reversal.kind <> new.kind then
          raise exception 'reversal kind % does not match transaction kind %', new.kind, reversal.kind
            using errcode = 'check_violation', constraint = 'wager_tx_reversals_kind_match_ck';
        end if;

        if not ((new.kind = 'REFUND' and reference.kind = 'BET')
                or (new.kind = 'ROLLBACK' and reference.kind in ('BET', 'WIN', 'REFUND'))) then
          raise exception '% cannot reverse %', new.kind, reference.kind
            using errcode = 'check_violation', constraint = 'wager_tx_reversals_reference_kind_ck';
        end if;

        if reference.status <> 'PROCESSED' then
          raise exception 'reference transaction is %', reference.status
            using errcode = 'check_violation', constraint = 'wager_tx_reversals_reference_processed_ck';
        end if;

        if (reversal.provider_id, reversal.player_id, reversal.wallet_id, reversal.currency, reversal.round_id)
           is distinct from
           (reference.provider_id, reference.player_id, reference.wallet_id, reference.currency, reference.round_id)
           or reversal.reference_external_transaction_id is distinct from reference.external_transaction_id then
          raise exception 'reversal does not belong to the same provider, player, wallet, currency and round'
            using errcode = 'check_violation', constraint = 'wager_tx_reversals_same_scope_ck';
        end if;

        if reversal.amount <> reference.amount then
          raise exception 'reversal amount % differs from reference amount %', reversal.amount, reference.amount
            using errcode = 'check_violation', constraint = 'wager_tx_reversals_amount_ck';
        end if;

        return new;
      end
      $$;
    `);

    this.addSql(`
      create trigger wager_tx_reversals_match_trg
        before insert on wager_transaction_reversals
        for each row execute function assert_reversal_matches_reference();
    `);
    this.addSql(`
      create trigger wager_tx_reversals_append_only_trg
        before update or delete on wager_transaction_reversals
        for each row execute function forbid_mutation();
    `);
    this.addSql(`
      create trigger wager_tx_reversals_no_truncate_trg
        before truncate on wager_transaction_reversals
        for each statement execute function forbid_mutation();
    `);

    this.addSql('grant select, insert on wager_transaction_reversals to wallet_app;');
  }

  override down(): void {
    this.addSql('drop table wager_transaction_reversals;');
    this.addSql('drop function assert_reversal_matches_reference();');
    this.addSql('drop function forbid_mutation();');
  }
}
