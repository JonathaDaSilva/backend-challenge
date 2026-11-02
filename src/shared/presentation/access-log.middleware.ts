import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import {
  MetricNames,
  METRICS,
  type Metrics,
  STRUCTURED_LOGGER,
  type StructuredLogger,
} from '../application/observability';
import { currentContext } from '../infrastructure/async-correlation-context';

interface IncomingRequest {
  method: string;
  baseUrl?: string;
  originalUrl?: string;
  route?: { path?: string };
}

interface OutgoingResponse {
  statusCode: number;
  on(event: 'finish', listener: () => void): void;
}

const QUIET_ROUTES = new Set(['/health/live', '/health/ready', '/metrics']);

@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
  constructor(
    @Inject(STRUCTURED_LOGGER) private readonly logger: StructuredLogger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  use(request: IncomingRequest, response: OutgoingResponse, next: () => void): void {
    const started = performance.now();
    const context = currentContext();
    response.on('finish', () => {
      // A rota é o padrão registrado (/wallets/:walletId), nunca a URL com ids: mantém a cardinalidade baixa.
      const route = request.route?.path ? `${request.baseUrl ?? ''}${request.route.path}` : 'unmatched';
      const status = String(response.statusCode);
      const durationMs = performance.now() - started;
      this.metrics.observe(MetricNames.HttpRequestDuration, { method: request.method, route, status }, durationMs / 1000);
      if (QUIET_ROUTES.has(route)) return;
      this.logger.info('http request', {
        ...context,
        method: request.method,
        route,
        status: response.statusCode,
        durationMs: Math.round(durationMs),
      });
    });
    next();
  }
}
