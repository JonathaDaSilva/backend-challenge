import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type StartedApp, startApp } from '../support/app';
import { initTestDatabases, type TestDatabases } from '../support/database';
import {
  createWallet,
  expectLedgerInvariant,
  ledgerEntries,
  submit,
  submitJson,
  type TestWallet,
  walletBalance,
} from '../support/wagering';

let app: StartedApp;
let db: TestDatabases;

beforeAll(async () => {
  db = await initTestDatabases();
  app = await startApp();
});

afterAll(async () => {
  await app.close();
  await db.close();
});

async function holdWalletLock(wallet: TestWallet, ms: number, locked: () => void): Promise<void> {
  await db.owner.em.fork().transactional(async (em) => {
    await em.execute('select id from wallets where id = ? for update', [wallet.walletId]);
    locked();
    await Bun.sleep(ms);
  });
}

describe('per-wallet locking', () => {
  test('two 80.00 bets against 100.00: one PROCESSED, one REJECTED, final 20.00, one debit', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const results = await Promise.all([
      submitJson(app.url, wallet, { amount: '80.00' }),
      submitJson(app.url, wallet, { amount: '80.00' }),
    ]);

    expect(results.map((result) => result.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((result) => result.body.status === 'REJECTED')?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '20.00', version: 2 });
    expect((await ledgerEntries(db.owner, wallet.walletId)).filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
    await expectLedgerInvariant(db.owner, wallet.walletId);
  });

  test('a burst of 30 bets never overdraws', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const results = await Promise.all(
      Array.from({ length: 30 }, () => submitJson(app.url, wallet, { amount: '10.00' })),
    );

    expect(results.filter((result) => result.status === 201)).toHaveLength(10);
    expect(results.filter((result) => result.status === 422)).toHaveLength(20);
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '0.00', version: 11 });
    await expectLedgerInvariant(db.owner, wallet.walletId);
  });

  test('other wallets are not blocked by a locked wallet', async () => {
    const busy = await createWallet(app.url);
    const free = await createWallet(app.url);
    const locked = Promise.withResolvers<void>();
    const holder = holdWalletLock(busy, 1000, locked.resolve);
    await locked.promise;

    const started = performance.now();
    const result = await submitJson(app.url, free, { amount: '1.00' });
    const elapsed = performance.now() - started;
    await holder;

    expect(result.status).toBe(201);
    expect(elapsed).toBeLessThan(500);
  });

  test(
    'a wallet locked beyond lock_timeout answers 503 and changes nothing',
    async () => {
      const wallet = await createWallet(app.url);
      const locked = Promise.withResolvers<void>();
      const holder = holdWalletLock(wallet, 3000, locked.resolve);
      await locked.promise;

      const response = await submit(app.url, wallet, { amount: '1.00' });
      await holder;

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ failureCode: 'TRANSIENT_FAILURE' });
      expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '100.00', version: 1 });
    },
    { timeout: 15_000 },
  );
});

describe('idempotency under concurrency', () => {
  test('the same bet sent 50 times in parallel debits once', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
    const results = await Promise.all(
      Array.from({ length: 50 }, () => submitJson(app.url, wallet, { externalTransactionId, amount: '25.00' })),
    );

    const ids = new Set(results.map((result) => result.body.transactionId));
    expect(ids.size).toBe(1);
    expect(results.every((result) => result.status === 201)).toBe(true);
    expect(results.filter((result) => !result.body.idempotentReplay)).toHaveLength(1);
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '75.00', version: 2 });
    expect(await ledgerEntries(db.owner, wallet.walletId)).toHaveLength(2);
    await expectLedgerInvariant(db.owner, wallet.walletId);
  });

  test('one key raced against two wallets: one applies, the other conflicts', async () => {
    const first = await createWallet(app.url);
    const second = await createWallet(app.url);
    const idempotencyKey = `provider-a:${Bun.randomUUIDv7()}`;

    const responses = await Promise.all([
      submit(app.url, first, { idempotencyKey }),
      submit(app.url, second, { idempotencyKey }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const balances = await Promise.all([
      walletBalance(db.owner, first.walletId),
      walletBalance(db.owner, second.walletId),
    ]);
    expect(balances.map((balance) => balance.balance).sort()).toEqual(['100.00', '90.00'].sort());
  });
});
