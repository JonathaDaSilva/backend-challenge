import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PendingReferenceWorker } from '../../../src/modules/wagering/application/pending-reference-worker';
import { type StartedApp, startApp, withConfig } from '../support/app';
import { initTestDatabases, type TestDatabases } from '../support/database';
import { SchemaFixtures } from '../support/schema-fixtures';
import {
  createWallet,
  expectLedgerInvariant,
  ledgerEntries,
  type SubmitOptions,
  submitJson,
  type TestWallet,
  walletBalance,
} from '../support/wagering';

let app: StartedApp;
let db: TestDatabases;
let worker: PendingReferenceWorker;

beforeAll(async () => {
  db = await initTestDatabases();
  app = await startApp(
    withConfig((config) => ({ ...config, pendingReference: { ...config.pendingReference, workerEnabled: false } })),
  );
  worker = app.get(PendingReferenceWorker);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

const newExternalId = () => `ext-${Bun.randomUUIDv7()}`;
const reversalOf = (kind: 'REFUND' | 'ROLLBACK', reference: string, extra: SubmitOptions = {}): SubmitOptions => ({
  ...extra,
  kind,
  body: { referenceExternalTransactionId: reference, ...extra.body },
});

async function transaction(id: string) {
  const response = await fetch(`${app.url}/wagering/transactions/${id}`);
  return (await response.json()) as { status: string; failureCode?: string; referenceTransactionId?: string };
}

async function bet(wallet: TestWallet, amount = '30.00') {
  const externalTransactionId = newExternalId();
  const result = await submitJson(app.url, wallet, { externalTransactionId, amount });
  expect(result.status).toBe(201);
  return { externalTransactionId, transactionId: result.body.transactionId };
}

describe('REFUND and ROLLBACK', () => {
  test('a REFUND gives back a processed BET and links to it', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const reference = await bet(wallet, '30.00');
    const refund = await submitJson(app.url, wallet, reversalOf('REFUND', reference.externalTransactionId, { amount: '30.00' }));

    expect(refund.status).toBe(201);
    expect(refund.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } });
    expect(await transaction(refund.body.transactionId)).toMatchObject({ referenceTransactionId: reference.transactionId });
    expect((await ledgerEntries(db.owner, wallet.walletId)).at(-1)).toMatchObject({ direction: 'CREDIT', amount: '30.00' });
    await expectLedgerInvariant(db.owner, wallet.walletId);
  });

  test('a transaction is reversed only once, whatever the kind', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const reference = await bet(wallet, '30.00');
    await submitJson(app.url, wallet, reversalOf('REFUND', reference.externalTransactionId, { amount: '30.00' }));

    const secondRefund = await submitJson(app.url, wallet, reversalOf('REFUND', reference.externalTransactionId, { amount: '30.00' }));
    const rollback = await submitJson(app.url, wallet, reversalOf('ROLLBACK', reference.externalTransactionId, { amount: '30.00' }));

    expect(secondRefund).toMatchObject({ status: 422, body: { failureCode: 'ALREADY_REVERSED' } });
    expect(rollback).toMatchObject({ status: 422, body: { failureCode: 'ALREADY_REVERSED' } });
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '100.00', version: 3 });
  });

  test('ROLLBACK of a WIN debits it back', async () => {
    const wallet = await createWallet(app.url, '10.00');
    const win = newExternalId();
    await submitJson(app.url, wallet, { kind: 'WIN', externalTransactionId: win, amount: '40.00' });
    const rollback = await submitJson(app.url, wallet, reversalOf('ROLLBACK', win, { amount: '40.00' }));

    expect(rollback.status).toBe(201);
    expect(rollback.body.balance?.amount).toBe('10.00');
    expect((await ledgerEntries(db.owner, wallet.walletId)).at(-1)).toMatchObject({ direction: 'DEBIT' });
    await expectLedgerInvariant(db.owner, wallet.walletId);
  });

  test('ROLLBACK that would overdraw is rejected with its own failure code', async () => {
    const wallet = await createWallet(app.url, '0.00');
    const win = newExternalId();
    await submitJson(app.url, wallet, { kind: 'WIN', externalTransactionId: win, amount: '40.00' });
    await submitJson(app.url, wallet, { amount: '35.00' });
    const rollback = await submitJson(app.url, wallet, reversalOf('ROLLBACK', win, { amount: '40.00' }));

    expect(rollback).toMatchObject({
      status: 422,
      body: { status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: { amount: '5.00' } },
    });
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '5.00', version: 3 });
  });

  test('ROLLBACK of a REFUND takes the refund back', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const reference = await bet(wallet, '30.00');
    const refundId = newExternalId();
    await submitJson(app.url, wallet, reversalOf('REFUND', reference.externalTransactionId, { amount: '30.00', externalTransactionId: refundId }));
    const rollback = await submitJson(app.url, wallet, reversalOf('ROLLBACK', refundId, { amount: '30.00' }));

    expect(rollback.status).toBe(201);
    expect(rollback.body.balance?.amount).toBe('70.00');
    await expectLedgerInvariant(db.owner, wallet.walletId);
  });

  test.each([
    ['a REFUND of a WIN', 'WIN', reversalOf('REFUND', '', { amount: '30.00' }), 'INVALID_REFERENCE_KIND'],
    ['a ROLLBACK of a LOSS', 'LOSS', reversalOf('ROLLBACK', '', { amount: '30.00' }), 'INVALID_REFERENCE_KIND'],
    ['a partial REFUND', 'BET', reversalOf('REFUND', '', { amount: '10.00' }), 'REFERENCE_AMOUNT_MISMATCH'],
    ['a REFUND from another round', 'BET', reversalOf('REFUND', '', { amount: '30.00', body: { roundId: 'round-2' } }), 'REFERENCE_MISMATCH'],
  ])('rejects %s', async (_, referenceKind, reversal, failureCode) => {
    const wallet = await createWallet(app.url, '100.00');
    const reference = newExternalId();
    await submitJson(app.url, wallet, { kind: referenceKind, externalTransactionId: reference, amount: '30.00' });
    const result = await submitJson(app.url, wallet, {
      ...reversal,
      body: { ...reversal.body, referenceExternalTransactionId: reference },
    });

    expect(result).toMatchObject({ status: 422, body: { status: 'REJECTED', failureCode } });
    await expectLedgerInvariant(db.owner, wallet.walletId);
  });

  test('a REFUND of a rejected BET is rejected', async () => {
    const wallet = await createWallet(app.url, '10.00');
    const reference = newExternalId();
    await submitJson(app.url, wallet, { externalTransactionId: reference, amount: '30.00' });
    const refund = await submitJson(app.url, wallet, reversalOf('REFUND', reference, { amount: '30.00' }));

    expect(refund).toMatchObject({ status: 422, body: { failureCode: 'REFERENCE_NOT_PROCESSED' } });
  });
});

