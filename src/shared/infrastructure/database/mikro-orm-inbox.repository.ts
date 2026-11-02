import type { EntityManager } from '@mikro-orm/postgresql';
import { DuplicateMessageError } from '../../application/errors';
import type { InboxRepository } from '../../application/inbox';
import type { InboxMessage } from '../../domain/inbox-message';
import { isUniqueViolation } from './constraint-violation';
import { InboxMessageRecord } from './inbox.record';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async record(message: InboxMessage): Promise<void> {
    try {
      await this.em.insert(InboxMessageRecord, {
        consumerName: message.consumerName,
        messageId: message.messageId,
        payloadHash: message.payloadHash,
        receivedAt: message.receivedAt,
        processedAt: message.processedAt ?? null,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'inbox_messages_pk')) {
        throw new DuplicateMessageError(`${message.consumerName} already processed ${message.messageId}`);
      }
      throw error;
    }
  }
}
