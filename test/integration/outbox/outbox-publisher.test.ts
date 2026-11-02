import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { EVENT_PUBLISHER, type EventPublisher } from '../../../src/shared/application/outbox';
import { OutboxPublisher } from '../../../src/shared/application/outbox-publisher';
import type { AppConfig } from '../../../src/shared/infrastructure/config';
import { SqsEventPublisher } from '../../../src/shared/infrastructure/sqs/sqs-event-publisher';
import { SQS_CLIENT } from '../../../src/shared/infrastructure/tokens';
import { type StartedApp, startApp, withConfig } from '../support/app';
import { initTestDatabases, type TestDatabases } from '../support/database';
import { type Instance, startInstances, stopInstances } from '../support/instances';
import { createEventsQueue, type EventsQueue, receiveEvents } from '../support/queues';
import { createWallet, submitJson } from '../support/wagering';

let db: TestDatabases;
let queue: EventsQueue;
const started: StartedApp[] = [];

beforeAll(async () => {
  db = await initTestDatabases();
});

afterAll(() => db.close());

afterEach(async () => {
  await Promise.all(started.splice(0).map((app) => app.close()));
  await queue?.dispose();
});

function publisherConfig(enabled: boolean) {
  return (config: AppConfig): AppConfig => ({
    ...config,
    events: { ...config.events, queueName: queue.queueName, publisherEnabled: enabled },
    sqs: { ...config.sqs, consumerEnabled: false },
    pendingReference: { ...config.pendingReference, workerEnabled: false },
  });
}

async function publisherApp(enabled: boolean, publisher?: (real: EventPublisher) => EventPublisher): Promise<StartedApp> {
  const app = await startApp((builder) => {
    const configured = withConfig(publisherConfig(enabled))(builder);
    if (!publisher) return configured;
    return configured.overrideProvider(EVENT_PUBLISHER).useFactory({
      inject: [SQS_CLIENT],
      factory: (sqs: SQSClient) => publisher(new SqsEventPublisher(sqs, queue.queueName)),
    });
  });
  started.push(app);
  return app;
}

