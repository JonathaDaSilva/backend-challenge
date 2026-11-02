import { OutboxMessage, type SerializableEvent } from '../domain/outbox-message';
import type { Clock } from './clock';
import type { CorrelationContext } from './correlation';
import type { IdGenerator } from './id-generator';
import type { EventContext } from './integration-event';
import type { OutboxRepository } from './outbox';

// Só grava na outbox; quem chama precisa estar dentro do mesmo TransactionRunner.run do efeito.
export class EventRecorder {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly correlation: CorrelationContext,
  ) {}

  context(causationId?: string): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: this.correlation.currentCorrelationId() ?? this.ids.next(),
      ...(causationId !== undefined ? { causationId } : {}),
      occurredAt: this.clock.now(),
    };
  }

  async record(events: readonly SerializableEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.outbox.add(events.map((event) => OutboxMessage.enqueue(event)));
  }
}
