import { type NestMiddleware, UnsupportedMediaTypeException } from '@nestjs/common';

interface IncomingRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

function hasBody(request: IncomingRequest): boolean {
  const length = first(request.headers['content-length']);
  return first(request.headers['transfer-encoding']) !== undefined || (length !== undefined && length !== '0');
}

export class JsonContentTypeMiddleware implements NestMiddleware {
  use(request: IncomingRequest, _response: unknown, next: () => void): void {
    const contentType = first(request.headers['content-type']);
    if (
      METHODS_WITH_BODY.has(request.method) &&
      hasBody(request) &&
      !contentType?.toLowerCase().startsWith('application/json')
    ) {
      throw new UnsupportedMediaTypeException('Request body must be application/json');
    }
    next();
  }
}
