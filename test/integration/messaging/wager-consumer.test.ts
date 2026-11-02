import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { WAGER_TRANSACTION_REPOSITORY, type WagerTransactionRepository } from '../../../src/modules/wagering/application/ports';
import {
  type SubmitWagerTransactionCommand,
  SubmitWagerTransactionUseCase,
} from '../../../src/modules/wagering/application/submit-wager-transaction.use-case';
import { WagerProcessor } from '../../../src/modules/wagering/application/wager-processor';
import { WALLET_REPOSITORY, type WalletRepository } from '../../../src/modules/wallet/application/ports';
import { CLOCK, type Clock } from '../../../src/shared/application/clock';
import { CORRELATION_CONTEXT, type CorrelationContext } from '../../../src/shared/application/correlation';
import { METRICS, type Metrics } from '../../../src/shared/application/observability';
import { ID_GENERATOR, type IdGenerator } from '../../../src/shared/application/id-generator';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../../../src/shared/application/transaction-runner';
import { type StartedApp, startApp, withConfig } from '../support/app';
import { initTestDatabases, type TestDatabases } from '../support/database';
import {
  consumerConfig,
  createTestQueues,
  drainDeadLetters,
  queueDepth,
  sendWagerMessage,
  type TestQueues,
  waitFor,
} from '../support/queues';
import { createWallet, expectLedgerInvariant, ledgerEntries, walletBalance } from '../support/wagering';

let db: TestDatabases;
let queues: TestQueues;
let app: StartedApp | undefined;

beforeAll(async () => {
  db = await initTestDatabases();
});

afterAll(() => db.close());

afterEach(async () => {
  await app?.close();
  app = undefined;
  await queues?.dispose();
});

type Configure = (builder: TestingModuleBuilder) => TestingModuleBuilder;

async function startConsumer(sqsOverrides: Parameters<typeof consumerConfig>[1] = {}, extra?: Configure) {
  queues = await createTestQueues();
  const withQueues = withConfig(consumerConfig(queues, sqsOverrides));
  app = await startApp((builder) => (extra ? extra(withQueues(builder)) : withQueues(builder)));
  return app;
}

function wrapSubmit(wrap: (real: SubmitWagerTransactionUseCase) => Pick<SubmitWagerTransactionUseCase, 'execute'>): Configure {
  return (builder) =>
    builder.overrideProvider(SubmitWagerTransactionUseCase).useFactory({
      inject: [
        WALLET_REPOSITORY,
        WAGER_TRANSACTION_REPOSITORY,
        WagerProcessor,
        TRANSACTION_RUNNER,
        ID_GENERATOR,
        CLOCK,
        METRICS,
        CORRELATION_CONTEXT,
      ],
      factory: (
        wallets: WalletRepository,
        transactions: WagerTransactionRepository,
        processor: WagerProcessor,
        runner: TransactionRunner,
        ids: IdGenerator,
        clock: Clock,
        metrics: Metrics,
        context: CorrelationContext,
      ) => wrap(new SubmitWagerTransactionUseCase({ wallets, transactions, processor, runner, ids, clock, metrics, context })),
    });
}

const transientError = () => Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });

async function transactionByExternalId(externalTransactionId: string) {
  const response = await fetch(`${app?.url}/providers/provider-a/wagering/transactions/${externalTransactionId}`);
  return response.status === 200 ? ((await response.json()) as { status: string; failureCode?: string }) : undefined;
}

async function inboxRows(messageId: string): Promise<number> {
  const [row] = await db.owner.em
    .fork()
    .execute<{ count: string }[]>('select count(*)::text as count from inbox_messages where message_id = ?', [messageId]);
  return Number(row?.count ?? 0);
}

const emptyQueue = (depth: { visible: number; inFlight: number }) => depth.visible === 0 && depth.inFlight === 0;

