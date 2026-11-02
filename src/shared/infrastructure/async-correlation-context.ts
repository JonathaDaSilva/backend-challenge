import { AsyncLocalStorage } from 'node:async_hooks';
import type { CorrelationContext } from '../application/correlation';

const storage = new AsyncLocalStorage<string>();

export function runWithCorrelation<T>(correlationId: string, work: () => T): T {
  return storage.run(correlationId, work);
}

export class AsyncCorrelationContext implements CorrelationContext {
  currentCorrelationId(): string | undefined {
    return storage.getStore();
  }
}
