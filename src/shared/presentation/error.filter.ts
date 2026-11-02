import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
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
import { ConcurrentModificationError, InvalidPayloadError } from '../application/errors';
import { type CatalogCode, failureDefinition } from '../application/failure-catalog';
import { CurrencyMismatchError, InvalidMoneyError } from '../domain/errors';
import { isTransientDatabaseError } from '../infrastructure/database/pg-errors';

interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

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
];

// Erros que nunca deveriam chegar à borda: são capturados antes ou indicam bug. Viram 500 INTERNAL_ERROR.
export const INTERNAL_ERROR_TYPES: readonly ErrorClass[] = [
  DuplicateIdempotencyKeyError,
  InsufficientFundsError,
  InvalidTransactionStateError,
  InvalidMovementError,
  InvalidLedgerEntryError,
  CurrencyMismatchError,
];

const HTTP_EXCEPTION_CODES: Record<number, CatalogCode> = {
  400: 'INVALID_PAYLOAD',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  503: 'SERVICE_UNAVAILABLE',
};

const RETRY_AFTER_SECONDS = '1';

export interface ErrorResponse {
  readonly status: number;
  readonly body: { failureCode: CatalogCode; message: string; retryable: boolean } & Record<string, unknown>;
}

function respond(code: CatalogCode, message: string, extra: Record<string, unknown> = {}, status?: number): ErrorResponse {
  const definition = failureDefinition(code);
  return {
    status: status ?? definition.status,
    body: { failureCode: code, message, retryable: definition.retryable, ...extra },
  };
}

function fromHttpException(error: HttpException): ErrorResponse {
  const status = error.getStatus();
  const payload = error.getResponse();
  const extra = typeof payload === 'object' && payload !== null && !('statusCode' in payload) ? payload : {};
  const code = HTTP_EXCEPTION_CODES[status] ?? (status < 500 ? 'INVALID_PAYLOAD' : 'INTERNAL_ERROR');
  return respond(code, error.message, extra as Record<string, unknown>, status);
}

export function toErrorResponse(error: unknown): ErrorResponse | undefined {
  if (error instanceof Error) {
    const mapping = ERROR_MAPPINGS.find((candidate) => error instanceof candidate.type);
    if (mapping) return respond(mapping.code, error.message, (mapping.extra as (e: Error) => Record<string, unknown>)(error));
  }
  if (error instanceof HttpException) return fromHttpException(error);
  if (isTransientDatabaseError(error)) {
    return respond('TRANSIENT_FAILURE', 'Temporary failure, the request can be retried');
  }
  return undefined;
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const mapped = toErrorResponse(error);
    if (!mapped) this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    else if (mapped.status >= 500) this.logger.warn(error instanceof Error ? error.message : String(error));

    const { status, body } = mapped ?? respond('INTERNAL_ERROR', 'Internal server error');
    if (status === 503) response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    response.status(status).json(body);
  }
}
