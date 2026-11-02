import { EntitySchema } from '@mikro-orm/core';

export class WalletLedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  currency!: string;
  direction!: string;
  amount!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export const WalletLedgerEntryRecordSchema = new EntitySchema<WalletLedgerEntryRecord>({
  class: WalletLedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    currency: { type: 'string', columnType: 'char(3)' },
    direction: { type: 'text' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    balanceBefore: { type: 'decimal', precision: 20, scale: 2 },
    balanceAfter: { type: 'decimal', precision: 20, scale: 2 },
    walletVersion: { type: 'integer' },
    createdAt: { type: 'datetime' },
  },
});
