import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepository } from '../../application/outbox';
import { OutboxMessage } from '../../domain/outbox-message';
import { OutboxMessageRecord } from './outbox.record';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(messages: readonly OutboxMessage[]): Promise<void> {
    await this.em.insertMany(
      OutboxMessageRecord,
      messages.map((message) => ({
        id: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload: { ...message.payload },
        occurredAt: message.occurredAt,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
        publishedAt: null,
      })),
    );
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxMessageRecord,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        orderBy: { nextAttemptAt: 'asc', seq: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        disableIdentityMap: true,
      },
    );
    return records.map((record) =>
      OutboxMessage.rehydrate({
        id: record.id,
        aggregateId: record.aggregateId,
        eventType: record.eventType,
        payload: record.payload,
        occurredAt: record.occurredAt,
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt,
        publishedAt: record.publishedAt ?? undefined,
      }),
    );
  }

  async save(messages: readonly OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      await this.em.nativeUpdate(
        OutboxMessageRecord,
        { id: message.id },
        {
          attempts: message.attempts,
          nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
          publishedAt: message.publishedAt ?? null,
        },
      );
    }
  }

  async nextDueAt(): Promise<Date | undefined> {
    const [row] = await this.em.execute<{ due: Date | string | null }[]>(
      'select min(next_attempt_at) as due from outbox_messages where published_at is null',
    );
    return row?.due ? new Date(row.due) : undefined;
  }
}
