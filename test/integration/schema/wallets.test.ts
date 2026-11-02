import { afterAll, beforeAll, describe, test } from 'bun:test';
import { initTestDatabases, type TestDatabases } from '../support/database';
import { expectViolation, SchemaFixtures } from '../support/schema-fixtures';

let db: TestDatabases;
let fx: SchemaFixtures;

beforeAll(async () => {
  db = await initTestDatabases();
  fx = new SchemaFixtures(db.app.em);
});

afterAll(() => db.close());

describe('wallets', () => {
  test('accepts a valid wallet', async () => {
    await fx.wallet();
  });

  test('allows one wallet per player and currency', async () => {
    const wallet = await fx.wallet();
    await fx.wallet({ player_id: wallet.player_id, currency: 'USD' });
    await expectViolation(fx.wallet({ player_id: wallet.player_id }), '23505', 'wallets_player_currency_uq');
  });

  test('rejects a negative balance', async () => {
    await expectViolation(fx.wallet({ balance_amount: '-0.01' }), '23514', 'wallets_balance_non_negative_ck');
  });

  test('rejects an UPDATE that would make the balance negative', async () => {
    const wallet = await fx.wallet({ balance_amount: '10.00' });
    await expectViolation(
      db.app.em.fork().execute('update wallets set balance_amount = balance_amount - 10.01 where id = ?', [wallet.id]),
      '23514',
      'wallets_balance_non_negative_ck',
    );
  });

  test('rejects an invalid currency code', async () => {
    await expectViolation(fx.wallet({ currency: 'brl' }), '23514', 'wallets_currency_ck');
  });

  test('rejects version below 1', async () => {
    await expectViolation(fx.wallet({ version: 0 }), '23514', 'wallets_version_ck');
  });

  test('app role cannot delete wallets', async () => {
    const wallet = await fx.wallet();
    await expectViolation(db.app.em.fork().execute('delete from wallets where id = ?', [wallet.id]), '42501');
  });
});