describe('SQS consumer', () => {
  test('applies a BET, records the inbox and acks after commit', async () => {
    const consumer = await startConsumer();
    const wallet = await createWallet(consumer.url, '100.00');
    const sent = await sendWagerMessage(queues, wallet, { amount: '25.00' });

    expect(await waitFor(() => transactionByExternalId(sent.externalTransactionId), (tx) => tx?.status === 'PROCESSED')).toMatchObject({
      status: 'PROCESSED',
    });
    expect(await waitFor(() => queueDepth(queues), emptyQueue)).toEqual({ visible: 0, inFlight: 0 });
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '75.00', version: 2 });
    expect(await inboxRows(sent.messageId)).toBe(1);
  });

  test('the same messageId delivered twice has a single effect', async () => {
    const consumer = await startConsumer();
    const wallet = await createWallet(consumer.url, '100.00');
    const sent = await sendWagerMessage(queues, wallet, { amount: '10.00' });
    await sendWagerMessage(queues, wallet, { ...sent, amount: '10.00' });

    await waitFor(() => queueDepth(queues), emptyQueue);
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '90.00', version: 2 });
    expect(await inboxRows(sent.messageId)).toBe(1);
  });

  test('a new messageId with the same Idempotency-Key replays instead of applying again', async () => {
    const consumer = await startConsumer();
    const wallet = await createWallet(consumer.url, '100.00');
    const sent = await sendWagerMessage(queues, wallet, { amount: '10.00' });
    const resent = await sendWagerMessage(queues, wallet, {
      externalTransactionId: sent.externalTransactionId,
      idempotencyKey: sent.idempotencyKey,
      amount: '10.00',
    });

    await waitFor(() => queueDepth(queues), emptyQueue);
    expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '90.00', version: 2 });
    expect([await inboxRows(sent.messageId), await inboxRows(resent.messageId)]).toEqual([1, 1]);
  });

  test('a business rejection is persisted and acked', async () => {
    const consumer = await startConsumer();
    const wallet = await createWallet(consumer.url, '5.00');
    const sent = await sendWagerMessage(queues, wallet, { amount: '10.00' });

    expect(await waitFor(() => transactionByExternalId(sent.externalTransactionId), (tx) => tx !== undefined)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    expect(await waitFor(() => queueDepth(queues), emptyQueue)).toEqual({ visible: 0, inFlight: 0 });
    expect(await drainDeadLetters(queues)).toHaveLength(0);
  });

  test('a rejection that cannot be persisted (unknown wallet) is acked, not dead-lettered', async () => {
    await startConsumer();
    const sent = await sendWagerMessage(queues, { walletId: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() });

    expect(await waitFor(() => queueDepth(queues), emptyQueue)).toEqual({ visible: 0, inFlight: 0 });
    expect(await drainDeadLetters(queues)).toHaveLength(0);
    expect(await transactionByExternalId(sent.externalTransactionId)).toBeUndefined();
  });

  test.each([
    ['a body that is not JSON', { rawBody: '{"messageId":' }],
    ['a numeric amount', { data: { money: { amount: 10, currency: 'BRL' } } }],
    ['an unknown message type', { rawBody: JSON.stringify({ messageId: 'm', type: 'Other', occurredAt: new Date().toISOString(), data: {} }) }],
  ])('%s goes straight to the DLQ', async (_, options) => {
    const consumer = await startConsumer();
    const wallet = await createWallet(consumer.url);
    await sendWagerMessage(queues, wallet, options);

    const dead = await waitFor(() => drainDeadLetters(queues), (messages) => messages.length > 0);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.MessageAttributes?.failureCode?.StringValue).toBe('INVALID_PAYLOAD');
    expect(dead[0]?.MessageAttributes?.receiveCount?.StringValue).toBe('1');
    expect(await queueDepth(queues)).toEqual({ visible: 0, inFlight: 0 });
  });

  test(
    'a transient failure is retried with backoff and then applied once',
    async () => {
      let calls = 0;
      const flaky = wrapSubmit((real) => ({
        execute: (command: SubmitWagerTransactionCommand) => {
          calls++;
          return calls <= 2 ? Promise.reject(transientError()) : real.execute(command);
        },
      }));
      const consumer = await startConsumer({ maxAttempts: 5 }, flaky);
      const wallet = await createWallet(consumer.url, '100.00');
      const started = Date.now();
      const sent = await sendWagerMessage(queues, wallet, { amount: '10.00' });

      await waitFor(() => transactionByExternalId(sent.externalTransactionId), (tx) => tx?.status === 'PROCESSED', 20_000);
      expect(calls).toBe(3);
      expect(Date.now() - started).toBeGreaterThanOrEqual(3_000);
      expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '90.00', version: 2 });
      expect(await inboxRows(sent.messageId)).toBe(1);
      await expectLedgerInvariant(db.owner, wallet.walletId);
    },
    30_000,
  );

  test(
    'after the last attempt the transaction is recorded as FAILED and the message dead-lettered',
    async () => {
      const broken = wrapSubmit(() => ({ execute: () => Promise.reject(transientError()) }));
      const consumer = await startConsumer({ maxAttempts: 3 }, broken);
      const wallet = await createWallet(consumer.url, '100.00');
      const sent = await sendWagerMessage(queues, wallet, { amount: '10.00' });

      const dead = await waitFor(() => drainDeadLetters(queues), (messages) => messages.length > 0, 20_000);
      expect(dead[0]?.MessageAttributes?.failureCode?.StringValue).toBe('PERMANENT_FAILURE');
      expect(dead[0]?.MessageAttributes?.receiveCount?.StringValue).toBe('3');
      expect(await transactionByExternalId(sent.externalTransactionId)).toMatchObject({
        status: 'FAILED',
        failureCode: 'PERMANENT_FAILURE',
      });
      expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '100.00', version: 1 });
    },
    30_000,
  );

  test(
    'shutdown finishes the message in flight and hands the unstarted ones back at once',
    async () => {
      const inFlight = Promise.withResolvers<void>();
      const slow = wrapSubmit((real) => ({
        execute: async (command: SubmitWagerTransactionCommand) => {
          inFlight.resolve();
          await Bun.sleep(1_000);
          return real.execute(command);
        },
      }));
      const consumer = await startConsumer({ visibilityTimeoutSeconds: 30, batchSize: 10 }, slow);
      const wallet = await createWallet(consumer.url, '100.00');
      for (let index = 0; index < 3; index++) await sendWagerMessage(queues, wallet, { amount: '10.00' });

      await inFlight.promise;
      await consumer.close();
      app = undefined;

      expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '90.00', version: 2 });
      expect(await queueDepth(queues)).toEqual({ visible: 2, inFlight: 0 });
      expect((await ledgerEntries(db.owner, wallet.walletId)).filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
    },
    30_000,
  );
});
