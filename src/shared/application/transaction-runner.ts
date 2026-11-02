export interface RunOptions {
  // Leitura consistente e somente leitura (REPEATABLE READ READ ONLY): várias consultas veem a mesma foto.
  readonly snapshot?: boolean;
}

// `work` pode ser reexecutado no retry: sem efeitos fora do banco (nunca publicar eventos aqui).
export interface TransactionRunner {
  run<T>(work: () => Promise<T>, options?: RunOptions): Promise<T>;
}

export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');
