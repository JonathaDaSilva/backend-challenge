import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PendingReferenceWorker } from '../../src/modules/wagering/application/pending-reference-worker';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../../src/modules/wallet/application/ports';
import { type CatalogCode, FAILURE_CATALOG } from '../../src/shared/application/failure-catalog';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { createSqsClient } from '../../src/shared/infrastructure/sqs/sqs.client';
import { SQS_CLIENT } from '../../src/shared/infrastructure/tokens';
import { AUTHENTICATOR, type Authenticator } from '../../src/shared/presentation/auth/authenticator';
import { postJson, type StartedApp, startApp, withConfig } from './support/app';
import { initTestDatabases, type TestDatabases } from './support/database';
import { createWallet, submit, type SubmitOptions, type TestWallet } from './support/wagering';

const NOT_REACHABLE_OVER_HTTP: readonly CatalogCode[] = ['PERMANENT_FAILURE'];

let app: StartedApp;
let db: TestDatabases;

beforeAll(async () => {
  db = await initTestDatabases();
  app = await startApp(
    withConfig((config) => ({ ...config, pendingReference: { ...config.pendingReference, workerEnabled: false } })),
  );
});

afterAll(async () => {
  await app.close();
  await db.close();
});

const ext = () => `ext-${Bun.randomUUIDv7()}`;
const reversal = (kind: 'REFUND' | 'ROLLBACK', reference: string, options: SubmitOptions = {}): SubmitOptions => ({
  ...options,
  kind,
  body: { referenceExternalTransactionId: reference, ...options.body },
});

async function withReference(
  referenceKind: string,
  reversalOptions: (reference: string) => SubmitOptions,
  initialBalance = '100.00',
) {
  const wallet = await createWallet(app.url, initialBalance);
  const reference = ext();
  await submit(app.url, wallet, { kind: referenceKind, externalTransactionId: reference, amount: '30.00' });
  return submit(app.url, wallet, reversalOptions(reference));
}

async function withBrokenApp(
  configure: Parameters<typeof startApp>[0],
  call: (broken: StartedApp) => Promise<Response>,
): Promise<Response> {
  const broken = await startApp(configure);
  try {
    return await call(broken);
  } finally {
    await broken.close();
  }
}

async function holdingWalletLock(wallet: TestWallet, call: () => Promise<Response>): Promise<Response> {
  const locked = Promise.withResolvers<void>();
  const holder = db.owner.em.fork().transactional(async (em) => {
    await em.execute('select id from wallets where id = ? for update', [wallet.walletId]);
    locked.resolve();
    await Bun.sleep(3000);
  });
  await locked.promise;
  const response = await call();
  await holder;
  return response;
}

