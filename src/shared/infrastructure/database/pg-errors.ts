import { ConnectionException, DeadlockException } from '@mikro-orm/core';
import { ConcurrentModificationError } from '../../application/errors';

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);
const TRANSIENT_SQLSTATES = new Set(['55P03', '57014', '57P01', '53300']);

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof DeadlockException || error instanceof ConcurrentModificationError) return true;
  const code = sqlState(error);
  return code !== undefined && RETRYABLE_SQLSTATES.has(code);
}

export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof ConnectionException || isRetryableTransactionError(error)) return true;
  const code = sqlState(error);
  return code !== undefined && TRANSIENT_SQLSTATES.has(code);
}
