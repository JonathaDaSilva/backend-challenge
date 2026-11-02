import type { NestMiddleware } from '@nestjs/common';
import { runWithContext } from '../infrastructure/async-correlation-context';

export const CORRELATION_HEADER = 'x-correlation-id';

interface IncomingRequest {
  headers: Record<string, string | string[] | undefined>;
}

interface OutgoingResponse {
  setHeader(name: string, value: string): void;
}

const VALID_ID = /^[\w.:-]{1,128}$/;

export class CorrelationMiddleware implements NestMiddleware {
  use(request: IncomingRequest, response: OutgoingResponse, next: () => void): void {
    const header = request.headers[CORRELATION_HEADER];
    const received = Array.isArray(header) ? header[0] : header;
    const correlationId = received && VALID_ID.test(received) ? received : Bun.randomUUIDv7();
    response.setHeader(CORRELATION_HEADER, correlationId);
    runWithContext({ correlationId, source: 'http' }, next);
  }
}
