import { Migration } from '@mikro-orm/migrations';

export class Migration20261101000800_outbox_notify extends Migration {
  override name = 'Migration20261101000800_outbox_notify';

  override up(): void {
    this.addSql(`
      create function notify_outbox() returns trigger
      language plpgsql as $$
      begin
        perform pg_notify('outbox', (extract(epoch from new.next_attempt_at) * 1000)::bigint::text);
        return null;
      end
      $$;
    `);
    this.addSql(`
      create trigger outbox_messages_notify_trg
        after insert or update of next_attempt_at on outbox_messages
        for each row
        when (new.published_at is null)
        execute function notify_outbox();
    `);
  }

  override down(): void {
    this.addSql('drop trigger outbox_messages_notify_trg on outbox_messages;');
    this.addSql('drop function notify_outbox();');
  }
}
