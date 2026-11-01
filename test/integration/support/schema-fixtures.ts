import { expect } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';

export type Row = Record<string, unknown>;

export interface WalletRow extends Row {
  id: string;
  player_id: string;
  currency: string;
  balance_amount: string;
}

export interface TransactionRow extends Row {
  id: string;
  external_transaction_id: string | null;
  wallet_id: string;
  player_id: string;
  currency: string;
}

const HASH = 'a'.repeat(64);

export class SchemaFixtures {
  constructor(private readonly em: EntityManager) {}

  async insert<T extends Row>(table: string, row: T): Promise<T> {
    const columns = Object.keys(row);
    await this.em
      .fork()
      .execute(
        `insert into ${table} (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
        Object.values(row),
      );
    return row;
  }

  wallet(overrides: Partial<WalletRow> = {}): Promise<WalletRow> {
    const now = new Date();
    return this.insert('wallets', {
      id: Bun.randomUUIDv7(),
      player_id: Bun.randomUUIDv7(),
      currency: 'BRL',
      balance_amount: '100.00',
      version: 1,
      created_at: now,
      updated_at: now,
      ...overrides,
    });
  }

  transaction(wallet: WalletRow, overrides: Row = {}): Promise<TransactionRow> {
    const status = overrides.status ?? 'PENDING';
    return this.insert('wager_transactions', {
      id: Bun.randomUUIDv7(),
      provider_id: 'provider-a',
      external_transaction_id: `ext-${Bun.randomUUIDv7()}`,
      idempotency_key: `key-${Bun.randomUUIDv7()}`,
      payload_hash: HASH,
      wallet_id: wallet.id,
      player_id: wallet.player_id,
      currency: wallet.currency,
      round_id: 'round-1',
      game_id: 'game-1',
      kind: 'BET',
      amount: '10.00',
      status,
      created_at: new Date(),
      processed_at: status === 'PROCESSED' ? new Date() : null,
      ...overrides,
    });
  }

  processed(wallet: WalletRow, overrides: Row = {}): Promise<TransactionRow> {
    return this.transaction(wallet, { status: 'PROCESSED', processed_at: new Date(), ...overrides });
  }

  reversalOf(reference: TransactionRow, wallet: WalletRow, kind: 'REFUND' | 'ROLLBACK', overrides: Row = {}) {
    return this.processed(wallet, {
      kind,
      reference_external_transaction_id: reference.external_transaction_id,
      ...overrides,
    });
  }

  link(reversal: TransactionRow, reference: TransactionRow, kind: 'REFUND' | 'ROLLBACK'): Promise<Row> {
    return this.insert('wager_transaction_reversals', {
      reversal_transaction_id: reversal.id,
      reference_transaction_id: reference.id,
      kind,
      created_at: new Date(),
    });
  }

  ledger(wallet: WalletRow, transaction: TransactionRow, overrides: Row = {}): Promise<Row> {
    return this.insert('wallet_ledger_entries', {
      id: Bun.randomUUIDv7(),
      wallet_id: wallet.id,
      transaction_id: transaction.id,
      currency: wallet.currency,
      direction: 'DEBIT',
      amount: '10.00',
      balance_before: '100.00',
      balance_after: '90.00',
      wallet_version: 2,
      created_at: new Date(),
      ...overrides,
    });
  }
}

export async function expectViolation(operation: Promise<unknown>, code: string, constraint?: string): Promise<void> {
  const error = await operation.then(
    () => undefined,
    (reason: unknown) => reason as { code?: string; constraint?: string },
  );
  expect(error, `expected ${constraint ?? code} to be violated`).toBeDefined();
  if (constraint === undefined) {
    expect(error?.code).toBe(code);
  } else {
    expect({ code: error?.code, constraint: error?.constraint }).toEqual({ code, constraint });
  }
}
