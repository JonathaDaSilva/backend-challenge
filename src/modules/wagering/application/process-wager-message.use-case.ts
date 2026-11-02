import type { Clock } from '../../../shared/application/clock';
import type { InboxRepository } from '../../../shared/application/inbox';
import type { TransactionRunner } from '../../../shared/application/transaction-runner';
import { InboxMessage } from '../../../shared/domain/inbox-message';
import type {
  SubmitWagerTransactionCommand,
  SubmitWagerTransactionResult,
  SubmitWagerTransactionUseCase,
} from './submit-wager-transaction.use-case';

export interface WagerMessage {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly command: SubmitWagerTransactionCommand;
}

export interface ProcessWagerMessageDependencies {
  readonly inbox: InboxRepository;
  readonly submit: SubmitWagerTransactionUseCase;
  readonly runner: TransactionRunner;
  readonly clock: Clock;
}

export class ProcessWagerMessageUseCase {
  constructor(private readonly deps: ProcessWagerMessageDependencies) {}

  // Inbox e efeito financeiro no mesmo commit: o run interno do submit junta nesta transação.
  execute(message: WagerMessage): Promise<SubmitWagerTransactionResult> {
    return this.deps.runner.run(async () => {
      const at = this.deps.clock.now();
      const inbox = InboxMessage.receive({ ...message, at });
      inbox.markProcessed(at);
      await this.deps.inbox.record(inbox);
      return this.deps.submit.execute(message.command);
    });
  }
}
