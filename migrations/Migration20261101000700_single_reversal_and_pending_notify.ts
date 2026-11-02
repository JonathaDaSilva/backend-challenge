import { Migration } from '@mikro-orm/migrations';

export class Migration20261101000700_single_reversal_and_pending_notify extends Migration {
  override name = 'Migration20261101000700_single_reversal_and_pending_notify';

  override up(): void {
    this.addSql('alter table wager_transaction_reversals drop constraint wager_tx_reversals_single_uq;');
    this.addSql(`
      alter table wager_transaction_reversals
        add constraint wager_tx_reversals_reference_uq unique (reference_transaction_id);
    `);

    this.addSql(`
      create function notify_pending_reference() returns trigger
      language plpgsql as $$
      begin
        perform pg_notify(
          'pending_reference',
          (extract(epoch from new.next_attempt_at) * 1000)::bigint::text
        );
        return null;
      end
      $$;
    `);
    this.addSql(`
      create trigger wager_tx_pending_reference_notify_trg
        after insert or update of status, next_attempt_at on wager_transactions
        for each row
        when (new.status = 'PENDING_REFERENCE' and new.next_attempt_at is not null)
        execute function notify_pending_reference();
    `);
  }

  override down(): void {
    this.addSql('drop trigger wager_tx_pending_reference_notify_trg on wager_transactions;');
    this.addSql('drop function notify_pending_reference();');
    this.addSql('alter table wager_transaction_reversals drop constraint wager_tx_reversals_reference_uq;');
    this.addSql(`
      alter table wager_transaction_reversals
        add constraint wager_tx_reversals_single_uq unique (reference_transaction_id, kind);
    `);
  }
}
