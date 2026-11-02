import { AsyncLocalStorage } from 'node:async_hooks';
import type { ContextFields, CorrelationContext } from '../application/correlation';

interface ExecutionContext {
  readonly fields: Record<string, string>;
}

const storage = new AsyncLocalStorage<ExecutionContext>();

const defined = (fields: ContextFields): Record<string, string> =>
  Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined));

export function runWithContext<T>(fields: ContextFields, work: () => T): T {
  const parent = storage.getStore();
  return storage.run({ fields: { ...parent?.fields, ...defined(fields) } }, work);
}

export function runWithCorrelation<T>(correlationId: string, work: () => T): T {
  return runWithContext({ correlationId }, work);
}

export function annotateContext(fields: ContextFields): void {
  const store = storage.getStore();
  if (store) Object.assign(store.fields, defined(fields));
}

export function currentContext(): Readonly<Record<string, string>> {
  return storage.getStore()?.fields ?? {};
}

export class AsyncCorrelationContext implements CorrelationContext {
  currentCorrelationId(): string | undefined {
    return currentContext().correlationId;
  }

  value(key: string): string | undefined {
    return currentContext()[key];
  }

  annotate(fields: ContextFields): void {
    annotateContext(fields);
  }
}
