import { describe, expect, test } from 'bun:test';
import { DeadlockException } from '@mikro-orm/core';
import { isRetryableTransactionError } from '../../src/shared/infrastructure/database/pg-errors';

const pgError = (code: string) => Object.assign(new Error(`pg error ${code}`), { code });

describe('isRetryableTransactionError', () => {
  test.each(['40001', '40P01'])('retries SQLSTATE %s', (code) => {
    expect(isRetryableTransactionError(pgError(code))).toBe(true);
  });

  test('retries the MikroORM DeadlockException', () => {
    expect(isRetryableTransactionError(new DeadlockException(pgError('40P01')))).toBe(true);
  });

  test.each(['23505', '23514', '55P03', '57014'])('does not retry SQLSTATE %s', (code) => {
    expect(isRetryableTransactionError(pgError(code))).toBe(false);
  });

  test.each([new Error('boom'), null, undefined, 'string', { code: 40001 }])('does not retry %p', (value) => {
    expect(isRetryableTransactionError(value)).toBe(false);
  });
});
