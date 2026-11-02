import { Migration } from '@mikro-orm/migrations';

export class Migration20261101000200_wager_transactions extends Migration {
  override name = 'Migration20261101000200_wager_transactions';

  override up(): void {
    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text,
        external_transaction_id text,
        idempotency_key text,
        payload_hash char(64),
        wallet_id uuid not null,
        player_id uuid not null,
        currency char(3) not null,
        round_id text,
        game_id text,
        kind text not null,
        amount numeric(20,2) not null,
        reference_external_transaction_id text,
        status text not null,
        failure_code text,
        result_balance_amount numeric(20,2),
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_tx_wallet_fk foreign key (wallet_id, player_id, currency)
          references wallets (id, player_id, currency),
        constraint wager_tx_idempotency_key_uq unique (idempotency_key),
        constraint wager_tx_provider_external_uq unique (provider_id, external_transaction_id),
        constraint wager_tx_id_wallet_currency_uq unique (id, wallet_id, currency),
        constraint wager_tx_kind_ck check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_tx_status_ck check (
          status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        ),
        constraint wager_tx_amount_ck check (amount >= 0),
        constraint wager_tx_result_balance_ck check (result_balance_amount >= 0),
        constraint wager_tx_attempts_ck check (attempts >= 0),
        constraint wager_tx_payload_hash_ck check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint wager_tx_opening_ck check ((kind = 'OPENING') = (provider_id is null)),
        constraint wager_tx_provider_fields_ck check (
          kind = 'OPENING'
          or (external_transaction_id is not null and idempotency_key is not null
              and payload_hash is not null and round_id is not null and game_id is not null)
        ),
        constraint wager_tx_reference_ck check (
          (kind in ('REFUND', 'ROLLBACK')) = (reference_external_transaction_id is not null)
        ),
        constraint wager_tx_pending_reference_ck check (
          status <> 'PENDING_REFERENCE' or kind in ('REFUND', 'ROLLBACK')
        ),
        constraint wager_tx_processed_at_ck check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint wager_tx_failure_code_ck check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null))
      );
    `);

    this.addSql(`
      create index wager_tx_pending_reference_due_idx
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      create index wager_tx_pending_reference_lookup_idx
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';
    `);

    this.addSql('grant select, insert, update on wager_transactions to wallet_app;');
  }

  override down(): void {
    this.addSql('drop table wager_transactions;');
  }
}