describe('references that arrive late', () => {
  test('the REFUND waits, and is applied in the same commit as its BET', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const reference = newExternalId();
    const refundOptions = reversalOf('REFUND', reference, { amount: '30.00', externalTransactionId: newExternalId() });

    const pending = await submitJson(app.url, wallet, refundOptions);
    expect(pending).toMatchObject({
      status: 202,
      body: { status: 'PENDING_REFERENCE', balance: { amount: '100.00' } },
    });

    const placed = await submitJson(app.url, wallet, { externalTransactionId: reference, amount: '30.00' });
    expect(placed.body.balance?.amount).toBe('70.00');

    expect(await transaction(pending.body.transactionId)).toMatchObject({
      status: 'PROCESSED',
      referenceTransactionId: placed.body.transactionId,
    });
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '100.00', version: 3 });
    await expectLedgerInvariant(db.owner, wallet.walletId);

    const replay = await submitJson(app.url, wallet, refundOptions);
    expect(replay).toMatchObject({ status: 201, body: { status: 'PROCESSED', idempotentReplay: true } });
  });

  test('a chain resolves in cascade: ROLLBACK(REFUND(BET)) arriving backwards', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const betId = newExternalId();
    const refundId = newExternalId();

    const rollback = await submitJson(app.url, wallet, reversalOf('ROLLBACK', refundId, { amount: '30.00' }));
    const refund = await submitJson(app.url, wallet, reversalOf('REFUND', betId, { amount: '30.00', externalTransactionId: refundId }));
    expect([rollback.status, refund.status]).toEqual([202, 202]);

    await submitJson(app.url, wallet, { externalTransactionId: betId, amount: '30.00' });

    expect((await transaction(refund.body.transactionId)).status).toBe('PROCESSED');
    expect((await transaction(rollback.body.transactionId)).status).toBe('PROCESSED');
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '70.00', version: 4 });
    await expectLedgerInvariant(db.owner, wallet.walletId);
  });

  test('the worker rejects a reference found on another wallet', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const other = await createWallet(app.url, '100.00');
    const reference = newExternalId();
    const refund = await submitJson(app.url, wallet, reversalOf('REFUND', reference, { amount: '30.00' }));
    await submitJson(app.url, other, { externalTransactionId: reference, amount: '30.00' });

    expect((await transaction(refund.body.transactionId)).status).toBe('PENDING_REFERENCE');
    await worker.processDue(new Date(Date.now() + 60_000));
    expect(await transaction(refund.body.transactionId)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_MISMATCH',
    });
  });

  test('after 8 attempts without the reference it is REJECTED REFERENCE_NOT_FOUND', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const refund = await submitJson(app.url, wallet, reversalOf('REFUND', newExternalId(), { amount: '30.00' }));
    const attempts = async () => {
      const [row] = await db.owner.em
        .fork()
        .execute<{ attempts: number }[]>('select attempts from wager_transactions where id = ?', [refund.body.transactionId]);
      return row?.attempts;
    };

    let now = Date.now();
    for (let attempt = 1; attempt <= 7; attempt++) {
      now += 10 * 60_000;
      await worker.processDue(new Date(now));
      expect(await attempts()).toBe(attempt);
      expect((await transaction(refund.body.transactionId)).status).toBe('PENDING_REFERENCE');
    }
    await worker.processDue(new Date(now + 10 * 60_000));

    expect(await transaction(refund.body.transactionId)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
    });
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '100.00', version: 1 });
  });
});

