import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { initTestDatabases, type TestDatabases } from '../support/database';
import { type Instance, startInstance, startInstances, stopInstances } from '../support/instances';
import {
  createEventsQueue,
  createTestQueues,
  type EventsQueue,
  queueDepth,
  sendWagerMessage,
  type TestQueues,
  waitFor,
} from '../support/queues';
import { CRASH_EXIT_CODE } from '../support/crash-exit-code';
import { createWallet, expectLedgerInvariant, type SubmitOptions, submit, type TestWallet } from '../support/wagering';

const WALLETS = 8;
const CHUNK = 16;
const RESTART_AFTER_CHUNK = 6;
const CRASHING_ENTRY = 'test/integration/support/crash-after-commit-http.ts';

let db: TestDatabases;
let queues: TestQueues;
let events: EventsQueue;
let instances: Instance[];
let env: Record<string, string>;

interface Operation {
  readonly wallet: TestWallet;
  readonly options: SubmitOptions & { externalTransactionId: string };
  readonly label: string;
}

interface Outcome {
  readonly status: number;
  readonly transactionId: string;
}

beforeAll(async () => {
  db = await initTestDatabases();
  queues = await createTestQueues();
  events = await createEventsQueue();
  env = {
    SQS_WAGER_QUEUE: queues.queueName,
    SQS_WAGER_DLQ: queues.dlqName,
    SQS_VISIBILITY_TIMEOUT_SECONDS: '3',
    SQS_WAIT_TIME_SECONDS: '1',
    EVENTS_QUEUE: events.queueName,
  };
  const [first, third] = await startInstances(2, env);
  if (!first || !third) throw new Error('instances did not start');
  const crashing = await startInstance(third.port + 1, { ...env, CRASH_ON_SUBMISSION: '3' }, CRASHING_ENTRY);
  instances = [first, crashing, third];
}, 60_000);

afterAll(async () => {
  await stopInstances(instances);
  await queues.dispose();
  await events.dispose();
  await db.close();
});

function workload(wallets: readonly TestWallet[]): Operation[][] {
  const early: Operation[] = [];
  const main: Operation[] = [];
  for (const wallet of wallets) {
    const bets = Array.from({ length: 8 }, (_, index) => ({ index, id: `ext-${Bun.randomUUIDv7()}` }));
    const op = (label: string, options: Operation['options']): Operation => ({ wallet, label, options });

    early.push(
      op('refund-before-bet', {
        kind: 'REFUND',
        amount: '10.00',
        externalTransactionId: `ext-${Bun.randomUUIDv7()}`,
        body: { referenceExternalTransactionId: bets[1]?.id },
      }),
    );
    for (const bet of bets) main.push(op('bet', { amount: '10.00', externalTransactionId: bet.id }));
    for (let index = 0; index < 3; index++) {
      main.push(op('win', { kind: 'WIN', amount: '5.00', externalTransactionId: `ext-${Bun.randomUUIDv7()}` }));
    }
    for (let index = 0; index < 2; index++) {
      main.push(op('loss', { kind: 'LOSS', amount: '0.00', externalTransactionId: `ext-${Bun.randomUUIDv7()}` }));
    }
    main.push(
      op('refund', {
        kind: 'REFUND',
        amount: '10.00',
        externalTransactionId: `ext-${Bun.randomUUIDv7()}`,
        body: { referenceExternalTransactionId: bets[0]?.id },
      }),
    );
    main.push(op('duplicate', { amount: '10.00', externalTransactionId: bets[2]?.id ?? '' }));
    main.push(op('duplicate', { amount: '10.00', externalTransactionId: bets[2]?.id ?? '' }));
  }
  const ordered = [...early, ...interleave(main, wallets.length)];
  return Array.from({ length: Math.ceil(ordered.length / CHUNK) }, (_, index) =>
    ordered.slice(index * CHUNK, (index + 1) * CHUNK),
  );
}

function interleave(operations: Operation[], wallets: number): Operation[] {
  const perWallet = operations.length / wallets;
  return Array.from({ length: operations.length }, (_, index) => {
    const wallet = index % wallets;
    const position = Math.floor(index / wallets);
    return operations[wallet * perWallet + position] as Operation;
  });
}

async function send(instance: Instance, operation: Operation): Promise<Outcome | undefined> {
  try {
    const response = await submit(instance.url, operation.wallet, operation.options);
    const body = (await response.json()) as { transactionId?: string };
    if (!body.transactionId) return undefined;
    return { status: response.status, transactionId: body.transactionId };
  } catch {
    return undefined;
  }
}

async function transactionStatus(externalTransactionId: string): Promise<{ id: string; status: string } | undefined> {
  const [row] = await db.owner.em
    .fork()
    .execute<{ id: string; status: string }[]>(
      "select id, status from wager_transactions where provider_id = 'provider-a' and external_transaction_id = ?",
      [externalTransactionId],
    );
  return row;
}

