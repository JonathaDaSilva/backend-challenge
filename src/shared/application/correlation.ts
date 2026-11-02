export type ContextFields = Readonly<Record<string, string | undefined>>;

export interface CorrelationContext {
  currentCorrelationId(): string | undefined;
  value(key: string): string | undefined;
  // Acrescenta campos ao contexto da execução corrente (vão para os logs e decidem labels de métrica).
  annotate(fields: ContextFields): void;
}

export const CORRELATION_CONTEXT = Symbol('CORRELATION_CONTEXT');
