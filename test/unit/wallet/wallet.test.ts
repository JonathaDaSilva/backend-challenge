import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError } from '../../../src/shared/domain/errors';
import { Money } from '../../../src/shared/domain/money';
import { InsufficientFundsError, InvalidMovementError } from '../../../src/modules/wallet/domain/errors';
import { Wallet } from '../../../src/modules/wallet/domain/wallet';
import { LedgerDirection } from '../../../src/modules/wallet/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-01T12:00:00.000Z');
const later = new Date('2026-11-01T12:05:00.000Z');

function open(initialBalance = '100.00') {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initialBalance),
    openingTransactionId: 'opening-tx',
    openingEntryId: 'opening-entry',
    at,
  });
}

const movement = (amount: string, n = 1) => ({
  entryId: `entry-${n}`,
  transactionId: `tx-${n}`,
  money: brl(amount),
  at: later,
});

describe('Wallet.open', () => {
  test('credits the initial balance through an OPENING entry at version 1', () => {
    const { wallet, openingEntry } = open('100.00');

    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry).toMatchObject({
      id: 'opening-entry',
      walletId: 'wallet-1',
      transactionId: 'opening-tx',
      direction: LedgerDirection.Credit,
      walletVersion: 1,
    });
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('100.00');
  });

  test('a zero initial balance creates no entry and still starts at version 1', () => {
    const { wallet, openingEntry } = open('0.00');
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('rejects a negative initial balance', () => {
    expect(() => open('-1.00')).toThrow(InvalidMovementError);
  });
});

describe('credit and debit', () => {
  test('credit adds, bumps the version and returns the matching entry', () => {
    const { wallet } = open('100.00');
    const entry = wallet.credit(movement('25.50'));

    expect(wallet.balance.toString()).toBe('125.50');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(later);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('125.50');
    expect(entry.walletVersion).toBe(2);
  });

  test('debit subtracts and returns the matching entry', () => {
    const { wallet } = open('100.00');
    const entry = wallet.debit(movement('80.00'));

    expect(wallet.balance.toString()).toBe('20.00');
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceAfter.toString()).toBe('20.00');
    expect(entry.walletVersion).toBe(2);
  });

  test('debit can take the balance to exactly zero', () => {
    const { wallet } = open('80.00');
    wallet.debit(movement('80.00'));
    expect(wallet.balance.toString()).toBe('0.00');
  });

  test('an insufficient debit throws and leaves the wallet untouched', () => {
    const { wallet } = open('100.00');
    wallet.debit(movement('80.00', 1));

    expect(() => wallet.debit(movement('80.00', 2))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  test('versions grow by one per movement', () => {
    const { wallet } = open('100.00');
    const versions = [
      wallet.debit(movement('10.00', 1)).walletVersion,
      wallet.credit(movement('5.00', 2)).walletVersion,
      wallet.debit(movement('1.00', 3)).walletVersion,
    ];
    expect(versions).toEqual([2, 3, 4]);
    expect(wallet.version).toBe(4);
  });

  test('rejects another currency', () => {
    const { wallet } = open('100.00');
    const usd = { ...movement('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
  });

  test('rejects zero movements', () => {
    const { wallet } = open('100.00');
    expect(() => wallet.credit(movement('0.00'))).toThrow(InvalidMovementError);
    expect(() => wallet.debit(movement('0.00'))).toThrow(InvalidMovementError);
    expect(wallet.version).toBe(1);
  });
});

describe('rehydrate and toState', () => {
  test('round-trips the persisted state without revalidating', () => {
    const state = {
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: at,
      updatedAt: later,
    };
    const wallet = Wallet.rehydrate(state);
    expect(wallet.toState()).toEqual(state);
  });
});
