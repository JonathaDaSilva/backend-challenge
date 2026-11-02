import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type StartedApp, startApp, withConfig } from '../support/app';
import { CRASH_EXIT_CODE } from '../support/crash-exit-code';
import { initTestDatabases, type TestDatabases } from '../support/database';
import { consumerConfig, createTestQueues, queueDepth, sendWagerMessage, type TestQueues, waitFor } from '../support/queues';
import { createWallet, expectLedgerInvariant, ledgerEntries, walletBalance } from '../support/wagering';

let db: TestDatabases;
let queues: TestQueues;
let survivor: StartedApp | undefined;

beforeAll(async () => {
  db = await initTestDatabases();
  queues = await createTestQueues();
});

afterAll(async () => {
  await survivor?.close();
  await queues.dispose();
  await db.close();
});

describe('a consumer killed after commit and before ack', () => {
  test(
    'the redelivered message is recognised by the inbox and applied only once',
    async () => {
      const writer = await startApp(
        withConfig((config) => ({ ...config, sqs: { ...config.sqs, consumerEnabled: false } })),
      );
      const wallet = await createWallet(writer.url, '100.00');
      await writer.close();

      const sent = await sendWagerMessage(queues, wallet, { amount: '40.00' });
      const crashing = Bun.spawn({
        cmd: [Bun.argv[0] ?? 'bun', 'test/integration/support/crash-after-commit.ts'],
        env: {
          ...Bun.env,
          SQS_WAGER_QUEUE: queues.queueName,
          SQS_WAGER_DLQ: queues.dlqName,
          SQS_CONSUMER_ENABLED: 'true',
          SQS_WAIT_TIME_SECONDS: '1',
          SQS_VISIBILITY_TIMEOUT_SECONDS: '2',
          PENDING_REFERENCE_WORKER_ENABLED: 'false',
        },
        stdout: 'ignore',
        stderr: 'ignore',
      });

      expect(await crashing.exited).toBe(CRASH_EXIT_CODE);
      expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '60.00', version: 2 });
      expect(await queueDepth(queues)).toEqual({ visible: 0, inFlight: 1 });

      survivor = await startApp(withConfig(consumerConfig(queues)));
      expect(await waitFor(() => queueDepth(queues), (depth) => depth.visible + depth.inFlight === 0)).toEqual({
        visible: 0,
        inFlight: 0,
      });

      expect(await walletBalance(db.owner, wallet.walletId)).toEqual({ balance: '60.00', version: 2 });
      expect((await ledgerEntries(db.owner, wallet.walletId)).filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
      const [inbox] = await db.owner.em
        .fork()
        .execute<{ count: string }[]>('select count(*)::text as count from inbox_messages where message_id = ?', [
          sent.messageId,
        ]);
      expect(inbox?.count).toBe('1');
      await expectLedgerInvariant(db.owner, wallet.walletId);
    },
    40_000,
  );
});
