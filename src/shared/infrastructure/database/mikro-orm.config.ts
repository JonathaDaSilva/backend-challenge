import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WagerTransactionRecordSchema } from '../../../modules/wagering/infrastructure/persistence/wager-transaction.record';
import { WagerTransactionReversalRecordSchema } from '../../../modules/wagering/infrastructure/persistence/wager-transaction-reversal.record';
import { WalletLedgerEntryRecordSchema } from '../../../modules/wallet/infrastructure/persistence/wallet-ledger-entry.record';
import { WalletRecordSchema } from '../../../modules/wallet/infrastructure/persistence/wallet.record';
import { loadConfig } from '../config';
import { InboxMessageRecordSchema } from './inbox.record';

export const entities = [
  WalletRecordSchema,
  WalletLedgerEntryRecordSchema,
  WagerTransactionRecordSchema,
  WagerTransactionReversalRecordSchema,
  InboxMessageRecordSchema,
];

export function createMikroOrmConfig(databaseUrl = loadConfig().databaseUrl) {
  return defineConfig({
    clientUrl: databaseUrl,
    pool: { max: loadConfig().database.poolMax },
    entities,
    extensions: [Migrator],
    preferTs: true,
    migrations: {
      path: 'migrations',
      pathTs: 'migrations',
      glob: '!(*.d).{js,ts}',
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      emit: 'ts',
    },
  });
}

export default createMikroOrmConfig();
