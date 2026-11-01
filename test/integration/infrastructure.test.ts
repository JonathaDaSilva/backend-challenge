import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { createSqsClient } from '../../src/shared/infrastructure/sqs/sqs.client';
import { initTestOrm } from './support/database';

const config = loadConfig();
let orm: MikroORM;
let sqs: SQSClient;

beforeAll(async () => {
  orm = await initTestOrm();
  sqs = createSqsClient(config.aws);
});

afterAll(async () => {
  sqs.destroy();
  await orm.close(true);
});

describe('PostgreSQL', () => {
  test('accepts connections', async () => {
    const [row] = await orm.em.getConnection().execute<{ ok: number }[]>('select 1 as ok');
    expect(row?.ok).toBe(1);
  });

  test('has no pending migrations after migrating up', async () => {
    expect(await orm.migrator.getPending()).toHaveLength(0);
  });
});

describe('SQS', () => {
  async function attributesOf(queueName: string) {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['All'] }),
    );
    return Attributes ?? {};
  }

  test('wager queue is FIFO and redrives to the DLQ', async () => {
    const main = await attributesOf(config.sqs.wagerQueue);
    const dlq = await attributesOf(config.sqs.wagerDlq);

    expect(main.FifoQueue).toBe('true');
    expect(dlq.FifoQueue).toBe('true');

    const redrive = JSON.parse(main.RedrivePolicy ?? '{}') as { deadLetterTargetArn?: string };
    expect(redrive.deadLetterTargetArn).toBe(dlq.QueueArn);
  });
});
