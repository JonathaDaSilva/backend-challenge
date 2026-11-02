import { Migration } from '@mikro-orm/migrations';

export class Migration20261101000500_inbox_messages extends Migration {
  override name = 'Migration20261101000500_inbox_messages';

  override up(): void {
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash char(64) not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_messages_pk primary key (consumer_name, message_id),
        constraint inbox_messages_payload_hash_ck check (payload_hash ~ '^[0-9a-f]{64}$')
      );
    `);

    this.addSql('grant select, insert, update on inbox_messages to wallet_app;');
  }

  override down(): void {
    this.addSql('drop table inbox_messages;');
  }
}
