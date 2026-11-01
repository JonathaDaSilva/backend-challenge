import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WagerTransactionRecordSchema } from '../../../modules/wagering/infrastructure/persistence/wager-transaction.record';
import { WalletLedgerEntryRecordSchema } from '../../../modules/wallet/infrastructure/persistence/wallet-ledger-entry.record';
import { WalletRecordSchema } from '../../../modules/wallet/infrastructure/persistence/wallet.record';
import { loadConfig } from '../config';

export const entities = [WalletRecordSchema, WalletLedgerEntryRecordSchema, WagerTransactionRecordSchema];

export function createMikroOrmConfig(databaseUrl = loadConfig().databaseUrl) {
  return defineConfig({
    clientUrl: databaseUrl,
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
