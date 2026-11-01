import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import {
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  TransactionNotFoundError,
  UnsupportedKindError,
  WalletCurrencyMismatchError,
  WalletPlayerMismatchError,
} from '../../modules/wagering/application/errors';
import { InvalidWagerTransactionError } from '../../modules/wagering/domain/errors';
import { UnsupportedCurrencyError, WalletAlreadyExistsError, WalletNotFoundError } from '../../modules/wallet/application/errors';
import { InvalidPayloadError } from '../application/errors';
import { InvalidMoneyError } from '../domain/errors';
import { isTransientDatabaseError } from '../infrastructure/database/pg-errors';

interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
}

type ErrorBody = { failureCode: string; message: string } & Record<string, unknown>;

interface ErrorResponse {
  readonly status: number;
  readonly body: ErrorBody;
}

type ErrorClass = abstract new (...args: never[]) => Error;

interface Mapping {
  readonly type: ErrorClass;
  readonly status: number;
  readonly body: (error: never) => ErrorBody;
}

const coded = (error: Error & { code: string }): ErrorBody => ({ failureCode: error.code, message: error.message });
const invalidPayload = (error: Error, extra: Record<string, unknown>): ErrorBody => ({
  failureCode: 'INVALID_PAYLOAD',
  message: error.message,
  ...extra,
});

const map = <E extends Error>(
  type: abstract new (...args: never[]) => E,
  status: number,
  body: (error: E) => ErrorBody,
): Mapping => ({ type, status, body });

const MAPPINGS: readonly Mapping[] = [
  map(InvalidPayloadError, 400, (e) => ({ ...coded(e), issues: e.issues })),
  map(InvalidMoneyError, 400, (e) => invalidPayload(e, { reason: e.reason })),
  map(InvalidWagerTransactionError, 400, (e) => invalidPayload(e, { reason: e.reason })),
  map(WalletNotFoundError, 404, coded),
  map(TransactionNotFoundError, 404, coded),
  map(WalletAlreadyExistsError, 409, (e) => ({ ...coded(e), walletId: e.existingWalletId })),
  map(IdempotencyConflictError, 409, (e) => ({ ...coded(e), transactionId: e.transactionId })),
  map(DuplicateExternalTransactionError, 409, coded),
  map(UnsupportedCurrencyError, 422, (e) => ({ ...coded(e), supportedCurrencies: e.supported })),
  map(UnsupportedKindError, 422, coded),
  map(WalletPlayerMismatchError, 422, coded),
  map(WalletCurrencyMismatchError, 422, coded),
];

const HTTP_FAILURE_CODES: Record<number, string> = {
  400: 'INVALID_PAYLOAD',
  404: 'NOT_FOUND',
  503: 'SERVICE_UNAVAILABLE',
};

function fromHttpException(error: HttpException): ErrorResponse {
  const status = error.getStatus();
  const payload = error.getResponse();
  const custom = typeof payload === 'object' && payload !== null && !('statusCode' in payload) ? payload : {};
  return {
    status,
    body: { failureCode: HTTP_FAILURE_CODES[status] ?? 'HTTP_ERROR', message: error.message, ...custom },
  };
}

function toErrorResponse(error: unknown): ErrorResponse | undefined {
  if (error instanceof Error) {
    const mapping = MAPPINGS.find((candidate) => error instanceof candidate.type);
    if (mapping) return { status: mapping.status, body: (mapping.body as (error: Error) => ErrorBody)(error) };
  }
  if (error instanceof HttpException) return fromHttpException(error);
  if (isTransientDatabaseError(error)) {
    return {
      status: 503,
      body: { failureCode: 'TRANSIENT_FAILURE', message: 'Temporary failure, the request can be retried' },
    };
  }
  return undefined;
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const mapped = toErrorResponse(error);
    if (mapped) {
      if (mapped.status >= 500) this.logger.warn(error instanceof Error ? error.message : String(error));
      response.status(mapped.status).json(mapped.body);
      return;
    }
    this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    response.status(500).json({ failureCode: 'INTERNAL_ERROR', message: 'Internal server error' });
  }
}
