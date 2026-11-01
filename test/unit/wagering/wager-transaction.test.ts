import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/shared/domain/money';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../../src/modules/wagering/domain/errors';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/modules/wagering/domain/wager-transaction';
import { LedgerDirection } from '../../../src/modules/wallet/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-01T12:00:00.000Z');

const props = (overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => ({
  id: 'tx-1',
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'provider-a:ext-1',
  payloadHash: 'a'.repeat(64),
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: brl('10.00'),
  referenceExternalTransactionId: undefined,
  at,
  ...overrides,
});

describe('WagerTransaction.create', () => {
  test('starts PENDING', () => {
    const transaction = WagerTransaction.create(props());
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.isTerminal()).toBe(false);
  });

  test.each([
    ['OPENING', { kind: WagerTransactionKind.Opening }, 'OPENING_NOT_ALLOWED'],
    ['REFUND without reference', { kind: WagerTransactionKind.Refund }, 'REFERENCE_REQUIRED'],
    ['ROLLBACK without reference', { kind: WagerTransactionKind.Rollback }, 'REFERENCE_REQUIRED'],
    ['BET with reference', { referenceExternalTransactionId: 'ext-0' }, 'REFERENCE_NOT_ALLOWED'],
    ['WIN with reference', { kind: WagerTransactionKind.Win, referenceExternalTransactionId: 'ext-0' }, 'REFERENCE_NOT_ALLOWED'],
    ['zero BET', { money: brl('0.00') }, 'AMOUNT_MUST_BE_POSITIVE'],
    ['zero WIN', { kind: WagerTransactionKind.Win, money: brl('0.00') }, 'AMOUNT_MUST_BE_POSITIVE'],
    ['negative LOSS', { kind: WagerTransactionKind.Loss, money: brl('-1.00') }, 'NEGATIVE_AMOUNT'],
  ] as const)('rejects %s', (_, overrides, reason) => {
    try {
      WagerTransaction.create(props(overrides));
      throw new Error('expected create to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidWagerTransactionError);
      expect((error as InvalidWagerTransactionError).reason).toBe(reason);
    }
  });

  test('accepts a zero LOSS', () => {
    expect(WagerTransaction.create(props({ kind: WagerTransactionKind.Loss, money: brl('0.00') })).affectsBalance()).toBe(
      false,
    );
  });
});

describe('transitions', () => {
  test('markProcessed records the reference, time and observed balance', () => {
    const transaction = WagerTransaction.create(props());
    transaction.markProcessed(undefined, at, brl('90.00'));
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.processedAt).toEqual(at);
    expect(transaction.resultBalance?.toString()).toBe('90.00');
  });

  test('reject keeps the balance observed at that moment', () => {
    const transaction = WagerTransaction.create(props());
    transaction.reject('INSUFFICIENT_FUNDS', brl('5.00'));
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(transaction.processedAt).toBeUndefined();
  });

  test.each([
    ['PROCESSED', (t: WagerTransaction) => t.markProcessed(undefined, at, brl('1.00'))],
    ['REJECTED', (t: WagerTransaction) => t.reject('X', undefined)],
    ['FAILED', (t: WagerTransaction) => t.fail('X')],
  ])('a %s transaction is terminal', (_, finish) => {
    const transaction = WagerTransaction.create(props());
    finish(transaction);
    expect(transaction.isTerminal()).toBe(true);
    expect(() => transaction.markProcessed(undefined, at, brl('1.00'))).toThrow(InvalidTransactionStateError);
    expect(() => transaction.reject('Y', undefined)).toThrow(InvalidTransactionStateError);
    expect(() => transaction.fail('Y')).toThrow(InvalidTransactionStateError);
  });

  test('only a pending reversal can wait for its reference', () => {
    const refund = WagerTransaction.create(
      props({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }),
    );
    refund.markPendingReference();
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(() => refund.markPendingReference()).toThrow(InvalidTransactionStateError);
    refund.markProcessed('tx-0', at, brl('10.00'));
    expect(refund.referenceTransactionId).toBe('tx-0');

    expect(() => WagerTransaction.create(props()).markPendingReference()).toThrow(InvalidTransactionStateError);
  });
});

