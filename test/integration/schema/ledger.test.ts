import { afterAll, beforeAll, beforeEach, describe, test } from 'bun:test';
import { initTestDatabases, type TestDatabases } from '../support/database';
import { expectViolation, SchemaFixtures, type TransactionRow, type WalletRow } from '../support/schema-fixtures';

let db: TestDatabases;
let fx: SchemaFixtures;
let wallet: WalletRow;
let bet: TransactionRow;

beforeAll(async () => {
  db = await initTestDatabases();
  fx = new SchemaFixtures(db.app.em);
});

beforeEach(async () => {
  wallet = await fx.wallet();
  bet = await fx.processed(wallet);
});

afterAll(() => db.close());

describe('wallet_ledger_entries', () => {
  test('accepts a balanced debit and credit', async () => {
    await fx.ledger(wallet, bet);
    const win = await fx.processed(wallet, { kind: 'WIN' });
    await fx.ledger(wallet, win, {
      direction: 'CREDIT',
      balance_before: '90.00',
      balance_after: '100.00',
      wallet_version: 3,
    });
  });

  test.each([
    ['a debit that does not subtract', { balance_after: '110.00' }],
    ['a credit that does not add', { direction: 'CREDIT', balance_after: '90.00' }],
    ['an off-by-a-cent result', { balance_after: '90.01' }],
  ])('rejects %s', async (_, overrides) => {
    await expectViolation(fx.ledger(wallet, bet, overrides), '23514', 'wallet_ledger_balance_math_ck');
  });

  test.each([
    [{ amount: '0.00', balance_after: '100.00' }, 'wallet_ledger_amount_positive_ck'],
    [{ balance_before: '5.00', balance_after: '-5.00' }, 'wallet_ledger_balance_after_ck'],
    [{ wallet_version: 0 }, 'wallet_ledger_wallet_version_ck'],
  ])('rejects %p', async (overrides, constraint) => {
    await expectViolation(fx.ledger(wallet, bet, overrides), '23514', constraint);
  });

  test('rejects an unknown direction', async () => {
    await expectViolation(fx.ledger(wallet, bet, { direction: 'SIDEWAYS' }), '23514');
  });

  test('at most one entry per transaction and wallet', async () => {
    await fx.ledger(wallet, bet);
    await expectViolation(
      fx.ledger(wallet, bet, { balance_before: '90.00', balance_after: '80.00', wallet_version: 3 }),
      '23505',
      'wallet_ledger_one_per_transaction_uq',
    );
  });

  test('two entries cannot claim the same wallet version', async () => {
    await fx.ledger(wallet, bet);
    const secondBet = await fx.processed(wallet);
    await expectViolation(fx.ledger(wallet, secondBet), '23505', 'wallet_ledger_wallet_version_uq');
  });

  test('the entry currency must match the transaction and the wallet', async () => {
    await expectViolation(fx.ledger(wallet, bet, { currency: 'USD' }), '23503', 'wallet_ledger_transaction_fk');
  });

  test('the entry must belong to the transaction wallet', async () => {
    const other = await fx.wallet();
    await expectViolation(fx.ledger(other, bet), '23503', 'wallet_ledger_transaction_fk');
  });

  describe('immutability', () => {
    test('the owner is stopped by the append-only trigger', async () => {
      const entry = await fx.ledger(wallet, bet);
      const asOwner = db.owner.em.fork();

      await expectViolation(
        asOwner.execute("update wallet_ledger_entries set amount = '1.00' where id = ?", [entry.id]),
        '23001',
        'wallet_ledger_entries_append_only',
      );
      await expectViolation(
        asOwner.execute('delete from wallet_ledger_entries where id = ?', [entry.id]),
        '23001',
        'wallet_ledger_entries_append_only',
      );
      await expectViolation(
        asOwner.execute('truncate wallet_ledger_entries cascade'),
        '23001',
        'wallet_ledger_entries_append_only',
      );
    });

    test('the app role has no privilege to change it at all', async () => {
      const entry = await fx.ledger(wallet, bet);
      const asApp = db.app.em.fork();

      await expectViolation(
        asApp.execute("update wallet_ledger_entries set amount = '1.00' where id = ?", [entry.id]),
        '42501',
      );
      await expectViolation(asApp.execute('delete from wallet_ledger_entries where id = ?', [entry.id]), '42501');
      await expectViolation(asApp.execute('truncate wallet_ledger_entries'), '42501');
    });
  });
});
