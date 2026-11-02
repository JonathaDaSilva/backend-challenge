import { afterEach, describe, expect, test } from 'bun:test';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { JsonLogger } from '../../src/shared/infrastructure/json-logger';
import { type StartedApp, startApp, withConfig } from './support/app';
import { initTestDatabases } from './support/database';
import { consumerConfig, createTestQueues, queueDepth, sendWagerMessage, type TestQueues, waitFor } from './support/queues';
import { createWallet, submit, submitJson } from './support/wagering';

const started: StartedApp[] = [];
let queues: TestQueues | undefined;

afterEach(async () => {
  await Promise.all(started.splice(0).map((app) => app.close()));
  await queues?.dispose();
  queues = undefined;
});

type LogLine = Record<string, unknown>;

async function appWithLogs(configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder) {
  const lines: LogLine[] = [];
  const raw: string[] = [];
  const logger = new JsonLogger('debug', (line) => {
    raw.push(line);
    lines.push(JSON.parse(line) as LogLine);
  });
  const app = await startApp(configure, { logger });
  started.push(app);
  return { app, lines, raw };
}

async function scrape(app: StartedApp): Promise<string> {
  const response = await fetch(`${app.url}/metrics`);
  expect(response.headers.get('content-type')).toContain('text/plain');
  return response.text();
}

