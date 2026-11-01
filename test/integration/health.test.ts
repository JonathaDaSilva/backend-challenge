import { afterEach, describe, expect, test } from 'bun:test';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { createSqsClient } from '../../src/shared/infrastructure/sqs/sqs.client';
import { SQS_CLIENT } from '../../src/shared/infrastructure/tokens';
import { type StartedApp, startApp } from './support/app';

let app: StartedApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('health', () => {
  test('GET /health/live returns 200', async () => {
    app = await startApp();
    const response = await fetch(`${app.url}/health/live`);
    expect(response.status).toBe(200);
  });

  test('GET /health/ready returns 200 when PostgreSQL and SQS are reachable', async () => {
    app = await startApp();
    const response = await fetch(`${app.url}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });

  test('GET /health/ready returns 503 when SQS is unreachable', async () => {
    const unreachable = createSqsClient({ ...loadConfig().aws, endpoint: 'http://127.0.0.1:1' });
    app = await startApp((builder) => builder.overrideProvider(SQS_CLIENT).useValue(unreachable));
    const response = await fetch(`${app.url}/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      failureCode: 'SERVICE_UNAVAILABLE',
      checks: { postgres: 'up', sqs: 'down' },
    });
  });
});
