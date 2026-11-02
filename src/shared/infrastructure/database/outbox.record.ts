import { EntitySchema } from '@mikro-orm/core';

export class OutboxMessageRecord {
  id!: string;
  seq?: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt!: Date | null;
}

export const OutboxMessageRecordSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    seq: { type: 'bigint', persist: false, nullable: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'text' },
    payload: { type: 'json' },
    occurredAt: { type: 'datetime' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime' },
    publishedAt: { type: 'datetime', nullable: true },
  },
});
