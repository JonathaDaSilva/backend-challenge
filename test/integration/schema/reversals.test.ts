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

describe('wager_transaction_reversals', () => {
  test('links a REFUND to its BET', async () => {
    const refund = await fx.reversalOf(bet, wallet, 'REFUND');
    await fx.link(refund, bet, 'REFUND');
  });

  test('allows a ROLLBACK of a REFUND', async () => {
    const refund = await fx.reversalOf(bet, wallet, 'REFUND');
    await fx.link(refund, bet, 'REFUND');
    const rollback = await fx.reversalOf(refund, wallet, 'ROLLBACK');
    await fx.link(rollback, refund, 'ROLLBACK');
  });

  test('a reference is reversed at most once, whatever the kind', async () => {
    const first = await fx.reversalOf(bet, wallet, 'REFUND');
    await fx.link(first, bet, 'REFUND');
    const second = await fx.reversalOf(bet, wallet, 'REFUND');
    await expectViolation(fx.link(second, bet, 'REFUND'), '23505', 'wager_tx_reversals_reference_uq');

    const rollback = await fx.reversalOf(bet, wallet, 'ROLLBACK');
    await expectViolation(fx.link(rollback, bet, 'ROLLBACK'), '23505', 'wager_tx_reversals_reference_uq');
  });

  test('a reversal reverses a single transaction', async () => {
    const refund = await fx.reversalOf(bet, wallet, 'REFUND');
    await fx.link(refund, bet, 'REFUND');
    await expectViolation(fx.link(refund, bet, 'REFUND'), '23505');
  });

  test('the link kind must match the reversal kind', async () => {
    const refund = await fx.reversalOf(bet, wallet, 'REFUND');
    await expectViolation(fx.link(refund, bet, 'ROLLBACK'), '23514', 'wager_tx_reversals_kind_match_ck');
  });

  test('REFUND only reverses a BET', async () => {
    const win = await fx.processed(wallet, { kind: 'WIN' });
    const refund = await fx.reversalOf(win, wallet, 'REFUND');
    await expectViolation(fx.link(refund, win, 'REFUND'), '23514', 'wager_tx_reversals_reference_kind_ck');
  });

  test('ROLLBACK cannot reverse a LOSS', async () => {
    const loss = await fx.processed(wallet, { kind: 'LOSS' });
    const rollback = await fx.reversalOf(loss, wallet, 'ROLLBACK');
    await expectViolation(fx.link(rollback, loss, 'ROLLBACK'), '23514', 'wager_tx_reversals_reference_kind_ck');
  });

  test('the reference must be PROCESSED', async () => {
    const pendingBet = await fx.transaction(wallet);
    const refund = await fx.reversalOf(pendingBet, wallet, 'REFUND');
    await expectViolation(fx.link(refund, pendingBet, 'REFUND'), '23514', 'wager_tx_reversals_reference_processed_ck');
  });

  test.each([
    ['round', { round_id: 'round-2' }],
    ['provider', { provider_id: 'provider-b' }],
    ['external reference', { reference_external_transaction_id: 'ext-someone-else' }],
  ])('rejects a reversal from another %s', async (_, overrides) => {
    const refund = await fx.reversalOf(bet, wallet, 'REFUND', overrides);
    await expectViolation(fx.link(refund, bet, 'REFUND'), '23514', 'wager_tx_reversals_same_scope_ck');
  });

  test('rejects a reversal on another wallet of the same player', async () => {
    const usdWallet = await fx.wallet({ player_id: wallet.player_id, currency: 'USD' });
    const refund = await fx.reversalOf(bet, usdWallet, 'REFUND');
    await expectViolation(fx.link(refund, bet, 'REFUND'), '23514', 'wager_tx_reversals_same_scope_ck');
  });

  test('rejects a partial reversal', async () => {
    const refund = await fx.reversalOf(bet, wallet, 'REFUND', { amount: '5.00' });
    await expectViolation(fx.link(refund, bet, 'REFUND'), '23514', 'wager_tx_reversals_amount_ck');
  });

  test('links are immutable', async () => {
    const refund = await fx.reversalOf(bet, wallet, 'REFUND');
    await fx.link(refund, bet, 'REFUND');

    const asOwner = db.owner.em.fork();
    await expectViolation(
      asOwner.execute("update wager_transaction_reversals set kind = 'ROLLBACK' where reversal_transaction_id = ?", [
        refund.id,
      ]),
      '23001',
      'wager_transaction_reversals_append_only',
    );
    await expectViolation(
      asOwner.execute('delete from wager_transaction_reversals where reversal_transaction_id = ?', [refund.id]),
      '23001',
      'wager_transaction_reversals_append_only',
    );
    await expectViolation(
      db.app.em.fork().execute('delete from wager_transaction_reversals where reversal_transaction_id = ?', [refund.id]),
      '42501',
    );
  });
});
