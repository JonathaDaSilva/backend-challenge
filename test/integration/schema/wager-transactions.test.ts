import { afterAll, beforeAll, describe, test } from 'bun:test';
import { initTestDatabases, type TestDatabases } from '../support/database';
import { expectViolation, SchemaFixtures, type WalletRow } from '../support/schema-fixtures';

let db: TestDatabases;
let fx: SchemaFixtures;
let wallet: WalletRow;

beforeAll(async () => {
  db = await initTestDatabases();
  fx = new SchemaFixtures(db.app.em);
  wallet = await fx.wallet();
});

afterAll(() => db.close());

describe('wager_transactions', () => {
  test('accepts a pending BET', async () => {
    await fx.transaction(wallet);
  });

  test('accepts an internal OPENING without provider fields', async () => {
    await fx.processed(wallet, {
      kind: 'OPENING',
      provider_id: null,
      external_transaction_id: null,
      idempotency_key: null,
      payload_hash: null,
      round_id: null,
      game_id: null,
    });
  });

  describe('uniqueness', () => {
    test('idempotency key is globally unique', async () => {
      const first = await fx.transaction(wallet);
      await expectViolation(
        fx.transaction(wallet, { provider_id: 'provider-b', idempotency_key: first.idempotency_key }),
        '23505',
        'wager_tx_idempotency_key_uq',
      );
    });

    test('external transaction id is unique per provider', async () => {
      const first = await fx.transaction(wallet);
      await fx.transaction(wallet, { provider_id: 'provider-b', external_transaction_id: first.external_transaction_id });
      await expectViolation(
        fx.transaction(wallet, { external_transaction_id: first.external_transaction_id }),
        '23505',
        'wager_tx_provider_external_uq',
      );
    });
  });

  describe('wallet ownership', () => {
    test('currency must match the wallet', async () => {
      await expectViolation(fx.transaction(wallet, { currency: 'USD' }), '23503', 'wager_tx_wallet_fk');
    });

    test('player must own the wallet', async () => {
      const other = await fx.wallet();
      await expectViolation(fx.transaction(wallet, { player_id: other.player_id }), '23503', 'wager_tx_wallet_fk');
    });
  });

  describe('shape checks', () => {
    test.each([
      [{ kind: 'JACKPOT' }, 'wager_tx_kind_ck'],
      [{ status: 'DONE' }, 'wager_tx_status_ck'],
      [{ amount: '-1.00' }, 'wager_tx_amount_ck'],
      [{ attempts: -1 }, 'wager_tx_attempts_ck'],
      [{ payload_hash: 'Z'.repeat(64) }, 'wager_tx_payload_hash_ck'],
      [{ result_balance_amount: '-1.00' }, 'wager_tx_result_balance_ck'],
    ])('rejects %p', async (overrides, constraint) => {
      await expectViolation(fx.transaction(wallet, overrides), '23514', constraint);
    });

    test('OPENING cannot carry a provider', async () => {
      await expectViolation(fx.processed(wallet, { kind: 'OPENING' }), '23514', 'wager_tx_opening_ck');
    });

    test('provider transactions need every provider field', async () => {
      await expectViolation(fx.transaction(wallet, { provider_id: null }), '23514', 'wager_tx_opening_ck');
      await expectViolation(fx.transaction(wallet, { round_id: null }), '23514', 'wager_tx_provider_fields_ck');
    });

    test('REFUND and ROLLBACK require a reference, other kinds forbid it', async () => {
      await expectViolation(fx.transaction(wallet, { kind: 'REFUND' }), '23514', 'wager_tx_reference_ck');
      await expectViolation(
        fx.transaction(wallet, { kind: 'BET', reference_external_transaction_id: 'ext-x' }),
        '23514',
        'wager_tx_reference_ck',
      );
    });

    test('only reversals can wait for a reference', async () => {
      await expectViolation(
        fx.transaction(wallet, { status: 'PENDING_REFERENCE' }),
        '23514',
        'wager_tx_pending_reference_ck',
      );
      await fx.transaction(wallet, {
        kind: 'ROLLBACK',
        status: 'PENDING_REFERENCE',
        reference_external_transaction_id: 'ext-not-yet-arrived',
      });
    });

    test('PROCESSED requires processed_at and vice versa', async () => {
      await expectViolation(
        fx.transaction(wallet, { status: 'PROCESSED', processed_at: null }),
        '23514',
        'wager_tx_processed_at_ck',
      );
      await expectViolation(fx.transaction(wallet, { processed_at: new Date() }), '23514', 'wager_tx_processed_at_ck');
    });

    test('REJECTED and FAILED require a failure code', async () => {
      await expectViolation(fx.transaction(wallet, { status: 'REJECTED' }), '23514', 'wager_tx_failure_code_ck');
      await expectViolation(fx.transaction(wallet, { status: 'FAILED' }), '23514', 'wager_tx_failure_code_ck');
      await fx.transaction(wallet, { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    });
  });
});

describe('inbox_messages', () => {
  test('deduplicates by consumer and message id', async () => {
    const message = {
      consumer_name: 'wager-consumer',
      message_id: `msg-${Bun.randomUUIDv7()}`,
      payload_hash: 'b'.repeat(64),
      received_at: new Date(),
    };
    await fx.insert('inbox_messages', message);
    await fx.insert('inbox_messages', { ...message, consumer_name: 'other-consumer' });
    await expectViolation(fx.insert('inbox_messages', message), '23505', 'inbox_messages_pk');
  });
});
