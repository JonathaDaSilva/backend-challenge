import { afterEach, describe, expect, test } from 'bun:test';
import { PendingReferenceWorker } from '../../../src/modules/wagering/application/pending-reference-worker';
import type { AppConfig } from '../../../src/shared/infrastructure/config';
import { type StartedApp, startApp, withConfig } from '../support/app';
import { createWallet, submitJson } from '../support/wagering';

const started: StartedApp[] = [];

async function instance(pendingReference: Partial<AppConfig['pendingReference']>): Promise<StartedApp> {
  const app = await startApp(
    withConfig((config) => ({ ...config, pendingReference: { ...config.pendingReference, ...pendingReference } })),
  );
  started.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((app) => app.close()));
});

async function waitForStatus(app: StartedApp, transactionId: string, status: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await (await fetch(`${app.url}/wagering/transactions/${transactionId}`)).json()) as {
      status: string;
      failureCode?: string;
    };
    if (body.status === status || Date.now() > deadline) return body;
    await Bun.sleep(50);
  }
}

const fastExpiry = { workerEnabled: true, maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 200 };

describe('PendingReferenceScheduler', () => {
  test(
    'an instance is woken by NOTIFY for a pending reversal created by another instance',
    async () => {
      const listener = await instance(fastExpiry);
      const writer = await instance({ workerEnabled: false, baseDelayMs: 100 });
      const wallet = await createWallet(writer.url, '100.00');

      const worker = listener.get<PendingReferenceWorker>(PendingReferenceWorker);
      const drainDeadline = Date.now() + 10_000;
      while ((await worker.nextDueAt()) !== undefined && Date.now() < drainDeadline) await Bun.sleep(100);
      expect(await worker.nextDueAt()).toBeUndefined();

      const refund = await submitJson(writer.url, wallet, {
        kind: 'REFUND',
        amount: '10.00',
        body: { referenceExternalTransactionId: `ext-${Bun.randomUUIDv7()}` },
      });
      expect(refund.status).toBe(202);

      expect(await waitForStatus(listener, refund.body.transactionId, 'REJECTED', 5_000)).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_FOUND',
      });
    },
    { timeout: 25_000 },
  );

  test(
    'an instance that starts later picks up reversals that were already waiting',
    async () => {
      const writer = await instance({ workerEnabled: false, baseDelayMs: 100 });
      const wallet = await createWallet(writer.url, '100.00');
      const refund = await submitJson(writer.url, wallet, {
        kind: 'REFUND',
        amount: '10.00',
        body: { referenceExternalTransactionId: `ext-${Bun.randomUUIDv7()}` },
      });

      const late = await instance(fastExpiry);

      expect(await waitForStatus(late, refund.body.transactionId, 'REJECTED', 5_000)).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_FOUND',
      });
    },
    { timeout: 25_000 },
  );
});
