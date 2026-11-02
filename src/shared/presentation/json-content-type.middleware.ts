import { type NestMiddleware, UnsupportedMediaTypeException } from '@nestjs/common';

interface IncomingRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

export class JsonContentTypeMiddleware implements NestMiddleware {
  use(request: IncomingRequest, _response: unknown, next: () => void): void {
    const contentType = request.headers['content-type'];
    const value = Array.isArray(contentType) ? contentType[0] : contentType;
    if (METHODS_WITH_BODY.has(request.method) && !value?.toLowerCase().startsWith('application/json')) {
      throw new UnsupportedMediaTypeException('Request body must be application/json');
    }
    next();
  }
}