function sample(metrics: string, name: string, labels: Record<string, string> = {}): number {
  return metrics
    .split('\n')
    .filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `))
    .filter((line) => Object.entries(labels).every(([key, value]) => line.includes(`${key}="${value}"`)))
    .reduce((sum, line) => sum + Number(line.split(' ').at(-1)), 0);
}

describe('structured logs', () => {
  test('an HTTP bet is logged with its context and without amounts or balances', async () => {
    const { app, lines, raw } = await appWithLogs();
    const wallet = await createWallet(app.url, '100.00');
    const correlationId = `corr-${Bun.randomUUIDv7()}`;
    const { body } = await submitJson(app.url, wallet, {
      amount: '37.91',
      headers: { 'x-correlation-id': correlationId },
    });

    const ours = lines.filter((line) => line.correlationId === correlationId);
    expect(ours.find((line) => line.msg === 'wager transaction settled')).toMatchObject({
      level: 'info',
      source: 'http',
      providerId: 'provider-a',
      walletId: wallet.walletId,
      transactionId: body.transactionId,
      kind: 'BET',
      status: 'PROCESSED',
    });
    expect(ours.find((line) => line.msg === 'http request')).toMatchObject({
      method: 'POST',
      route: '/wagering/transactions',
      status: 201,
      transactionId: body.transactionId,
      durationMs: expect.any(Number),
    });
    expect(raw.filter((line) => line.includes('37.91') || line.includes('62.09'))).toEqual([]);
  });

  test(
    'a message from SQS is logged with its messageId',
    async () => {
      queues = await createTestQueues();
      const { app, lines } = await appWithLogs(withConfig(consumerConfig(queues)));
      const wallet = await createWallet(app.url, '100.00');
      const sent = await sendWagerMessage(queues, wallet, { amount: '10.00' });

      await waitFor(
        async () => lines.find((line) => line.messageId === sent.messageId && line.msg === 'wager transaction settled'),
        (line) => line !== undefined,
      );
      expect(lines.find((line) => line.messageId === sent.messageId)).toMatchObject({
        correlationId: sent.messageId,
        source: 'sqs',
        walletId: wallet.walletId,
      });
    },
    20_000,
  );
});

describe('GET /metrics', () => {
  test(
    'counts outcomes, duplicates, lock conflicts and latency, with no ids in labels',
    async () => {
      const db = await initTestDatabases();
      const { app } = await appWithLogs(
        withConfig((config) => ({ ...config, events: { ...config.events, publisherEnabled: false } })),
      );
      try {
        const wallet = await createWallet(app.url, '10.00');
        const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
        await submitJson(app.url, wallet, { externalTransactionId, amount: '4.00' });
        await submitJson(app.url, wallet, { externalTransactionId, amount: '4.00' });
        await submitJson(app.url, wallet, { amount: '50.00' });

        const locked = Promise.withResolvers<void>();
        const holder = db.owner.em.fork().transactional(async (em) => {
          await em.execute('select id from wallets where id = ? for update', [wallet.walletId]);
          locked.resolve();
          await Bun.sleep(3_000);
        });
        await locked.promise;
        expect((await submit(app.url, wallet, { amount: '1.00' })).status).toBe(503);
        await holder;

        const metrics = await scrape(app);
        expect(sample(metrics, 'wager_transactions_total', { kind: 'BET', status: 'PROCESSED', source: 'http' })).toBe(1);
        expect(sample(metrics, 'wager_transactions_total', { kind: 'BET', status: 'REJECTED', source: 'http' })).toBe(1);
        expect(sample(metrics, 'wager_duplicates_total', { type: 'idempotent_replay' })).toBe(1);
        expect(sample(metrics, 'db_lock_conflicts_total', { reason: 'lock_timeout' })).toBe(1);
        expect(
          sample(metrics, 'http_request_duration_seconds_count', { route: '/wagering/transactions', status: '201' }),
        ).toBe(2);
        expect(sample(metrics, 'wager_processing_duration_seconds_count', { source: 'http', kind: 'BET' })).toBe(4);
        expect(sample(metrics, 'outbox_pending_events')).toBeGreaterThan(0);
        expect(sample(metrics, 'outbox_oldest_pending_age_seconds')).toBeGreaterThan(0);
        expect(metrics).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      } finally {
        await db.close();
      }
    },
    30_000,
  );

  test(
    'counts SQS dead letters and inbox duplicates',
    async () => {
      queues = await createTestQueues();
      const { app } = await appWithLogs(withConfig(consumerConfig(queues)));
      const wallet = await createWallet(app.url, '100.00');
      const sent = await sendWagerMessage(queues, wallet, { amount: '1.00' });
      await sendWagerMessage(queues, wallet, { ...sent, amount: '1.00' });
      await sendWagerMessage(queues, wallet, { rawBody: 'not json' });
      await waitFor(() => queueDepth(queues as TestQueues), (depth) => depth.visible + depth.inFlight === 0);

      const metrics = await scrape(app);
      expect(sample(metrics, 'wager_duplicates_total', { type: 'inbox_duplicate' })).toBe(1);
      expect(sample(metrics, 'sqs_dead_letters_total', { failure_code: 'INVALID_PAYLOAD' })).toBe(1);
      expect(sample(metrics, 'wager_transactions_total', { source: 'sqs', status: 'PROCESSED' })).toBe(1);
    },
    20_000,
  );
});

describe('readiness during shutdown', () => {
  test(
    'ready answers 503 while the instance drains',
    async () => {
      queues = await createTestQueues();
      const db = await initTestDatabases();
      const { app } = await appWithLogs(withConfig(consumerConfig(queues, { shutdownGraceMs: 5_000 })));
      try {
        expect((await fetch(`${app.url}/health/ready`)).status).toBe(200);
        const wallet = await createWallet(app.url, '100.00');

        const locked = Promise.withResolvers<void>();
        const holder = db.owner.em.fork().transactional(async (em) => {
          await em.execute('select id from wallets where id = ? for update', [wallet.walletId]);
          locked.resolve();
          await Bun.sleep(1_500);
        });
        await locked.promise;
        await sendWagerMessage(queues, wallet, { amount: '1.00' });
        await waitFor(() => queueDepth(queues as TestQueues), (depth) => depth.inFlight === 1);

        const closing = app.close();
        started.splice(started.indexOf(app), 1);
        const response = await waitFor(
          () => fetch(`${app.url}/health/ready`),
          (candidate) => candidate.status === 503,
          1_000,
        );
        const body = await response.json();
        await holder;
        await closing;

        expect(response.status).toBe(503);
        expect(body).toMatchObject({ status: 'shutting_down', failureCode: 'SERVICE_UNAVAILABLE' });
      } finally {
        await db.close();
      }
    },
    20_000,
  );
});
