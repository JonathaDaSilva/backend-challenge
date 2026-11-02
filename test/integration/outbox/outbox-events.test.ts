import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PendingReferenceWorker } from '../../../src/modules/wagering/application/pending-reference-worker';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../../../src/modules/wallet/application/ports';
import { type StartedApp, startApp, withConfig } from '../support/app';
import { initTestDatabases, type TestDatabases } from '../support/database';
import { createWallet, submitJson } from '../support/wagering';

let app: StartedApp;
let db: TestDatabases;

const disabled = withConfig((config) => ({
  ...config,
  events: { ...config.events, publisherEnabled: false },
  pendingReference: { ...config.pendingReference, workerEnabled: false },
  sqs: { ...config.sqs, consumerEnabled: false },
}));

beforeAll(async () => {
  db = await initTestDatabases();
  app = await startApp(disabled);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

interface OutboxRow {
  event_type: string;
  aggregate_id: string;
  published: boolean;
  payload: {
    eventId: string;
    eventType: string;
    version: number;
    correlationId: string;
    causationId?: string;
    data: Record<string, unknown>;
  };
}

const correlation = () => ({ 'x-correlation-id': `corr-${Bun.randomUUIDv7()}` });

async function outboxFor(headers: Record<string, string>): Promise<OutboxRow[]> {
  return db.owner.em.fork().execute<OutboxRow[]>(
    `select event_type, aggregate_id, published_at is not null as published, payload
       from outbox_messages where payload->>'correlationId' = ? order by seq`,
    [headers['x-correlation-id']],
  );
}

const types = (rows: OutboxRow[]) => rows.map((row) => row.event_type);

describe('events written to the outbox in the same commit', () => {
  test('opening a wallet with balance records WalletBalanceChanged', async () => {
    const headers = correlation();
    const wallet = await createWallet(app.url, '100.00', headers);
    const rows = await outboxFor(headers);

    expect(types(rows)).toEqual(['WalletBalanceChanged']);
    expect(rows[0]).toMatchObject({ aggregate_id: wallet.walletId, published: false });
    expect(rows[0]?.payload.data).toMatchObject({
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '100.00', currency: 'BRL' },
      walletVersion: 1,
    });
  });

  test('a processed BET records the transaction and the balance change, caused by the transaction', async () => {
    const wallet = await createWallet(app.url);
    const headers = correlation();
    const { body } = await submitJson(app.url, wallet, { amount: '25.00', headers });
    const rows = await outboxFor(headers);

    expect(types(rows)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    const [processed, changed] = rows;
    expect(processed).toMatchObject({ aggregate_id: body.transactionId });
    expect(processed?.payload).toMatchObject({
      eventType: 'WagerTransactionProcessed',
      version: 1,
      data: { kind: 'BET', money: { amount: '25.00', currency: 'BRL' }, balance: { amount: '75.00', currency: 'BRL' } },
    });
    expect(changed).toMatchObject({ aggregate_id: wallet.walletId });
    expect(changed?.payload).toMatchObject({
      causationId: body.transactionId,
      data: { direction: 'DEBIT', walletVersion: 2, balanceAfter: { amount: '75.00', currency: 'BRL' } },
    });
    expect(new Set(rows.map((row) => row.payload.eventId)).size).toBe(2);
  });

  test('a LOSS records only WagerTransactionProcessed', async () => {
    const wallet = await createWallet(app.url);
    const headers = correlation();
    await submitJson(app.url, wallet, { kind: 'LOSS', amount: '0.00', headers });
    expect(types(await outboxFor(headers))).toEqual(['WagerTransactionProcessed']);
  });

  test('a rejection records only WagerTransactionRejected', async () => {
    const wallet = await createWallet(app.url, '1.00');
    const headers = correlation();
    await submitJson(app.url, wallet, { amount: '5.00', headers });
    const rows = await outboxFor(headers);

    expect(types(rows)).toEqual(['WagerTransactionRejected']);
    expect(rows[0]?.payload.data).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS' });
  });

  test('a late reference: PendingReference first, then both transactions settle in one commit', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const betId = `ext-${Bun.randomUUIDv7()}`;
    const refundHeaders = correlation();
    const refund = await submitJson(app.url, wallet, {
      kind: 'REFUND',
      amount: '30.00',
      headers: refundHeaders,
      body: { referenceExternalTransactionId: betId },
    });
    expect(types(await outboxFor(refundHeaders))).toEqual(['WagerTransactionPendingReference']);

    const betHeaders = correlation();
    const bet = await submitJson(app.url, wallet, { externalTransactionId: betId, amount: '30.00', headers: betHeaders });
    const rows = await outboxFor(betHeaders);

    expect(rows.map((row) => [row.event_type, row.aggregate_id])).toEqual([
      ['WagerTransactionProcessed', bet.body.transactionId],
      ['WalletBalanceChanged', wallet.walletId],
      ['WagerTransactionProcessed', refund.body.transactionId],
      ['WalletBalanceChanged', wallet.walletId],
    ]);
    expect(rows[2]?.payload.causationId).toBe(bet.body.transactionId);
    expect(rows[3]?.payload.data).toMatchObject({ direction: 'CREDIT', walletVersion: 3 });
  });

  test('an expired reversal records WagerTransactionRejected with REFERENCE_NOT_FOUND', async () => {
    const wallet = await createWallet(app.url);
    const { body } = await submitJson(app.url, wallet, {
      kind: 'REFUND',
      amount: '10.00',
      body: { referenceExternalTransactionId: `ext-${Bun.randomUUIDv7()}` },
    });
    const worker = app.get<PendingReferenceWorker>(PendingReferenceWorker);
    let now = Date.now();
    for (let attempt = 0; attempt < 8; attempt++) {
      now += 10 * 60_000;
      await worker.processDue(new Date(now));
    }

    const [row] = await db.owner.em
      .fork()
      .execute<OutboxRow[]>(
        "select event_type, aggregate_id, payload from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionRejected'",
        [body.transactionId],
      );
    expect(row?.payload.data).toMatchObject({ failureCode: 'REFERENCE_NOT_FOUND' });
  });

  test('a rolled back operation leaves nothing in the outbox', async () => {
    const broken = await startApp((builder) =>
      disabled(builder)
        .overrideProvider(LEDGER_REPOSITORY)
        .useValue({ append: () => Promise.reject(new Error('ledger unavailable')) } satisfies LedgerRepository),
    );
    const headers = correlation();
    try {
      const response = await fetch(`${broken.url}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ playerId: Bun.randomUUIDv7(), initialBalance: { amount: '10.00', currency: 'BRL' } }),
      });
      expect(response.status).toBe(500);
    } finally {
      await broken.close();
    }
    expect(await outboxFor(headers)).toEqual([]);
  });
});
