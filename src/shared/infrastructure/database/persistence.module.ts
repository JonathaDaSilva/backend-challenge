import { Global, Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { WAGER_TRANSACTION_REPOSITORY } from '../../../modules/wagering/application/ports';
import { MikroOrmWagerTransactionRepository } from '../../../modules/wagering/infrastructure/persistence/mikro-orm-wager-transaction.repository';
import { LEDGER_REPOSITORY, WALLET_REPOSITORY } from '../../../modules/wallet/application/ports';
import {
  MikroOrmLedgerRepository,
  MikroOrmWalletRepository,
} from '../../../modules/wallet/infrastructure/persistence/mikro-orm-wallet.repository';

@Global()
@Module({
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
      provide: WAGER_TRANSACTION_REPOSITORY,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new MikroOrmWagerTransactionRepository(em),
    },
  ],
  exports: [WALLET_REPOSITORY, LEDGER_REPOSITORY, WAGER_TRANSACTION_REPOSITORY],
})
export class PersistenceModule {}
