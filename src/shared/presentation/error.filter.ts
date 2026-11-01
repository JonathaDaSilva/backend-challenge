import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { UnsupportedCurrencyError, WalletAlreadyExistsError, WalletNotFoundError } from '../../modules/wallet/application/errors';
import { InvalidPayloadError } from '../application/errors';
import { InvalidMoneyError } from '../domain/errors';

interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
}

interface ErrorResponse {
  readonly status: number;
  readonly body: { failureCode: string; message: string } & Record<string, unknown>;
}

function toErrorResponse(error: unknown): ErrorResponse | undefined {
  if (error instanceof InvalidPayloadError) {
    return { status: 400, body: { failureCode: error.code, message: error.message, issues: error.issues } };
  }
  if (error instanceof InvalidMoneyError) {
    return { status: 400, body: { failureCode: 'INVALID_PAYLOAD', message: error.message, reason: error.reason } };
  }
  if (error instanceof UnsupportedCurrencyError) {
    return {
      status: 422,
      body: { failureCode: error.code, message: error.message, supportedCurrencies: error.supported },
    };
  }
  if (error instanceof WalletAlreadyExistsError) {
    return { status: 409, body: { failureCode: error.code, message: error.message, walletId: error.existingWalletId } };
  }
  if (error instanceof WalletNotFoundError) {
    return { status: 404, body: { failureCode: error.code, message: error.message } };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const payload = error.getResponse();
    const custom = typeof payload === 'object' && payload !== null && !('statusCode' in payload) ? payload : {};
    return { status, body: { failureCode: HTTP_FAILURE_CODES[status] ?? 'HTTP_ERROR', message: error.message, ...custom } };
  }
  return undefined;
}

const HTTP_FAILURE_CODES: Record<number, string> = {
  400: 'INVALID_PAYLOAD',
  404: 'NOT_FOUND',
  503: 'SERVICE_UNAVAILABLE',
};

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const mapped = toErrorResponse(error);
    if (mapped) {
      response.status(mapped.status).json(mapped.body);
      return;
    }
    this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    response.status(500).json({ failureCode: 'INTERNAL_ERROR', message: 'Internal server error' });
  }
}
