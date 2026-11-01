import { DeadlockException } from '@mikro-orm/core';

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

export function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof DeadlockException) return true;
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return typeof error.code === 'string' && RETRYABLE_SQLSTATES.has(error.code);
}
