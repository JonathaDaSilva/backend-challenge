// `work` pode ser reexecutado no retry: sem efeitos fora do banco (nunca publicar eventos aqui).
export interface TransactionRunner {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');
