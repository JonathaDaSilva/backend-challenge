export interface CorrelationContext {
  currentCorrelationId(): string | undefined;
}

export const CORRELATION_CONTEXT = Symbol('CORRELATION_CONTEXT');