describe('reversals under concurrency', () => {
  test('two REFUNDs of the same BET in parallel: one applies, one is ALREADY_REVERSED', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const reference = await bet(wallet, '30.00');
    const results = await Promise.all([
      submitJson(app.url, wallet, reversalOf('REFUND', reference.externalTransactionId, { amount: '30.00' })),
      submitJson(app.url, wallet, reversalOf('REFUND', reference.externalTransactionId, { amount: '30.00' })),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([201, 422]);
    expect(results.find((result) => result.status === 422)?.body.failureCode).toBe('ALREADY_REVERSED');
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '100.00', version: 3 });
  });

  test('two workers racing over the same due reversal credit it once', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const reference = newExternalId();
    const refund = await submitJson(app.url, wallet, reversalOf('REFUND', reference, { amount: '30.00' }));

    const fx = new SchemaFixtures(db.app.em);
    await fx.processed(
      { id: wallet.walletId, player_id: wallet.playerId, currency: 'BRL', balance_amount: '100.00' },
      { external_transaction_id: reference, amount: '30.00', round_id: 'round-1', game_id: 'fortune-chimp' },
    );

    const due = new Date(Date.now() + 60_000);
    await Promise.all([worker.processDue(due), worker.processDue(due), worker.processDue(due)]);

    expect((await transaction(refund.body.transactionId)).status).toBe('PROCESSED');
    const credits = (await ledgerEntries(db.owner, wallet.walletId)).filter(
      (entry) => entry.transaction_id === refund.body.transactionId,
    );
    expect(credits).toHaveLength(1);
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '130.00', version: 2 });
  });
});