describe('restart with eventual consistency', () => {
  test(
    'killing an instance in the middle of a mixed load leaves every wallet consistent once it settles',
    async () => {
      const wallets = await Promise.all(Array.from({ length: WALLETS }, () => createWallet(instances[0]?.url ?? '', '300.00')));
      for (const wallet of wallets) {
        await sendWagerMessage(queues, wallet, { amount: '3.00' });
        await sendWagerMessage(queues, wallet, { amount: '3.00' });
      }

      const chunks = workload(wallets);
      const outcomes = new Map<Operation, Outcome>();
      const lost: Operation[] = [];

      for (const [index, chunk] of chunks.entries()) {
        if (index === RESTART_AFTER_CHUNK + 1) {
          const crashed = instances[1] as Instance;
          expect(await crashed.process.exited).toBe(CRASH_EXIT_CODE);
          instances[1] = await startInstance(crashed.port, env);
        }
        const results = await Promise.all(
          chunk.map((operation, position) => send(instances[position % instances.length] as Instance, operation)),
        );
        results.forEach((outcome, position) => {
          const operation = chunk[position] as Operation;
          if (outcome) outcomes.set(operation, outcome);
          else lost.push(operation);
        });
      }

      // A instância 1 morreu logo depois de comitar a 3ª submissão: há perdas com e sem commit.
      const committedBeforeRetry = await Promise.all(
        lost.map((operation) => transactionStatus(operation.options.externalTransactionId)),
      );
      expect(committedBeforeRetry.filter(Boolean).length).toBeGreaterThan(0);
      expect(committedBeforeRetry.filter((stored) => !stored).length).toBeGreaterThan(0);
      for (const operation of lost) {
        const outcome = await waitFor(
          () => send(instances[0] as Instance, operation),
          (candidate) => candidate !== undefined,
          10_000,
        );
        if (!outcome) throw new Error(`could not settle ${operation.label} ${operation.options.externalTransactionId}`);
        outcomes.set(operation, outcome);
      }

      await waitFor(() => queueDepth(queues), (depth) => depth.visible + depth.inFlight === 0, 30_000);
      const walletIds = wallets.map((wallet) => wallet.walletId);
      await waitFor(
        async () => {
          const [row] = await db.owner.em.fork().execute<{ pending: number }[]>(
            `select count(*)::int as pending from wager_transactions
              where wallet_id = any(?::uuid[]) and status = 'PENDING_REFERENCE'`,
            [`{${walletIds.join(',')}}`],
          );
          return row?.pending ?? 0;
        },
        (pending) => pending === 0,
        20_000,
      );
      await waitFor(
        async () => {
          const [row] = await db.owner.em.fork().execute<{ pending: number }[]>(
            `select count(*)::int as pending from outbox_messages o
              where o.published_at is null
                and (o.aggregate_id = any(?::uuid[])
                     or o.aggregate_id in (select id from wager_transactions where wallet_id = any(?::uuid[])))`,
            [`{${walletIds.join(',')}}`, `{${walletIds.join(',')}}`],
          );
          return row?.pending ?? 0;
        },
        (pending) => pending === 0,
        20_000,
      );

      for (const [operation, outcome] of outcomes) {
        const stored = await transactionStatus(operation.options.externalTransactionId);
        expect(stored?.id).toBe(outcome.transactionId);
        const expected = outcome.status === 422 ? 'REJECTED' : 'PROCESSED';
        expect({ label: operation.label, status: stored?.status }).toEqual({ label: operation.label, status: expected });
      }

      for (const wallet of wallets) {
        await expectLedgerInvariant(db.owner, wallet.walletId);
        const [counts] = await db.owner.em.fork().execute<{ entries: number; moving: number; processedEvents: number }[]>(
          `select (select count(*)::int from wallet_ledger_entries where wallet_id = ?) as entries,
                  (select count(*)::int from wager_transactions
                    where wallet_id = ? and status = 'PROCESSED' and kind in ('OPENING', 'BET', 'WIN', 'REFUND')) as moving,
                  (select count(*)::int from outbox_messages o
                     join wager_transactions t on t.id = o.aggregate_id
                    where t.wallet_id = ? and o.event_type = 'WagerTransactionProcessed') as "processedEvents"`,
          [wallet.walletId, wallet.walletId, wallet.walletId],
        );
        const [processed] = await db.owner.em.fork().execute<{ count: number }[]>(
          "select count(*)::int as count from wager_transactions where wallet_id = ? and status = 'PROCESSED' and kind <> 'OPENING'",
          [wallet.walletId],
        );
        expect(counts?.entries).toBe(counts?.moving);
        expect(counts?.processedEvents).toBe(processed?.count);
      }
    },
    120_000,
  );
});
