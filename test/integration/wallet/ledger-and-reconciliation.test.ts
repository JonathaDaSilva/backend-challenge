import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RECONCILIATION_DIVERGENCE_METRIC } from '../../../src/modules/wallet/application/reconcile-wallet.use-case';
import { METRICS } from '../../../src/shared/application/observability';
import type { InMemoryMetrics } from '../../../src/shared/infrastructure/in-memory-metrics';
import { type StartedApp, startApp } from '../support/app';
import { initTestDatabases, type TestDatabases } from '../support/database';
import { expectViolation } from '../support/schema-fixtures';
import { createWallet, submit, submitJson, type TestWallet, walletBalance } from '../support/wagering';

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

interface LedgerPage {
  walletId: string;
  entries: { walletVersion: number; kind: string; direction: string; money: { amount: string } }[];
  nextCursor: string | null;
}

interface Reconciliation {
  reconciliationId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
}

async function ledgerPage(walletId: string, query = ''): Promise<{ status: number; body: LedgerPage }> {
  const response = await fetch(`${app.url}/wallets/${walletId}/ledger${query}`);
  return { status: response.status, body: (await response.json()) as LedgerPage };
}

async function reconcile(walletId: string): Promise<{ status: number; body: Reconciliation }> {
  const response = await fetch(`${app.url}/wallets/${walletId}/reconciliation`, { method: 'POST' });
  return { status: response.status, body: (await response.json()) as Reconciliation };
}

async function bets(wallet: TestWallet, count: number, amount = '1.00'): Promise<void> {
  await Promise.all(Array.from({ length: count }, () => submitJson(app.url, wallet, { amount })));
}

