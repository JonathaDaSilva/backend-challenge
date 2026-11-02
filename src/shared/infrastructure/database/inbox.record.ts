import { EntitySchema } from '@mikro-orm/core';

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxMessageRecordSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'text', primary: true },
    messageId: { type: 'text', primary: true },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    receivedAt: { type: 'datetime' },
    processedAt: { type: 'datetime', nullable: true },
  },
});
