import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { WAGER_TRANSACTION_REPOSITORY } from './application/ports';
import { MikroOrmWagerTransactionRepository } from './infrastructure/persistence/mikro-orm-wager-transaction.repository';

@Module({
  providers: [
    {
      provide: WAGER_TRANSACTION_REPOSITORY,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new MikroOrmWagerTransactionRepository(em),
    },
  ],
  exports: [WAGER_TRANSACTION_REPOSITORY],
})
export class WageringModule {}
