import type { InboxMessage } from '../domain/inbox-message';

export interface InboxRepository {
  // Lança DuplicateMessageError se (consumerName, messageId) já foi registrado.
  record(message: InboxMessage): Promise<void>;
}

export const INBOX_REPOSITORY = Symbol('INBOX_REPOSITORY');
