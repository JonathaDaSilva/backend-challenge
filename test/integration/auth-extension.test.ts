import { afterEach, describe, expect, test } from 'bun:test';
import { AUTHENTICATOR, type Authenticator, type Principal } from '../../src/shared/presentation/auth/authenticator';
import { type StartedApp, startApp } from './support/app';
import { createWallet, submit } from './support/wagering';

const started: StartedApp[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((app) => app.close()));
});

async function appAuthenticating(authenticate: (headers: Record<string, unknown>) => Principal | undefined) {
  const app = await startApp((builder) =>
    builder
      .overrideProvider(AUTHENTICATOR)
      .useValue({ authenticate: async (headers) => authenticate(headers) } satisfies Authenticator),
  );
  started.push(app);
  return app;
}

describe('authentication extension point', () => {
  test('today every caller is accepted (no-op authenticator)', async () => {
    const app = await startApp();
    started.push(app);
    const wallet = await createWallet(app.url);
    expect((await submit(app.url, wallet)).status).toBe(201);
  });

  test('with a real authenticator, protected routes answer 401 but health and metrics stay open', async () => {
    const app = await appAuthenticating((headers) =>
      headers.authorization === 'Bearer valid' ? { subject: 'provider-a-client', providerId: 'provider-a' } : undefined,
    );

    const denied = await fetch(`${app.url}/wallets/${Bun.randomUUIDv7()}`);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ failureCode: 'UNAUTHENTICATED', retryable: false });

    for (const path of ['/health/live', '/health/ready', '/metrics']) {
      expect((await fetch(`${app.url}${path}`)).status).toBe(200);
    }

    const allowed = await fetch(`${app.url}/wallets/${Bun.randomUUIDv7()}`, { headers: { authorization: 'Bearer valid' } });
    expect(allowed.status).toBe(404);
  });

  test('a provider credential cannot submit transactions for another provider', async () => {
    const app = await appAuthenticating(() => ({ subject: 'client', providerId: 'provider-b' }));
    const wallet = await createWallet(app.url);

    const forOther = await submit(app.url, wallet);
    expect(forOther.status).toBe(403);
    expect(await forOther.json()).toMatchObject({ failureCode: 'PROVIDER_MISMATCH' });

    const forItself = await submit(app.url, wallet, { body: { providerId: 'provider-b' } });
    expect(forItself.status).toBe(201);
  });
});
