import { Migration } from '@mikro-orm/migrations';

export class Migration20261101000600_outbox_messages extends Migration {
  override name = 'Migration20261101000600_outbox_messages';

  override up(): void {
    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        seq bigint generated always as identity,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        published_at timestamptz,
        constraint outbox_messages_attempts_ck check (attempts >= 0)
      );
    `);

    this.addSql(`
      create index outbox_messages_pending_idx
        on outbox_messages (next_attempt_at, seq)
        where published_at is null;
    `);

    this.addSql('grant select, insert, update on outbox_messages to wallet_app;');
  }

  override down(): void {
    this.addSql('drop table outbox_messages;');
  }
}
