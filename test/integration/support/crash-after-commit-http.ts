import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module';
import { WAGER_TRANSACTION_REPOSITORY, type WagerTransactionRepository } from '../../../src/modules/wagering/application/ports';
import {
  type SubmitWagerTransactionCommand,
  SubmitWagerTransactionUseCase,
} from '../../../src/modules/wagering/application/submit-wager-transaction.use-case';
import { WagerProcessor } from '../../../src/modules/wagering/application/wager-processor';
import { WALLET_REPOSITORY, type WalletRepository } from '../../../src/modules/wallet/application/ports';
import { CLOCK, type Clock } from '../../../src/shared/application/clock';
import { CORRELATION_CONTEXT, type CorrelationContext } from '../../../src/shared/application/correlation';
import { ID_GENERATOR, type IdGenerator } from '../../../src/shared/application/id-generator';
import { METRICS, type Metrics } from '../../../src/shared/application/observability';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../../../src/shared/application/transaction-runner';
import { loadConfig } from '../../../src/shared/infrastructure/config';
import { CRASH_EXIT_CODE } from './crash-exit-code';

// Instância de teste: na N-ésima submissão, morre logo depois do commit e antes de responder ao cliente.
const crashOn = Number(Bun.env.CRASH_ON_SUBMISSION ?? '3');
let submissions = 0;

const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(SubmitWagerTransactionUseCase)
  .useFactory({
    inject: [
      WALLET_REPOSITORY,
      WAGER_TRANSACTION_REPOSITORY,
      WagerProcessor,
      TRANSACTION_RUNNER,
      ID_GENERATOR,
      CLOCK,
      METRICS,
      CORRELATION_CONTEXT,
    ],
    factory: (
      wallets: WalletRepository,
      transactions: WagerTransactionRepository,
      processor: WagerProcessor,
      runner: TransactionRunner,
      ids: IdGenerator,
      clock: Clock,
      metrics: Metrics,
      context: CorrelationContext,
    ) => {
      const real = new SubmitWagerTransactionUseCase({ wallets, transactions, processor, runner, ids, clock, metrics, context });
      return {
        execute: async (command: SubmitWagerTransactionCommand) => {
          const result = await real.execute(command);
          submissions++;
          if (submissions === crashOn) process.exit(CRASH_EXIT_CODE);
          return result;
        },
      };
    },
  })
  .compile();

const app = moduleRef.createNestApplication({ logger: false });
await app.listen(loadConfig().port);
