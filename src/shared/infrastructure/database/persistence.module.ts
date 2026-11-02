import { Global, Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { INBOX_REPOSITORY } from '../../application/inbox';
import { OUTBOX_REPOSITORY } from '../../application/outbox';
import { WAGER_TRANSACTION_REPOSITORY } from '../../../modules/wagering/application/ports';
import { MikroOrmWagerTransactionRepository } from '../../../modules/wagering/infrastructure/persistence/mikro-orm-wager-transaction.repository';
import {
  LEDGER_QUERY,
  LEDGER_REPOSITORY,
  RECONCILIATION_REPOSITORY,
  WALLET_REPOSITORY,
} from '../../../modules/wallet/application/ports';
import { MikroOrmLedgerQuery } from '../../../modules/wallet/infrastructure/persistence/mikro-orm-ledger.query';
import { MikroOrmReconciliationRepository } from '../../../modules/wallet/infrastructure/persistence/mikro-orm-reconciliation.repository';
import {
  MikroOrmLedgerRepository,
  MikroOrmWalletRepository,
} from '../../../modules/wallet/infrastructure/persistence/mikro-orm-wallet.repository';
import { MikroOrmInboxRepository } from './mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from './mikro-orm-outbox.repository';

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
    {
      provide: INBOX_REPOSITORY,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new MikroOrmInboxRepository(em),
    },
    {
      provide: OUTBOX_REPOSITORY,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new MikroOrmOutboxRepository(em),
    },
    {
      provide: LEDGER_QUERY,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new MikroOrmLedgerQuery(em),
    },
    {
      provide: RECONCILIATION_REPOSITORY,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new MikroOrmReconciliationRepository(em),
    },
  ],
  exports: [WALLET_REPOSITORY, LEDGER_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, INBOX_REPOSITORY,
    OUTBOX_REPOSITORY,
    LEDGER_QUERY,
    RECONCILIATION_REPOSITORY,
  ],
})
export class PersistenceModule {}
