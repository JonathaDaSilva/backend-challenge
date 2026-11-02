import type { OutboxMessage } from '../domain/outbox-message';

export interface OutboxRepository {
  add(messages: readonly OutboxMessage[]): Promise<void>;
  // Precisa rodar dentro de uma transação: as linhas ficam travadas (FOR UPDATE SKIP LOCKED) até o commit.
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(messages: readonly OutboxMessage[]): Promise<void>;
  nextDueAt(): Promise<Date | undefined>;
  stats(now: Date): Promise<OutboxStats>;
}

export interface OutboxStats {
  readonly pending: number;
  readonly oldestPendingAgeSeconds: number;
}

export interface PublishResult {
  readonly failed: ReadonlySet<string>;
}

export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}

export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
