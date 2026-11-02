import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/shared/domain/money';
import { InvalidLedgerEntryError } from '../../../src/modules/wallet/domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../../src/modules/wallet/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const valid = {
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('10.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('90.00'),
  walletVersion: 2,
  createdAt: new Date('2026-11-01T12:00:00.000Z'),
};

describe('WalletLedgerEntry.create', () => {
  test('accepts balanced debits and credits', () => {
    expect(WalletLedgerEntry.create(valid).isBalanced()).toBe(true);
    const credit = WalletLedgerEntry.create({
      ...valid,
      direction: LedgerDirection.Credit,
      balanceAfter: brl('110.00'),
    });
    expect(credit.isBalanced()).toBe(true);
  });

  test.each([
    ['an unbalanced debit', { balanceAfter: brl('90.01') }],
    ['a credit recorded as debit', { balanceAfter: brl('110.00') }],
    ['a zero amount', { money: brl('0.00'), balanceAfter: brl('100.00') }],
    ['a negative resulting balance', { balanceBefore: brl('5.00'), balanceAfter: brl('-5.00') }],
    ['version zero', { walletVersion: 0 }],
    ['a fractional version', { walletVersion: 1.5 }],
  ])('rejects %s', (_, overrides) => {
    expect(() => WalletLedgerEntry.create({ ...valid, ...overrides })).toThrow(InvalidLedgerEntryError);
  });

  test('entries are frozen', () => {
    expect(Object.isFrozen(WalletLedgerEntry.create(valid))).toBe(true);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('reconstructs persisted state without validating it', () => {
    const entry = WalletLedgerEntry.rehydrate({ ...valid, balanceAfter: brl('1.00') });
    expect(entry.isBalanced()).toBe(false);
  });
});
