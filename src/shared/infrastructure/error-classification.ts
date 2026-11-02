import {
  DuplicateExternalTransactionError,
  DuplicateIdempotencyKeyError,
  IdempotencyConflictError,
  TransactionNotFoundError,
  UnknownWalletError,
  WalletCurrencyMismatchError,
  WalletPlayerMismatchError,
} from '../../modules/wagering/application/errors';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../modules/wagering/domain/errors';
import { UnsupportedCurrencyError, WalletAlreadyExistsError, WalletNotFoundError } from '../../modules/wallet/application/errors';
import { InsufficientFundsError, InvalidLedgerEntryError, InvalidMovementError } from '../../modules/wallet/domain/errors';
import {
  ConcurrentModificationError,
  DuplicateMessageError,
  InvalidPayloadError,
  ProviderMismatchError,
  UnauthenticatedError,
} from '../application/errors';
import { type CatalogCode, type FailureDefinition, failureDefinition } from '../application/failure-catalog';
import { CurrencyMismatchError, InvalidMoneyError } from '../domain/errors';
import { isTransientDatabaseError } from './database/pg-errors';

type ErrorClass = abstract new (...args: never[]) => Error;

interface ErrorMapping {
  readonly type: ErrorClass;
  readonly code: CatalogCode;
  readonly extra: (error: never) => Record<string, unknown>;
}

const map = <E extends Error>(
  type: abstract new (...args: never[]) => E,
  code: CatalogCode,
  extra: (error: E) => Record<string, unknown> = () => ({}),
): ErrorMapping => ({ type, code, extra });

export const ERROR_MAPPINGS: readonly ErrorMapping[] = [
  map(InvalidPayloadError, 'INVALID_PAYLOAD', (e) => ({ issues: e.issues })),
  map(InvalidMoneyError, 'INVALID_PAYLOAD', (e) => ({ reason: e.reason })),
  map(InvalidWagerTransactionError, 'INVALID_PAYLOAD', (e) => ({ reason: e.reason })),
  map(WalletNotFoundError, 'WALLET_NOT_FOUND'),
  map(TransactionNotFoundError, 'TRANSACTION_NOT_FOUND'),
  map(WalletAlreadyExistsError, 'WALLET_ALREADY_EXISTS', (e) => ({ walletId: e.existingWalletId })),
  map(IdempotencyConflictError, 'IDEMPOTENCY_CONFLICT', (e) => ({ transactionId: e.transactionId })),
  map(DuplicateExternalTransactionError, 'DUPLICATE_EXTERNAL_TRANSACTION'),
  map(UnsupportedCurrencyError, 'UNSUPPORTED_CURRENCY', (e) => ({ supportedCurrencies: e.supported })),
  map(UnknownWalletError, 'UNKNOWN_WALLET'),
  map(WalletPlayerMismatchError, 'WALLET_PLAYER_MISMATCH'),
  map(WalletCurrencyMismatchError, 'CURRENCY_MISMATCH'),
  map(ConcurrentModificationError, 'TRANSIENT_FAILURE'),
  map(UnauthenticatedError, 'UNAUTHENTICATED'),
  map(ProviderMismatchError, 'PROVIDER_MISMATCH'),
];

// Erros que nunca deveriam chegar à borda: são capturados antes ou indicam bug. Viram INTERNAL_ERROR.
export const INTERNAL_ERROR_TYPES: readonly ErrorClass[] = [
  DuplicateIdempotencyKeyError,
  DuplicateMessageError,
  InsufficientFundsError,
  InvalidTransactionStateError,
  InvalidMovementError,
  InvalidLedgerEntryError,
  CurrencyMismatchError,
];

export interface ClassifiedError {
  readonly code: CatalogCode;
  readonly definition: FailureDefinition;
  readonly extra: Record<string, unknown>;
  readonly known: boolean;
}

const classified = (code: CatalogCode, extra: Record<string, unknown>, known: boolean): ClassifiedError => ({
  code,
  definition: failureDefinition(code),
  extra,
  known,
});

export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof Error) {
    const mapping = ERROR_MAPPINGS.find((candidate) => error instanceof candidate.type);
    if (mapping) return classified(mapping.code, (mapping.extra as (e: Error) => Record<string, unknown>)(error), true);
  }
  if (isTransientDatabaseError(error)) return classified('TRANSIENT_FAILURE', {}, true);
  return classified('INTERNAL_ERROR', {}, false);
}
