import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { CLOCK, type Clock } from '../../shared/application/clock';
import { ID_GENERATOR, type IdGenerator } from '../../shared/application/id-generator';
import { INBOX_REPOSITORY, type InboxRepository } from '../../shared/application/inbox';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../../shared/application/transaction-runner';
import type { AppConfig } from '../../shared/infrastructure/config';
import { APP_CONFIG, SQS_CLIENT } from '../../shared/infrastructure/tokens';
import { LEDGER_REPOSITORY, type LedgerRepository, WALLET_REPOSITORY, type WalletRepository } from '../wallet/application/ports';
import { GetWagerTransactionUseCase } from './application/get-wager-transaction.use-case';
import { PendingReferencePolicy } from './application/pending-reference-policy';
import { PendingReferenceWorker } from './application/pending-reference-worker';
import { WAGER_TRANSACTION_REPOSITORY, type WagerTransactionRepository } from './application/ports';
import { ProcessWagerMessageUseCase } from './application/process-wager-message.use-case';
import { RecordFailedTransactionUseCase } from './application/record-failed-transaction.use-case';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.use-case';
import { WagerProcessor } from './application/wager-processor';
import { WagerTransactionsConsumer } from './infrastructure/messaging/wager-transactions.consumer';
import { PendingReferenceScheduler } from './infrastructure/pending-reference-scheduler';
import { WageringController } from './presentation/wagering.controller';

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: PendingReferencePolicy,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new PendingReferencePolicy(config.pendingReference),
    },
    {
      provide: WagerProcessor,
      inject: [WALLET_REPOSITORY, LEDGER_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, ID_GENERATOR, PendingReferencePolicy],
      useFactory: (
        wallets: WalletRepository,
        ledger: LedgerRepository,
        transactions: WagerTransactionRepository,
        ids: IdGenerator,
        policy: PendingReferencePolicy,
      ) => new WagerProcessor({ wallets, ledger, transactions, ids, policy }),
    },
    {
      provide: SubmitWagerTransactionUseCase,
      inject: [WALLET_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, WagerProcessor, TRANSACTION_RUNNER, ID_GENERATOR, CLOCK],
      useFactory: (
        wallets: WalletRepository,
        transactions: WagerTransactionRepository,
        processor: WagerProcessor,
        runner: TransactionRunner,
        ids: IdGenerator,
        clock: Clock,
      ) => new SubmitWagerTransactionUseCase({ wallets, transactions, processor, runner, ids, clock }),
    },
    {
      provide: PendingReferenceWorker,
      inject: [
        WALLET_REPOSITORY,
        WAGER_TRANSACTION_REPOSITORY,
        WagerProcessor,
        TRANSACTION_RUNNER,
        PendingReferencePolicy,
        APP_CONFIG,
      ],
      useFactory: (
        wallets: WalletRepository,
        transactions: WagerTransactionRepository,
        processor: WagerProcessor,
        runner: TransactionRunner,
        policy: PendingReferencePolicy,
        config: AppConfig,
      ) =>
        new PendingReferenceWorker({
          wallets,
          transactions,
          processor,
          runner,
          policy,
          batchSize: config.pendingReference.batchSize,
        }),
    },
    {
      provide: PendingReferenceScheduler,
      inject: [PendingReferenceWorker, CLOCK, APP_CONFIG],
      useFactory: (worker: PendingReferenceWorker, clock: Clock, config: AppConfig) =>
        new PendingReferenceScheduler(worker, clock, config.databaseUrl),
    },
    {
      provide: ProcessWagerMessageUseCase,
      inject: [INBOX_REPOSITORY, SubmitWagerTransactionUseCase, TRANSACTION_RUNNER, CLOCK],
      useFactory: (
        inbox: InboxRepository,
        submit: SubmitWagerTransactionUseCase,
        runner: TransactionRunner,
        clock: Clock,
      ) => new ProcessWagerMessageUseCase({ inbox, submit, runner, clock }),
    },
    {
      provide: RecordFailedTransactionUseCase,
      inject: [WALLET_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, INBOX_REPOSITORY, TRANSACTION_RUNNER, ID_GENERATOR, CLOCK],
      useFactory: (
        wallets: WalletRepository,
        transactions: WagerTransactionRepository,
        inbox: InboxRepository,
        runner: TransactionRunner,
        ids: IdGenerator,
        clock: Clock,
      ) => new RecordFailedTransactionUseCase({ wallets, transactions, inbox, runner, ids, clock }),
    },
    {
      provide: WagerTransactionsConsumer,
      inject: [SQS_CLIENT, ProcessWagerMessageUseCase, RecordFailedTransactionUseCase, APP_CONFIG],
      useFactory: (
        sqs: SQSClient,
        processMessage: ProcessWagerMessageUseCase,
        recordFailed: RecordFailedTransactionUseCase,
        config: AppConfig,
      ) =>
        new WagerTransactionsConsumer(sqs, processMessage, recordFailed, {
          ...config.sqs,
          queueName: config.sqs.wagerQueue,
          dlqName: config.sqs.wagerDlq,
        }),
    },
    {
      provide: GetWagerTransactionUseCase,
      inject: [WAGER_TRANSACTION_REPOSITORY],
      useFactory: (transactions: WagerTransactionRepository) => new GetWagerTransactionUseCase(transactions),
    },
  ],
  exports: [SubmitWagerTransactionUseCase, PendingReferenceWorker, WagerTransactionsConsumer],
})
export class WageringModule implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(
    @Inject(PendingReferenceScheduler) private readonly scheduler: PendingReferenceScheduler,
    @Inject(WagerTransactionsConsumer) private readonly consumer: WagerTransactionsConsumer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.pendingReference.workerEnabled) await this.scheduler.start();
    if (this.config.sqs.consumerEnabled) this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.scheduler.stop();
  }
}
