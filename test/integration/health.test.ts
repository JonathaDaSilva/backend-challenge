import 'reflect-metadata';
import { afterEach, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { createSqsClient } from '../../src/shared/infrastructure/sqs/sqs.client';
import { SQS_CLIENT } from '../../src/shared/infrastructure/tokens';

let app: INestApplication | undefined;

async function start(overrideSqs?: ReturnType<typeof createSqsClient>): Promise<string> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (overrideSqs) builder = builder.overrideProvider(SQS_CLIENT).useValue(overrideSqs);
  app = (await builder.compile()).createNestApplication({ logger: false });
  await app.listen(0);
  return app.getUrl();
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('health', () => {
  test('GET /health/live returns 200', async () => {
    const url = await start();
    const response = await fetch(`${url}/health/live`);
    expect(response.status).toBe(200);
  });

  test('GET /health/ready returns 200 when PostgreSQL and SQS are reachable', async () => {
    const url = await start();
    const response = await fetch(`${url}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });

  test('GET /health/ready returns 503 when SQS is unreachable', async () => {
    const unreachable = createSqsClient({ ...loadConfig().aws, endpoint: 'http://127.0.0.1:1' });
    const url = await start(unreachable);
    const response = await fetch(`${url}/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ checks: { postgres: 'up', sqs: 'down' } });
  });
});
