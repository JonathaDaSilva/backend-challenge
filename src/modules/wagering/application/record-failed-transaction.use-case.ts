import type { Clock } from '../../../shared/application/clock';
import type { IdGenerator } from '../../../shared/application/id-generator';
import type { InboxRepository } from '../../../shared/application/inbox';
import type { TransactionRunner } from '../../../shared/application/transaction-runner';
import { InboxMessage } from '../../../shared/domain/inbox-message';
import type { WalletRepository } from '../../wallet/application/ports';
import { WagerTransaction } from '../domain/wager-transaction';
import { wagerPayloadHash } from './payload-hash';
import type { WagerTransactionRepository } from './ports';
import type { WagerMessage } from './process-wager-message.use-case';

export const PERMANENT_FAILURE = 'PERMANENT_FAILURE';

export type FailedRecording = 'recorded' | 'already-recorded' | 'not-recordable';

export interface RecordFailedTransactionDependencies {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly inbox: InboxRepository;
  readonly runner: TransactionRunner;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export class RecordFailedTransactionUseCase {
  constructor(private readonly deps: RecordFailedTransactionDependencies) {}

  // Melhor esforço: se o banco segue fora (motivo comum da falha), a mensagem vai para a DLQ sem o registro.
  async execute(message: WagerMessage): Promise<FailedRecording> {
    return this.deps.runner.run(async () => {
      const { command } = message;
      const at = this.deps.clock.now();
      const wallet = await this.deps.wallets.findByIdForUpdate(command.walletId);
      const compatible =
        wallet !== undefined && wallet.playerId === command.playerId && wallet.currency === command.money.currency;
      if (!compatible) return 'not-recordable';
      if (await this.deps.transactions.findByIdempotencyKey(command.idempotencyKey)) return 'already-recorded';

      const inbox = InboxMessage.receive({ ...message, at });
      inbox.markProcessed(at);
      await this.deps.inbox.record(inbox);

      const transaction = WagerTransaction.create({
        ...command,
        id: this.deps.ids.next(),
        payloadHash: wagerPayloadHash({ ...command, money: command.money.toJSON() }),
        at,
      });
      transaction.fail(PERMANENT_FAILURE);
      await this.deps.transactions.insert(transaction);
      return 'recorded';
    });
  }
}
