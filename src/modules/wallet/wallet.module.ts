import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { CLOCK, type Clock } from '../../shared/application/clock';
import { ID_GENERATOR, type IdGenerator } from '../../shared/application/id-generator';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../../shared/application/transaction-runner';
import type { AppConfig } from '../../shared/infrastructure/config';
import { APP_CONFIG } from '../../shared/infrastructure/tokens';
import { WAGER_TRANSACTION_REPOSITORY, type WagerTransactionRepository } from '../wagering/application/ports';
import { WageringModule } from '../wagering/wagering.module';
import { GetWalletUseCase } from './application/get-wallet.use-case';
import { OpenWalletUseCase } from './application/open-wallet.use-case';
import { LEDGER_REPOSITORY, type LedgerRepository, WALLET_REPOSITORY, type WalletRepository } from './application/ports';
import {
  MikroOrmLedgerRepository,
  MikroOrmWalletRepository,
} from './infrastructure/persistence/mikro-orm-wallet.repository';
import { WalletsController } from './presentation/wallets.controller';

@Module({
  imports: [WageringModule],
  controllers: [WalletsController],
  providers: [
    {
      provide: WALLET_REPOSITORY,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new MikroOrmWalletRepository(em),
    },
    {
      provide: LEDGER_REPOSITORY,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new MikroOrmLedgerRepository(em),
    },
    {
      provide: OpenWalletUseCase,
      inject: [WALLET_REPOSITORY, LEDGER_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, TRANSACTION_RUNNER, ID_GENERATOR, CLOCK, APP_CONFIG],
      useFactory: (
        wallets: WalletRepository,
        ledger: LedgerRepository,
        transactions: WagerTransactionRepository,
        runner: TransactionRunner,
        ids: IdGenerator,
        clock: Clock,
        config: AppConfig,
      ) =>
        new OpenWalletUseCase({
          wallets,
          ledger,
          transactions,
          runner,
          ids,
          clock,
          supportedCurrencies: config.supportedCurrencies,
        }),
    },
    {
      provide: GetWalletUseCase,
      inject: [WALLET_REPOSITORY],
      useFactory: (wallets: WalletRepository) => new GetWalletUseCase(wallets),
    },
  ],
})
export class WalletModule {}
