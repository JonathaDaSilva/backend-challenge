import { describe, expect, test } from 'bun:test';
import Big from 'big.js';
import { CurrencyMismatchError, InvalidMoneyError, type InvalidMoneyReason } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

function reasonOf(fn: () => unknown): InvalidMoneyReason | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof InvalidMoneyError) return error.reason;
    throw error;
  }
  return undefined;
}

describe('Money.from', () => {
  test.each(['0.00', '25.00', '0.01', '-5.00', '999999999999999999.99'])('accepts %p', (amount) => {
    expect(brl(amount).toString()).toBe(amount);
  });

  test.each<[unknown, InvalidMoneyReason]>([
    [25, 'NOT_A_STRING'],
    [25.5, 'NOT_A_STRING'],
    [null, 'NOT_A_STRING'],
    [undefined, 'NOT_A_STRING'],
    ['', 'INVALID_FORMAT'],
    ['   ', 'INVALID_FORMAT'],
    [' 25.00', 'INVALID_FORMAT'],
    ['25.00 ', 'INVALID_FORMAT'],
    ['NaN', 'INVALID_FORMAT'],
    ['Infinity', 'INVALID_FORMAT'],
    ['-Infinity', 'INVALID_FORMAT'],
    ['1e3', 'INVALID_FORMAT'],
    ['1.00e2', 'INVALID_FORMAT'],
    ['25', 'INVALID_FORMAT'],
    ['25.', 'INVALID_FORMAT'],
    ['25.5', 'INVALID_FORMAT'],
    ['.50', 'INVALID_FORMAT'],
    ['+25.00', 'INVALID_FORMAT'],
    ['025.00', 'INVALID_FORMAT'],
    ['-0.00', 'INVALID_FORMAT'],
    ['25,00', 'INVALID_FORMAT'],
    ['0x10.00', 'INVALID_FORMAT'],
    ['25.001', 'TOO_MANY_DECIMALS'],
    ['0.000', 'TOO_MANY_DECIMALS'],
    ['1000000000000000000.00', 'OUT_OF_RANGE'],
    ['-1000000000000000000.00', 'OUT_OF_RANGE'],
  ])('rejects amount %p with %s', (amount, reason) => {
    expect(reasonOf(() => Money.from({ amount: amount as string, currency: 'BRL' }))).toBe(reason);
  });

  test.each([['brl'], ['BR'], ['BRLL'], [''], ['R$']])('rejects currency %p', (currency) => {
    expect(reasonOf(() => Money.from({ amount: '1.00', currency }))).toBe('INVALID_CURRENCY');
  });
});

describe('Money.fromInput', () => {
  test('rejects negative amounts', () => {
    expect(reasonOf(() => Money.fromInput({ amount: '-1.00', currency: 'BRL' }))).toBe('NEGATIVE_NOT_ALLOWED');
  });

  test('accepts zero and positive amounts', () => {
    expect(Money.fromInput({ amount: '0.00', currency: 'BRL' }).isZero()).toBe(true);
    expect(Money.fromInput({ amount: '10.00', currency: 'BRL' }).toString()).toBe('10.00');
  });

  test('applies the same format rules', () => {
    expect(reasonOf(() => Money.fromInput({ amount: 10, currency: 'BRL' }))).toBe('NOT_A_STRING');
    expect(reasonOf(() => Money.fromInput({ amount: '10.00', currency: 42 }))).toBe('INVALID_CURRENCY');
  });
});

describe('arithmetic', () => {
  test('is exact where floating point is not', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  test('stays exact beyond Number.MAX_SAFE_INTEGER', () => {
    expect(brl('90071992547409.93').add(brl('0.01')).toString()).toBe('90071992547409.94');
    expect(brl('999999999999999999.98').add(brl('0.01')).toString()).toBe('999999999999999999.99');
  });

  test('subtract undoes add', () => {
    const a = brl('1234.56');
    const b = brl('0.07');
    expect(a.add(b).subtract(b).equals(a)).toBe(true);
  });

  test('can go negative internally', () => {
    expect(brl('20.00').subtract(brl('80.00')).toString()).toBe('-60.00');
  });

  test('rejects results beyond the persisted range', () => {
    expect(reasonOf(() => brl('999999999999999999.99').add(brl('0.01')))).toBe('OUT_OF_RANGE');
  });

  test('negate', () => {
    expect(brl('5.00').negate().toString()).toBe('-5.00');
    expect(brl('-5.00').negate().toString()).toBe('5.00');
    expect(brl('0.00').negate().toString()).toBe('0.00');
  });

  test('zero', () => {
    const zero = Money.zero('BRL');
    expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(reasonOf(() => Money.zero('brl'))).toBe('INVALID_CURRENCY');
  });
});

describe('comparisons', () => {
  test('sign checks', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('-0.01').isNegative()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isNegative()).toBe(false);
  });

  test('ordering', () => {
    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('80.00').isGreaterThanOrEqual(brl('80.00'))).toBe(true);
    expect(brl('79.99').isGreaterThanOrEqual(brl('80.00'))).toBe(false);
  });

  test('equals compares value and currency', () => {
    expect(brl('10.00').equals(brl('10.00'))).toBe(true);
    expect(brl('10.00').equals(brl('10.01'))).toBe(false);
    expect(brl('10.00').equals(usd('10.00'))).toBe(false);
  });
});

describe('currency mismatch', () => {
  test.each([
    ['add', () => brl('1.00').add(usd('1.00'))],
    ['subtract', () => brl('1.00').subtract(usd('1.00'))],
    ['isLessThan', () => brl('1.00').isLessThan(usd('1.00'))],
    ['isGreaterThanOrEqual', () => brl('1.00').isGreaterThanOrEqual(usd('1.00'))],
  ])('%s throws CurrencyMismatchError', (_, operation) => {
    expect(operation).toThrow(CurrencyMismatchError);
  });
});

describe('immutability and serialization', () => {
  test('operations return new instances and never mutate', () => {
    const original = brl('10.00');
    const sum = original.add(brl('5.00'));
    expect(sum).not.toBe(original);
    expect(original.toString()).toBe('10.00');
  });

  test('instances are frozen', () => {
    const money = brl('10.00');
    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as unknown as { currency: string }).currency = 'USD';
    }).toThrow();
  });

  test('toJSON keeps the contract format', () => {
    expect(JSON.stringify({ money: brl('25.00') })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
  });

  test('round-trips through toJSON', () => {
    const money = brl('-12.34');
    expect(Money.from(money.toJSON()).equals(money)).toBe(true);
  });

  test('does not change the global big.js configuration', () => {
    expect(Big.strict).toBe(false);
  });
});
