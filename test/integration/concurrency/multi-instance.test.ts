import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { initTestDatabases, type TestDatabases } from '../support/database';
import { type Instance, startInstances, stopInstances } from '../support/instances';
import { createWallet, expectLedgerInvariant, ledgerEntries, submitJson, walletBalance } from '../support/wagering';

let instances: Instance[];
let db: TestDatabases;

const urlFor = (index: number) => instances[index % instances.length]?.url ?? '';

beforeAll(async () => {
  db = await initTestDatabases();
  instances = await startInstances(3);
}, 60_000);

afterAll(async () => {
  await stopInstances(instances);
  await db.close();
});

describe('three application instances against the same database', () => {
  test('mandatory scenario: 80.00 + 80.00 against 100.00 on different instances', async () => {
    const wallet = await createWallet(urlFor(0), '100.00');
    const results = await Promise.all([
      submitJson(urlFor(1), wallet, { amount: '80.00' }),
      submitJson(urlFor(2), wallet, { amount: '80.00' }),
    ]);

    expect(results.map((result) => result.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.map((result) => result.status).sort()).toEqual([201, 422]);
    expect(results.find((result) => result.status === 422)?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '20.00', version: 2 });

    const debits = (await ledgerEntries(db.owner, wallet.walletId)).filter((entry) => entry.direction === 'DEBIT');
    expect(debits).toHaveLength(1);
    expect(debits[0]?.transaction_id).toBe(results.find((result) => result.status === 201)?.body.transactionId);

    const [persisted] = await db.owner.em
      .fork()
      .execute<{ statuses: string[] }[]>(
        "select array_agg(status order by status) as statuses from wager_transactions where wallet_id = ? and kind = 'BET'",
        [wallet.walletId],
      );
    expect(persisted?.statuses).toEqual(['PROCESSED', 'REJECTED']);
    await expectLedgerInvariant(db.owner, wallet.walletId);
  });

  test('60 bets spread across the instances never overdraw', async () => {
    const wallet = await createWallet(urlFor(0), '100.00');
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, index) => submitJson(urlFor(index), wallet, { amount: '10.00' })),
    );

    expect(results.filter((result) => result.status === 201)).toHaveLength(10);
    expect(results.filter((result) => result.status === 422)).toHaveLength(50);
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '0.00', version: 11 });
    await expectLedgerInvariant(db.owner, wallet.walletId);
  });

  test('the same bet replayed 30 times across the instances debits once', async () => {
    const wallet = await createWallet(urlFor(0), '100.00');
    const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        submitJson(urlFor(index), wallet, { externalTransactionId, amount: '40.00' }),
      ),
    );

    expect(new Set(results.map((result) => result.body.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.body.idempotentReplay)).toHaveLength(1);
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '60.00', version: 2 });
    await expectLedgerInvariant(db.owner, wallet.walletId);
  });

  test('different wallets progress in parallel across instances', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => createWallet(urlFor(0), '50.00')));
    const results = await Promise.all(
      wallets.flatMap((wallet, walletIndex) =>
        Array.from({ length: 5 }, (_, betIndex) => submitJson(urlFor(walletIndex + betIndex), wallet, { amount: '10.00' })),
      ),
    );

    expect(results.every((result) => result.status === 201)).toBe(true);
    for (const wallet of wallets) {
      expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '0.00', version: 6 });
      await expectLedgerInvariant(db.owner, wallet.walletId);
    }
  });
});
