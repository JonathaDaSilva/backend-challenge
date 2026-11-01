import { Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../../shared/application/clock';
import { ID_GENERATOR, type IdGenerator } from '../../shared/application/id-generator';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../../shared/application/transaction-runner';
import { LEDGER_REPOSITORY, type LedgerRepository, WALLET_REPOSITORY, type WalletRepository } from '../wallet/application/ports';
import { GetWagerTransactionUseCase } from './application/get-wager-transaction.use-case';
import { WAGER_TRANSACTION_REPOSITORY, type WagerTransactionRepository } from './application/ports';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.use-case';
import { WageringController } from './presentation/wagering.controller';

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: SubmitWagerTransactionUseCase,
      inject: [WALLET_REPOSITORY, LEDGER_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, TRANSACTION_RUNNER, ID_GENERATOR, CLOCK],
      useFactory: (
        wallets: WalletRepository,
        ledger: LedgerRepository,
        transactions: WagerTransactionRepository,
        runner: TransactionRunner,
        ids: IdGenerator,
        clock: Clock,
      ) => new SubmitWagerTransactionUseCase({ wallets, ledger, transactions, runner, ids, clock }),
    },
    {
      provide: GetWagerTransactionUseCase,
      inject: [WAGER_TRANSACTION_REPOSITORY],
      useFactory: (transactions: WagerTransactionRepository) => new GetWagerTransactionUseCase(transactions),
    },
  ],
  exports: [SubmitWagerTransactionUseCase],
})
export class WageringModule {}