const scenarios: Record<Exclude<CatalogCode, (typeof NOT_REACHABLE_OVER_HTTP)[number]>, () => Promise<Response>> = {
  INVALID_PAYLOAD: () => postJson(`${app.url}/wallets`, {}),
  PAYLOAD_TOO_LARGE: () => postJson(`${app.url}/wallets`, { padding: 'x'.repeat(200_000) }),
  UNSUPPORTED_MEDIA_TYPE: () =>
    fetch(`${app.url}/wallets`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' }),
  NOT_FOUND: () => fetch(`${app.url}/does-not-exist`),
  WALLET_NOT_FOUND: () => fetch(`${app.url}/wallets/${Bun.randomUUIDv7()}`),
  TRANSACTION_NOT_FOUND: () => fetch(`${app.url}/wagering/transactions/${Bun.randomUUIDv7()}`),
  WALLET_ALREADY_EXISTS: async () => {
    const wallet = await createWallet(app.url);
    return postJson(`${app.url}/wallets`, {
      playerId: wallet.playerId,
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
  },
  IDEMPOTENCY_CONFLICT: async () => {
    const wallet = await createWallet(app.url);
    const externalTransactionId = ext();
    await submit(app.url, wallet, { externalTransactionId, amount: '1.00' });
    return submit(app.url, wallet, { externalTransactionId, amount: '2.00' });
  },
  DUPLICATE_EXTERNAL_TRANSACTION: async () => {
    const wallet = await createWallet(app.url);
    const externalTransactionId = ext();
    await submit(app.url, wallet, { externalTransactionId });
    return submit(app.url, wallet, { externalTransactionId, idempotencyKey: `other:${externalTransactionId}` });
  },
  UNSUPPORTED_CURRENCY: () =>
    postJson(`${app.url}/wallets`, {
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: '1.00', currency: 'USD' },
    }),
  UNKNOWN_WALLET: () => submit(app.url, { walletId: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() }),
  WALLET_PLAYER_MISMATCH: async () => {
    const wallet = await createWallet(app.url);
    return submit(app.url, { ...wallet, playerId: Bun.randomUUIDv7() });
  },
  CURRENCY_MISMATCH: async () => submit(app.url, await createWallet(app.url), { currency: 'USD' }),
  INSUFFICIENT_FUNDS: async () => submit(app.url, await createWallet(app.url, '1.00'), { amount: '2.00' }),
  REVERSAL_INSUFFICIENT_FUNDS: async () => {
    const wallet = await createWallet(app.url, '0.00');
    const win = ext();
    await submit(app.url, wallet, { kind: 'WIN', externalTransactionId: win, amount: '30.00' });
    await submit(app.url, wallet, { amount: '25.00' });
    return submit(app.url, wallet, reversal('ROLLBACK', win, { amount: '30.00' }));
  },
  REFERENCE_NOT_FOUND: async () => {
    const wallet = await createWallet(app.url);
    const options = reversal('REFUND', ext(), { amount: '10.00', externalTransactionId: ext() });
    await submit(app.url, wallet, options);
    const worker = app.get<PendingReferenceWorker>(PendingReferenceWorker);
    let now = Date.now();
    for (let attempt = 0; attempt < loadConfig().pendingReference.maxAttempts; attempt++) {
      now += 10 * 60_000;
      await worker.processDue(new Date(now));
    }
    return submit(app.url, wallet, options);
  },
  REFERENCE_MISMATCH: () =>
    withReference('BET', (reference) => reversal('REFUND', reference, { amount: '30.00', body: { roundId: 'round-x' } })),
  REFERENCE_AMOUNT_MISMATCH: () => withReference('BET', (reference) => reversal('REFUND', reference, { amount: '1.00' })),
  INVALID_REFERENCE_KIND: () => withReference('WIN', (reference) => reversal('REFUND', reference, { amount: '30.00' })),
  REFERENCE_NOT_PROCESSED: () =>
    withReference('BET', (reference) => reversal('REFUND', reference, { amount: '30.00' }), '1.00'),
  ALREADY_REVERSED: async () => {
    const wallet = await createWallet(app.url);
    const reference = ext();
    await submit(app.url, wallet, { externalTransactionId: reference, amount: '30.00' });
    await submit(app.url, wallet, reversal('REFUND', reference, { amount: '30.00' }));
    return submit(app.url, wallet, reversal('ROLLBACK', reference, { amount: '30.00' }));
  },
  TRANSIENT_FAILURE: async () => {
    const wallet = await createWallet(app.url);
    return holdingWalletLock(wallet, () => submit(app.url, wallet, { amount: '1.00' }));
  },
  SERVICE_UNAVAILABLE: () =>
    withBrokenApp(
      (builder) =>
        builder
          .overrideProvider(SQS_CLIENT)
          .useValue(createSqsClient({ ...loadConfig().aws, endpoint: 'http://127.0.0.1:1' })),
      (broken) => fetch(`${broken.url}/health/ready`),
    ),
  UNAUTHENTICATED: () =>
    withBrokenApp(
      (builder) =>
        builder.overrideProvider(AUTHENTICATOR).useValue({ authenticate: async () => undefined } satisfies Authenticator),
      (broken) => fetch(`${broken.url}/wallets/${Bun.randomUUIDv7()}`),
    ),
  PROVIDER_MISMATCH: async () => {
    const wallet = await createWallet(app.url);
    return withBrokenApp(
      (builder) =>
        builder
          .overrideProvider(AUTHENTICATOR)
          .useValue({ authenticate: async () => ({ subject: 's', providerId: 'provider-b' }) } satisfies Authenticator),
      (broken) => submit(broken.url, wallet),
    );
  },
  INTERNAL_ERROR: () =>
    withBrokenApp(
      (builder) =>
        builder
          .overrideProvider(LEDGER_REPOSITORY)
          .useValue({ append: () => Promise.reject(new Error('ledger unavailable')) } satisfies LedgerRepository),
      (broken) =>
        postJson(`${broken.url}/wallets`, {
          playerId: Bun.randomUUIDv7(),
          initialBalance: { amount: '1.00', currency: 'BRL' },
        }),
    ),
};

describe('error contract', () => {
  test.each(Object.entries(scenarios) as [CatalogCode, () => Promise<Response>][])(
    '%s',
    async (code, provoke) => {
      const definition = FAILURE_CATALOG[code];
      const response = await provoke();
      const body = (await response.json()) as { failureCode: string; retryable: boolean; message?: string };

      expect({ status: response.status, failureCode: body.failureCode, retryable: body.retryable }).toEqual({
        status: definition.status,
        failureCode: code,
        retryable: definition.retryable,
      });
      expect(response.headers.get('retry-after')).toBe(definition.status === 503 ? '1' : null);
    },
    15_000,
  );

  test('every catalog code reachable over HTTP has a scenario', () => {
    const covered = new Set<string>([...Object.keys(scenarios), ...NOT_REACHABLE_OVER_HTTP]);
    expect(Object.keys(FAILURE_CATALOG).filter((code) => !covered.has(code))).toEqual([]);
  });
});
