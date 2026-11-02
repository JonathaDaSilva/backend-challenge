import { EntitySchema } from '@mikro-orm/core';

export class WagerTransactionRecord {
  id!: string;
  providerId!: string | null;
  externalTransactionId!: string | null;
  idempotencyKey!: string | null;
  payloadHash!: string | null;
  walletId!: string;
  playerId!: string;
  currency!: string;
  roundId!: string | null;
  gameId!: string | null;
  kind!: string;
  amount!: string;
  referenceExternalTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  resultBalanceAmount!: string | null;
  attempts!: number;
  nextAttemptAt!: Date | null;
  createdAt!: Date;
  processedAt!: Date | null;
}

const nullableText = { type: 'text', nullable: true } as const;
const money = { type: 'decimal', precision: 20, scale: 2 } as const;

export const WagerTransactionRecordSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: nullableText,
    externalTransactionId: nullableText,
    idempotencyKey: nullableText,
    payloadHash: { type: 'string', columnType: 'char(64)', nullable: true },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    currency: { type: 'string', columnType: 'char(3)' },
    roundId: nullableText,
    gameId: nullableText,
    kind: { type: 'text' },
    amount: money,
    referenceExternalTransactionId: nullableText,
    status: { type: 'text' },
    failureCode: nullableText,
    resultBalanceAmount: { ...money, nullable: true },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime' },
    processedAt: { type: 'datetime', nullable: true },
  },
});