describe('domain queries', () => {
  test('ledger direction per kind', () => {
    const of = (kind: WagerTransactionKind, reference?: string) =>
      WagerTransaction.create(props({ kind, referenceExternalTransactionId: reference }));
    const bet = of(WagerTransactionKind.Bet);
    const win = of(WagerTransactionKind.Win);

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(of(WagerTransactionKind.Refund, 'ext-0').ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(of(WagerTransactionKind.Rollback, 'ext-0').ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(of(WagerTransactionKind.Rollback, 'ext-0').ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(() => of(WagerTransactionKind.Rollback, 'ext-0').ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => of(WagerTransactionKind.Loss).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('matchesPayload compares the stored hash', () => {
    const transaction = WagerTransaction.create(props());
    expect(transaction.matchesPayload('a'.repeat(64))).toBe(true);
    expect(transaction.matchesPayload('b'.repeat(64))).toBe(false);
  });
});

describe('checkReversalOf', () => {
  const processed = (overrides: Partial<CreateWagerTransactionProps> = {}) => {
    const transaction = WagerTransaction.create(props({ id: 'ref', externalTransactionId: 'ext-ref', ...overrides }));
    transaction.markProcessed(undefined, at, brl('90.00'));
    return transaction;
  };
  const reversal = (kind: WagerTransactionKind, overrides: Partial<CreateWagerTransactionProps> = {}) =>
    WagerTransaction.create(
      props({ id: 'rev', externalTransactionId: 'ext-rev', kind, referenceExternalTransactionId: 'ext-ref', ...overrides }),
    );

  test('accepts a REFUND of a processed BET in the same scope', () => {
    expect(reversal(WagerTransactionKind.Refund).checkReversalOf(processed())).toBe('OK');
  });

  test('accepts a ROLLBACK of a BET, a WIN or a REFUND', () => {
    expect(reversal(WagerTransactionKind.Rollback).checkReversalOf(processed())).toBe('OK');
    expect(reversal(WagerTransactionKind.Rollback).checkReversalOf(processed({ kind: WagerTransactionKind.Win }))).toBe(
      'OK',
    );
    const refund = WagerTransaction.create(
      props({ id: 'ref', externalTransactionId: 'ext-ref', kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }),
    );
    refund.markProcessed('tx-0', at, brl('100.00'));
    expect(reversal(WagerTransactionKind.Rollback).checkReversalOf(refund)).toBe('OK');
  });

  test('waits while the reference is itself waiting', () => {
    const pendingRefund = WagerTransaction.create(
      props({ id: 'ref', externalTransactionId: 'ext-ref', kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }),
    );
    pendingRefund.markPendingReference();
    expect(reversal(WagerTransactionKind.Rollback).checkReversalOf(pendingRefund)).toBe('WAIT');
  });

  test.each([
    ['another round', { roundId: 'round-2' }, 'REFERENCE_MISMATCH'],
    ['another wallet', { walletId: 'wallet-2' }, 'REFERENCE_MISMATCH'],
    ['another player', { playerId: 'player-2' }, 'REFERENCE_MISMATCH'],
    ['another provider', { providerId: 'provider-b' }, 'REFERENCE_MISMATCH'],
    ['another amount', { money: brl('9.99') }, 'REFERENCE_AMOUNT_MISMATCH'],
  ] as const)('rejects a reference from %s', (_, overrides, expected) => {
    expect(reversal(WagerTransactionKind.Refund).checkReversalOf(processed(overrides))).toBe(expected);
  });

  test('REFUND only reverses a BET; ROLLBACK never reverses a LOSS', () => {
    expect(reversal(WagerTransactionKind.Refund).checkReversalOf(processed({ kind: WagerTransactionKind.Win }))).toBe(
      'INVALID_REFERENCE_KIND',
    );
    expect(reversal(WagerTransactionKind.Rollback).checkReversalOf(processed({ kind: WagerTransactionKind.Loss }))).toBe(
      'INVALID_REFERENCE_KIND',
    );
  });

  test('a rejected reference cannot be reversed', () => {
    const rejected = WagerTransaction.create(props({ id: 'ref', externalTransactionId: 'ext-ref' }));
    rejected.reject('INSUFFICIENT_FUNDS', brl('1.00'));
    expect(reversal(WagerTransactionKind.Refund).checkReversalOf(rejected)).toBe('REFERENCE_NOT_PROCESSED');
  });
});
