import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../../../src/modules/wallet/application/ports';
import { type StartedApp, postJson, startApp } from '../support/app';
import { initTestDatabases, type TestDatabases } from '../support/database';

let app: StartedApp;
let db: TestDatabases;

const newPlayer = () => Bun.randomUUIDv7();
const brl = (amount: string) => ({ amount, currency: 'BRL' });
const createWallet = (playerId: string, initialBalance: unknown = brl('1000.00')) =>
  postJson(`${app.url}/wallets`, { playerId, initialBalance });

async function rows<T>(sql: string, params: unknown[]): Promise<T[]> {
  return db.owner.em.fork().execute<T[]>(sql, params);
}

beforeAll(async () => {
  db = await initTestDatabases();
  app = await startApp();
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('POST /wallets', () => {
  test('creates the wallet, the OPENING transaction and its CREDIT entry together', async () => {
    const playerId = newPlayer();
    const response = await createWallet(playerId);
    const body = (await response.json()) as Record<string, unknown> & { id: string };

    expect(response.status).toBe(201);
    expect(body).toEqual({ id: expect.any(String), playerId, balance: brl('1000.00'), version: 1 });

    const [wallet] = await rows<{ balance_amount: string; version: number }>(
      'select balance_amount, version from wallets where id = ?',
      [body.id],
    );
    const transactions = await rows<{ id: string; kind: string; status: string; amount: string }>(
      'select id, kind, status, amount from wager_transactions where wallet_id = ?',
      [body.id],
    );
    const entries = await rows<Record<string, unknown>>(
      'select transaction_id, direction, amount, balance_before, balance_after, wallet_version from wallet_ledger_entries where wallet_id = ?',
      [body.id],
    );

    expect(wallet).toEqual({ balance_amount: '1000.00', version: 1 });
    expect(transactions).toEqual([{ id: expect.any(String), kind: 'OPENING', status: 'PROCESSED', amount: '1000.00' }]);
    expect(entries).toEqual([
      {
        transaction_id: transactions[0]?.id,
        direction: 'CREDIT',
        amount: '1000.00',
        balance_before: '0.00',
        balance_after: '1000.00',
        wallet_version: 1,
      },
    ]);
  });

  test('a zero initial balance creates no OPENING and no ledger entry', async () => {
    const response = await createWallet(newPlayer(), brl('0.00'));
    const body = (await response.json()) as { id: string; version: number };

    expect(response.status).toBe(201);
    expect(body.version).toBe(1);
    expect(await rows('select 1 from wager_transactions where wallet_id = ?', [body.id])).toHaveLength(0);
    expect(await rows('select 1 from wallet_ledger_entries where wallet_id = ?', [body.id])).toHaveLength(0);
  });

  test('a duplicate player and currency is a conflict that points to the existing wallet', async () => {
    const playerId = newPlayer();
    const first = (await (await createWallet(playerId)).json()) as { id: string };
    const second = await createWallet(playerId, brl('5.00'));

    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ failureCode: 'WALLET_ALREADY_EXISTS', walletId: first.id });
  });

  test('concurrent creations for the same player produce exactly one wallet', async () => {
    const playerId = newPlayer();
    const responses = await Promise.all(Array.from({ length: 8 }, () => createWallet(playerId)));
    const statuses = responses.map((response) => response.status).sort();
    const bodies = (await Promise.all(responses.map((response) => response.json()))) as {
      id?: string;
      walletId?: string;
    }[];

    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    const createdId = bodies.find((body) => body.id)?.id;
    expect(bodies.filter((body) => body.walletId).every((body) => body.walletId === createdId)).toBe(true);
    expect(await rows('select 1 from wallets where player_id = ?', [playerId])).toHaveLength(1);
    expect(await rows('select 1 from wallet_ledger_entries where wallet_id = ?', [createdId])).toHaveLength(1);
  });

  test('rejects currencies outside SUPPORTED_CURRENCIES', async () => {
    const response = await createWallet(newPlayer(), { amount: '10.00', currency: 'USD' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ failureCode: 'UNSUPPORTED_CURRENCY', supportedCurrencies: ['BRL'] });
  });

  test.each([
    ['a missing playerId', { playerId: undefined, initialBalance: brl('1.00') }, undefined],
    ['a non-uuid playerId', { playerId: 'player-1', initialBalance: brl('1.00') }, undefined],
    ['a numeric amount', { initialBalance: { amount: 10, currency: 'BRL' } }, 'NOT_A_STRING'],
    ['an amount without scale', { initialBalance: brl('10') }, 'INVALID_FORMAT'],
    ['a negative amount', { initialBalance: brl('-1.00') }, 'NEGATIVE_NOT_ALLOWED'],
    ['a lowercase currency', { initialBalance: { amount: '1.00', currency: 'brl' } }, 'INVALID_CURRENCY'],
  ])('rejects %s with 400', async (_, payload, reason) => {
    const response = await postJson(`${app.url}/wallets`, { playerId: newPlayer(), ...payload });
    const body = (await response.json()) as { failureCode: string; reason?: string };

    expect(response.status).toBe(400);
    expect(body.failureCode).toBe('INVALID_PAYLOAD');
    if (reason) expect(body.reason).toBe(reason);
  });

  test('rejects malformed JSON with 400', async () => {
    const response = await fetch(`${app.url}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"playerId":',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ failureCode: 'INVALID_PAYLOAD' });
  });
});

describe('GET /wallets/:walletId', () => {
  test('returns the wallet', async () => {
    const created = (await (await createWallet(newPlayer(), brl('42.00'))).json()) as Record<string, unknown>;
    const response = await fetch(`${app.url}/wallets/${String(created.id)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(created);
  });

  test('returns 404 for an unknown wallet', async () => {
    const response = await fetch(`${app.url}/wallets/${Bun.randomUUIDv7()}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ failureCode: 'WALLET_NOT_FOUND' });
  });

  test('returns 400 for an id that is not a uuid', async () => {
    const response = await fetch(`${app.url}/wallets/not-a-uuid`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ failureCode: 'INVALID_PAYLOAD', issues: [{ path: 'walletId' }] });
  });
});

describe('atomicity', () => {
  test('a failure while writing the ledger leaves no wallet and no OPENING behind', async () => {
    const failingLedger: LedgerRepository = {
      append: () => Promise.reject(new Error('ledger unavailable')),
    };
    const broken = await startApp((builder) => builder.overrideProvider(LEDGER_REPOSITORY).useValue(failingLedger));
    const playerId = newPlayer();

    try {
      const response = await postJson(`${broken.url}/wallets`, { playerId, initialBalance: brl('100.00') });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ failureCode: 'INTERNAL_ERROR', message: 'Internal server error' });
    } finally {
      await broken.close();
    }

    expect(await rows('select 1 from wallets where player_id = ?', [playerId])).toHaveLength(0);
    expect(await rows('select 1 from wager_transactions where player_id = ?', [playerId])).toHaveLength(0);
  });
});
