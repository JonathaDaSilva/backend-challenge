import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type StartedApp, startApp } from '../support/app';
import { initTestDatabases, type TestDatabases } from '../support/database';
import {
  createWallet,
  expectLedgerInvariant,
  ledgerEntries,
  submit,
  submitJson,
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

describe('POST /wagering/transactions', () => {
  test('BET debits the wallet and writes one DEBIT entry', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const result = await submitJson(app.url, wallet, { amount: '25.00' });

    expect(result.status).toBe(201);
    expect(result.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '75.00', version: 2 });
    const entries = await ledgerEntries(db.owner, wallet.walletId);
    expect(entries.at(-1)).toMatchObject({ direction: 'DEBIT', amount: '25.00', transaction_id: result.body.transactionId });
    await expectLedgerInvariant(db.owner, wallet.walletId);
  });

  test('WIN credits the wallet', async () => {
    const wallet = await createWallet(app.url, '10.00');
    const result = await submitJson(app.url, wallet, { kind: 'WIN', amount: '15.50' });

    expect(result.status).toBe(201);
    expect(result.body.balance).toEqual({ amount: '25.50', currency: 'BRL' });
    expect((await ledgerEntries(db.owner, wallet.walletId)).at(-1)).toMatchObject({ direction: 'CREDIT', amount: '15.50' });
    await expectLedgerInvariant(db.owner, wallet.walletId);
  });

  test('LOSS is recorded without touching the balance or the ledger', async () => {
    const wallet = await createWallet(app.url, '50.00');
    const result = await submitJson(app.url, wallet, { kind: 'LOSS', amount: '0.00' });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '50.00', currency: 'BRL' } });
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '50.00', version: 1 });
    expect(await ledgerEntries(db.owner, wallet.walletId)).toHaveLength(1);
  });

  test('a BET without funds is REJECTED, persisted, and moves nothing', async () => {
    const wallet = await createWallet(app.url, '20.00');
    const result = await submitJson(app.url, wallet, { amount: '20.01' });

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '20.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '20.00', version: 1 });
    expect(await ledgerEntries(db.owner, wallet.walletId)).toHaveLength(1);

    const stored = await fetch(`${app.url}/wagering/transactions/${result.body.transactionId}`);
    expect(await stored.json()).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
  });

  describe('idempotency', () => {
    test('the same key and payload replays the original result, even after the balance moved', async () => {
      const wallet = await createWallet(app.url, '100.00');
      const options = { externalTransactionId: `ext-${Bun.randomUUIDv7()}`, amount: '30.00' };
      const first = await submitJson(app.url, wallet, options);
      await submitJson(app.url, wallet, { kind: 'WIN', amount: '5.00' });
      const replay = await submitJson(app.url, wallet, options);

      expect(replay.status).toBe(first.status);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      expect(replay.body.balance?.amount).toBe('70.00');
      expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '75.00', version: 3 });
    });

    test('a rejected transaction replays as rejected', async () => {
      const wallet = await createWallet(app.url, '1.00');
      const options = { externalTransactionId: `ext-${Bun.randomUUIDv7()}`, amount: '2.00' };
      const first = await submitJson(app.url, wallet, options);
      const replay = await submitJson(app.url, wallet, options);

      expect(replay.status).toBe(422);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    });

    test('the same key with another payload is a conflict', async () => {
      const wallet = await createWallet(app.url);
      const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
      const first = await submitJson(app.url, wallet, { externalTransactionId, amount: '10.00' });
      const response = await submit(app.url, wallet, { externalTransactionId, amount: '11.00' });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        failureCode: 'IDEMPOTENCY_CONFLICT',
        transactionId: first.body.transactionId,
      });
      expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '90.00', version: 2 });
    });

    test('the same external id under another key is a conflict', async () => {
      const wallet = await createWallet(app.url);
      const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
      await submitJson(app.url, wallet, { externalTransactionId });
      const response = await submit(app.url, wallet, { externalTransactionId, idempotencyKey: `other:${externalTransactionId}` });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ failureCode: 'DUPLICATE_EXTERNAL_TRANSACTION' });
    });

    test('the Idempotency-Key header is required', async () => {
      const wallet = await createWallet(app.url);
      const response = await submit(app.url, wallet, { idempotencyKey: null });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ failureCode: 'INVALID_PAYLOAD', issues: [{ path: 'idempotencyKey' }] });
    });
  });

  describe('validation and context', () => {
    test.each([
      ['OPENING', { kind: 'OPENING' }, 400, 'INVALID_PAYLOAD'],
      ['an unknown kind', { kind: 'JACKPOT' }, 400, 'INVALID_PAYLOAD'],
      ['a zero BET', { amount: '0.00' }, 400, 'INVALID_PAYLOAD'],
      ['a numeric amount', { body: { money: { amount: 10, currency: 'BRL' } } }, 400, 'INVALID_PAYLOAD'],
      ['a WIN with a reference', { kind: 'WIN', body: { referenceExternalTransactionId: 'ext-0' } }, 400, 'INVALID_PAYLOAD'],
      ['a REFUND without reference', { kind: 'REFUND' }, 400, 'INVALID_PAYLOAD'],
      ['another currency', { currency: 'USD' }, 422, 'CURRENCY_MISMATCH'],
    ])('rejects %s', async (_, options, status, failureCode) => {
      const wallet = await createWallet(app.url);
      const response = await submit(app.url, wallet, options);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ failureCode });
      expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '100.00', version: 1 });
    });

    test('rejects a wallet that belongs to another player', async () => {
      const wallet = await createWallet(app.url);
      const response = await submit(app.url, { ...wallet, playerId: Bun.randomUUIDv7() });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ failureCode: 'WALLET_PLAYER_MISMATCH' });
    });

    test('rejects a walletId in the body that does not exist with 422, not 404', async () => {
      const response = await submit(app.url, { walletId: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ failureCode: 'UNKNOWN_WALLET', retryable: false });
    });
  });
});

describe('GET transactions', () => {
  test('by internal id and by provider + external id', async () => {
    const wallet = await createWallet(app.url);
    const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
    const { body } = await submitJson(app.url, wallet, { externalTransactionId, amount: '12.34' });

    const byId = await fetch(`${app.url}/wagering/transactions/${body.transactionId}`);
    const byExternal = await fetch(`${app.url}/providers/provider-a/wagering/transactions/${externalTransactionId}`);
    const expected = {
      transactionId: body.transactionId,
      providerId: 'provider-a',
      externalTransactionId,
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: 'BET',
      money: { amount: '12.34', currency: 'BRL' },
      status: 'PROCESSED',
      balance: { amount: '87.66', currency: 'BRL' },
    };

    expect(byId.status).toBe(200);
    expect(await byId.json()).toMatchObject(expected);
    expect(byExternal.status).toBe(200);
    expect(await byExternal.json()).toMatchObject(expected);
  });

  test('404 for unknown transactions', async () => {
    expect((await fetch(`${app.url}/wagering/transactions/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await fetch(`${app.url}/providers/provider-a/wagering/transactions/nope`)).status).toBe(404);
  });
});
