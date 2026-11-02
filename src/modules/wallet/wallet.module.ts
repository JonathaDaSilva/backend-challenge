import { Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../../shared/application/clock';
import { EventRecorder } from '../../shared/application/event-recorder';
import { ID_GENERATOR, type IdGenerator } from '../../shared/application/id-generator';
import {
  METRICS,
  type Metrics,
  STRUCTURED_LOGGER,
  type StructuredLogger,
} from '../../shared/application/observability';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../../shared/application/transaction-runner';
import type { AppConfig } from '../../shared/infrastructure/config';
import { APP_CONFIG } from '../../shared/infrastructure/tokens';
import { WAGER_TRANSACTION_REPOSITORY, type WagerTransactionRepository } from '../wagering/application/ports';
import { GetWalletUseCase } from './application/get-wallet.use-case';
import { ListLedgerUseCase } from './application/list-ledger.use-case';
import { OpenWalletUseCase } from './application/open-wallet.use-case';
import { ReconcileWalletUseCase } from './application/reconcile-wallet.use-case';
import {
  LEDGER_QUERY,
  LEDGER_REPOSITORY,
  type LedgerQuery,
  type LedgerRepository,
  RECONCILIATION_REPOSITORY,
  type ReconciliationRepository,
  WALLET_REPOSITORY,
  type WalletRepository,
} from './application/ports';
import { WalletsController } from './presentation/wallets.controller';

@Module({
  controllers: [WalletsController],
  providers: [
    {
      provide: OpenWalletUseCase,
      inject: [WALLET_REPOSITORY, LEDGER_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, TRANSACTION_RUNNER, ID_GENERATOR, CLOCK, APP_CONFIG, EventRecorder],
      useFactory: (
        wallets: WalletRepository,
        ledger: LedgerRepository,
        transactions: WagerTransactionRepository,
        runner: TransactionRunner,
        ids: IdGenerator,
        clock: Clock,
        config: AppConfig,
        events: EventRecorder,
      ) =>
        new OpenWalletUseCase({
          wallets,
          ledger,
          transactions,
          runner,
          ids,
          clock,
          supportedCurrencies: config.supportedCurrencies,
          events,
        }),
    },
    {
      provide: GetWalletUseCase,
      inject: [WALLET_REPOSITORY],
      useFactory: (wallets: WalletRepository) => new GetWalletUseCase(wallets),
    },
    {
      provide: ListLedgerUseCase,
      inject: [WALLET_REPOSITORY, LEDGER_QUERY],
      useFactory: (wallets: WalletRepository, ledger: LedgerQuery) => new ListLedgerUseCase(wallets, ledger),
    },
    {
      provide: ReconcileWalletUseCase,
      inject: [
        WALLET_REPOSITORY,
        LEDGER_QUERY,
        RECONCILIATION_REPOSITORY,
        TRANSACTION_RUNNER,
        ID_GENERATOR,
        CLOCK,
        METRICS,
        STRUCTURED_LOGGER,
      ],
      useFactory: (
        wallets: WalletRepository,
        ledger: LedgerQuery,
        reconciliations: ReconciliationRepository,
        runner: TransactionRunner,
        ids: IdGenerator,
        clock: Clock,
        metrics: Metrics,
        logger: StructuredLogger,
      ) => new ReconcileWalletUseCase({ wallets, ledger, reconciliations, runner, ids, clock, metrics, logger }),
    },
  ],
})
export class WalletModule {}
