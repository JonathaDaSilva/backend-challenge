import { EntitySchema } from '@mikro-orm/core';

export class WagerTransactionReversalRecord {
  reversalTransactionId!: string;
  referenceTransactionId!: string;
  kind!: string;
  createdAt!: Date;
}

export const WagerTransactionReversalRecordSchema = new EntitySchema<WagerTransactionReversalRecord>({
  class: WagerTransactionReversalRecord,
  tableName: 'wager_transaction_reversals',
  properties: {
    reversalTransactionId: { type: 'uuid', primary: true },
    referenceTransactionId: { type: 'uuid' },
    kind: { type: 'text' },
    createdAt: { type: 'datetime' },
  },
});