describe('GET /wallets/:walletId/ledger', () => {
  test('walks 120 entries newest first in pages of 50, 50 and 20 without gaps or repeats', async () => {
    const wallet = await createWallet(app.url, '1000.00');
    await bets(wallet, 119);

    const first = await ledgerPage(wallet.walletId, '?limit=50');
    const second = await ledgerPage(wallet.walletId, `?limit=50&cursor=${first.body.nextCursor}`);
    const third = await ledgerPage(wallet.walletId, `?limit=50&cursor=${second.body.nextCursor}`);

    expect([first, second, third].map((page) => page.body.entries.length)).toEqual([50, 50, 20]);
    expect(third.body.nextCursor).toBeNull();
    const versions = [first, second, third].flatMap((page) => page.body.entries.map((entry) => entry.walletVersion));
    expect(versions).toEqual(Array.from({ length: 120 }, (_, index) => 120 - index));
    expect(third.body.entries.at(-1)).toMatchObject({ kind: 'OPENING', direction: 'CREDIT', walletVersion: 1 });
    expect(first.body.entries[0]).toMatchObject({ kind: 'BET', direction: 'DEBIT', money: { amount: '1.00' } });
  });

  test('new entries written between pages do not shift the next page', async () => {
    const wallet = await createWallet(app.url, '100.00');
    await bets(wallet, 19);

    const first = await ledgerPage(wallet.walletId, '?limit=10');
    await bets(wallet, 5);
    const second = await ledgerPage(wallet.walletId, `?limit=10&cursor=${first.body.nextCursor}`);

    expect(first.body.entries.map((entry) => entry.walletVersion)).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);
    expect(second.body.entries.map((entry) => entry.walletVersion)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(second.body.nextCursor).toBeNull();
  });

  test('defaults to 50 entries', async () => {
    const wallet = await createWallet(app.url, '100.00');
    await bets(wallet, 59);
    expect((await ledgerPage(wallet.walletId)).body.entries).toHaveLength(50);
  });

  test.each([
    ['limit=0', '?limit=0'],
    ['limit=201', '?limit=201'],
    ['a non-numeric limit', '?limit=abc'],
    ['a cursor that is not base64 JSON', '?cursor=@@@'],
    ['a cursor from another version', `?cursor=${Buffer.from(JSON.stringify({ v: 2, before: '10' })).toString('base64url')}`],
    ['a cursor with a forged position', `?cursor=${Buffer.from(JSON.stringify({ v: 1, before: '-1 or 1=1' })).toString('base64url')}`],
  ])('rejects %s with 400', async (_, query) => {
    const wallet = await createWallet(app.url);
    const { status, body } = await ledgerPage(wallet.walletId, query);
    expect(status).toBe(400);
    expect(body).toMatchObject({ failureCode: 'INVALID_PAYLOAD' });
  });

  test('404 for an unknown wallet', async () => {
    const { status, body } = await ledgerPage(Bun.randomUUIDv7());
    expect(status).toBe(404);
    expect(body).toMatchObject({ failureCode: 'WALLET_NOT_FOUND' });
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('is consistent after every kind of operation and records the run', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const bet = `ext-${Bun.randomUUIDv7()}`;
    const win = `ext-${Bun.randomUUIDv7()}`;
    await submitJson(app.url, wallet, { externalTransactionId: bet, amount: '30.00' });
    await submitJson(app.url, wallet, { kind: 'WIN', externalTransactionId: win, amount: '12.50' });
    await submitJson(app.url, wallet, { kind: 'LOSS', amount: '0.00' });
    await submitJson(app.url, wallet, { kind: 'REFUND', amount: '30.00', body: { referenceExternalTransactionId: bet } });
    await submitJson(app.url, wallet, { kind: 'ROLLBACK', amount: '12.50', body: { referenceExternalTransactionId: win } });

    const { status, body } = await reconcile(wallet.walletId);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      walletId: wallet.walletId,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 5,
    });
    const [row] = await db.owner.em
      .fork()
      .execute<{ consistent: boolean; difference: string }[]>(
        'select consistent, difference from wallet_reconciliations where id = ?',
        [body.reconciliationId],
      );
    expect(row).toEqual({ consistent: true, difference: '0.00' });
  });

  test('a divergence is reported, counted and recorded, but never corrected', async () => {
    const metrics = app.get<InMemoryMetrics>(METRICS);
    const before = metrics.value(RECONCILIATION_DIVERGENCE_METRIC, { currency: 'BRL' });
    const wallet = await createWallet(app.url, '100.00');
    await submitJson(app.url, wallet, { amount: '20.00' });
    await db.owner.em.fork().execute('update wallets set balance_amount = balance_amount + 5 where id = ?', [wallet.walletId]);

    const { body } = await reconcile(wallet.walletId);

    expect(body).toMatchObject({
      storedBalance: { amount: '85.00' },
      calculatedBalance: { amount: '80.00' },
      difference: { amount: '5.00' },
      consistent: false,
      checkedEntries: 2,
    });
    expect(metrics.value(RECONCILIATION_DIVERGENCE_METRIC, { currency: 'BRL' })).toBe(before + 1);
    const [row] = await db.owner.em
      .fork()
      .execute<{ consistent: boolean }[]>('select consistent from wallet_reconciliations where id = ?', [
        body.reconciliationId,
      ]);
    expect(row?.consistent).toBe(false);
    expect((await walletBalance(db.owner, wallet.walletId)).balance).toBe('85.00');
  });

  test(
    'reads one snapshot, so bets running alongside never look like a divergence',
    async () => {
      const wallet = await createWallet(app.url, '1000.00');
      const [results] = await Promise.all([
        Promise.all(Array.from({ length: 15 }, () => reconcile(wallet.walletId))),
        bets(wallet, 40),
      ]);
      expect(results.every((result) => result.status === 200 && result.body.consistent)).toBe(true);
      expect((await reconcile(wallet.walletId)).body).toMatchObject({ consistent: true, checkedEntries: 41 });
    },
    30_000,
  );

  test('404 for an unknown wallet and 400 for an invalid id', async () => {
    expect((await reconcile(Bun.randomUUIDv7())).status).toBe(404);
    expect((await reconcile('not-a-uuid')).status).toBe(400);
  });

  test('reconciliation records are append-only', async () => {
    const wallet = await createWallet(app.url);
    const { body } = await reconcile(wallet.walletId);
    await expectViolation(
      db.owner.em.fork().execute('update wallet_reconciliations set consistent = false where id = ?', [body.reconciliationId]),
      '23001',
      'wallet_reconciliations_append_only',
    );
    await expectViolation(
      db.app.em.fork().execute('delete from wallet_reconciliations where id = ?', [body.reconciliationId]),
      '42501',
    );
  });

  test('POST without a body is accepted; a body that is not JSON is still rejected', async () => {
    const wallet = await createWallet(app.url);
    const withoutBody = await fetch(`${app.url}/wallets/${wallet.walletId}/reconciliation`, { method: 'POST' });
    const plainText = await submit(app.url, wallet, { headers: { 'content-type': 'text/plain' } });
    expect(withoutBody.status).toBe(200);
    expect(plainText.status).toBe(415);
  });
});
