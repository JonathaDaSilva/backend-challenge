import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { postJson } from './app';

export interface TestWallet {
  readonly walletId: string;
  readonly playerId: string;
}

export async function createWallet(baseUrl: string, amount = '100.00'): Promise<TestWallet> {
  const playerId = Bun.randomUUIDv7();
  const response = await postJson(`${baseUrl}/wallets`, {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string };
  return { walletId: body.id, playerId };
}

export interface SubmitOptions {
  readonly kind?: string;
  readonly amount?: string;
  readonly currency?: string;
  readonly externalTransactionId?: string;
  readonly idempotencyKey?: string | null;
  readonly body?: Record<string, unknown>;
}

export function wagerBody(wallet: TestWallet, options: SubmitOptions = {}) {
  const externalTransactionId = options.externalTransactionId ?? `ext-${Bun.randomUUIDv7()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: options.kind ?? 'BET',
    money: { amount: options.amount ?? '10.00', currency: options.currency ?? 'BRL' },
    ...options.body,
  };
}

export function submit(baseUrl: string, wallet: TestWallet, options: SubmitOptions = {}): Promise<Response> {
  const body = wagerBody(wallet, options);
  const idempotencyKey =
    options.idempotencyKey === undefined ? `${body.providerId}:${body.externalTransactionId}` : options.idempotencyKey;
  return fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(idempotencyKey === null ? {} : { 'idempotency-key': idempotencyKey }),
    },
    body: JSON.stringify(body),
  });
}

export interface SubmitResult {
  readonly status: number;
  readonly body: {
    transactionId: string;
    status: string;
    balance?: { amount: string; currency: string };
    idempotentReplay: boolean;
    failureCode?: string;
  };
}

export async function submitJson(baseUrl: string, wallet: TestWallet, options: SubmitOptions = {}): Promise<SubmitResult> {
  const response = await submit(baseUrl, wallet, options);
  return { status: response.status, body: (await response.json()) as SubmitResult['body'] };
}

export async function walletBalance(orm: MikroORM, walletId: string): Promise<{ balance: string; version: number }> {
  const [row] = await orm.em
    .fork()
    .execute<{ balance_amount: string; version: number }[]>('select balance_amount, version from wallets where id = ?', [
      walletId,
    ]);
  if (!row) throw new Error(`wallet ${walletId} not found`);
  return { balance: row.balance_amount, version: row.version };
}

export async function ledgerEntries(orm: MikroORM, walletId: string) {
  return orm.em
    .fork()
    .execute<{ direction: string; amount: string; wallet_version: number; transaction_id: string }[]>(
      'select direction, amount, wallet_version, transaction_id from wallet_ledger_entries where wallet_id = ? order by seq',
      [walletId],
    );
}

export async function expectLedgerInvariant(orm: MikroORM, walletId: string): Promise<void> {
  const [rebuilt] = await orm.em.fork().execute<{ balance: string }[]>(
    `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(20,2)::text as balance
       from wallet_ledger_entries where wallet_id = ?`,
    [walletId],
  );
  const stored = await walletBalance(orm, walletId);
  const versions = (await ledgerEntries(orm, walletId)).map((entry) => entry.wallet_version);

  expect(rebuilt?.balance).toBe(stored.balance);
  expect(versions).toEqual(versions.map((_, index) => index + 1));
  expect(stored.version).toBe(Math.max(1, ...versions));
}
