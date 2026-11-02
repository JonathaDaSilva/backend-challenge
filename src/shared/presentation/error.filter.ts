import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { type CatalogCode, failureDefinition } from '../application/failure-catalog';
import { classifyError } from '../infrastructure/error-classification';

interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

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
  if (error instanceof HttpException) return fromHttpException(error);
  const classified = classifyError(error);
  if (!classified.known) return undefined;
  const message =
    classified.code === 'TRANSIENT_FAILURE'
      ? 'Temporary failure, the request can be retried'
      : error instanceof Error
        ? error.message
        : String(error);
  return respond(classified.code, message, classified.extra);
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