async function insertOutboxRows(count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => Bun.randomUUIDv7());
  const now = new Date();
  for (const id of ids) {
    await db.app.em.fork().execute(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       values (?, ?, 'TestEvent', ?::jsonb, ?, 0, ?)`,
      [id, Bun.randomUUIDv7(), JSON.stringify({ eventId: id, eventType: 'TestEvent', data: {} }), now, now],
    );
  }
  return ids;
}

async function outboxState(id: string) {
  const [row] = await db.owner.em
    .fork()
    .execute<{ published: boolean; attempts: number; next_attempt_at: Date | string }[]>(
      'select published_at is not null as published, attempts, next_attempt_at from outbox_messages where id = ?',
      [id],
    );
  return row;
}

const withIds = <T extends { eventId: string }>(events: T[], ids: readonly string[]): T[] =>
  events.filter((event) => ids.includes(event.eventId));

describe('outbox publisher', () => {
  test(
    'an event is never published before its transaction commits',
    async () => {
      queue = await createEventsQueue();
      await publisherApp(true);
      const id = Bun.randomUUIDv7();
      const committed = Promise.withResolvers<void>();

      const writer = db.app.em.fork().transactional(async (em) => {
        const now = new Date();
        await em.execute(
          `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
           values (?, ?, 'TestEvent', ?::jsonb, ?, 0, ?)`,
          [id, Bun.randomUUIDv7(), JSON.stringify({ eventId: id, eventType: 'TestEvent', data: {} }), now, now],
        );
        await Bun.sleep(2_000);
        committed.resolve();
      });

      expect(withIds(await receiveEvents(queue, 1, 1_500), [id])).toEqual([]);
      await writer;
      await committed.promise;
      expect(withIds(await receiveEvents(queue, 50, 5_000), [id])).toHaveLength(1);
    },
    20_000,
  );

  test(
    'committed, the process dies before publishing, and another instance publishes',
    async () => {
      queue = await createEventsQueue();
      const writers: Instance[] = await startInstances(1, {
        EVENTS_PUBLISHER_ENABLED: 'false',
        SQS_CONSUMER_ENABLED: 'false',
        PENDING_REFERENCE_WORKER_ENABLED: 'false',
      });
      const writer = writers[0];
      if (!writer) throw new Error('writer did not start');
      const headers = { 'x-correlation-id': `corr-${Bun.randomUUIDv7()}` };
      const wallet = await createWallet(writer.url, '100.00');
      await submitJson(writer.url, wallet, { amount: '10.00', headers });
      writer.process.kill(9);
      await stopInstances(writers);

      const pending = await db.owner.em
        .fork()
        .execute<{ id: string; published: boolean }[]>(
          "select id, published_at is not null as published from outbox_messages where payload->>'correlationId' = ?",
          [headers['x-correlation-id']],
        );
      expect(pending.map((row) => row.published)).toEqual([false, false]);

      await publisherApp(true);
      const ids = pending.map((row) => row.id);
      const events = withIds(await receiveEvents(queue, 500, 10_000), ids);
      expect(events.map((event) => event.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
      for (const id of ids) expect((await outboxState(id))?.published).toBe(true);
    },
    40_000,
  );

  test(
    'two publishers over the same outbox never send the same row',
    async () => {
      queue = await createEventsQueue();
      const sent: string[] = [];
      const counting = (real: EventPublisher): EventPublisher => ({
        publish: async (messages) => {
          sent.push(...messages.map((message) => message.id));
          return real.publish(messages);
        },
      });
      const first = await publisherApp(false, counting);
      const second = await publisherApp(false, counting);
      const ids = await insertOutboxRows(200);

      const now = new Date(Date.now() + 1_000);
      await Promise.all([
        first.get<OutboxPublisher>(OutboxPublisher).processDue(now),
        second.get<OutboxPublisher>(OutboxPublisher).processDue(now),
      ]);

      const ours = sent.filter((id) => ids.includes(id));
      expect(ours).toHaveLength(200);
      expect(new Set(ours).size).toBe(200);
      expect(new Set(sent).size).toBe(sent.length);
      for (const id of ids.slice(0, 20)) expect((await outboxState(id))?.published).toBe(true);
    },
    60_000,
  );

  test(
    'a failing destination reschedules with backoff and the event goes out later',
    async () => {
      queue = await createEventsQueue();
      const [id] = await insertOutboxRows(1);
      if (!id) throw new Error('no outbox row');
      let failedOnce = false;
      const flaky = (real: EventPublisher): EventPublisher => ({
        publish: (messages) => {
          if (!failedOnce && messages.some((message) => message.id === id)) {
            failedOnce = true;
            return Promise.reject(new Error('destination unavailable'));
          }
          return real.publish(messages);
        },
      });
      const app = await publisherApp(false, flaky);
      const publisher = app.get<OutboxPublisher>(OutboxPublisher);

      const now = new Date(Date.now() + 1_000);
      await publisher.processDue(now);
      const afterFailure = await outboxState(id);
      expect(afterFailure).toMatchObject({ published: false, attempts: 1 });
      expect(new Date(afterFailure?.next_attempt_at ?? 0).getTime()).toBeGreaterThan(now.getTime());

      await publisher.processDue(new Date(now.getTime() + 10_000));
      expect(await outboxState(id)).toMatchObject({ published: true, attempts: 1 });
      expect(withIds(await receiveEvents(queue, 500, 5_000), [id])).toHaveLength(1);
    },
    40_000,
  );

  test(
    'republishing the same event is collapsed by its eventId',
    async () => {
      queue = await createEventsQueue();
      const [id] = await insertOutboxRows(1);
      if (!id) throw new Error('no outbox row');
      const app = await publisherApp(false);
      const publisher = app.get<OutboxPublisher>(OutboxPublisher);
      const now = new Date(Date.now() + 1_000);

      await publisher.processDue(now);
      await db.app.em
        .fork()
        .execute('update outbox_messages set published_at = null, next_attempt_at = now() where id = ?', [id]);
      await publisher.processDue(new Date(now.getTime() + 1_000));

      expect(withIds(await receiveEvents(queue, 500, 5_000), [id])).toHaveLength(1);
    },
    40_000,
  );
});
