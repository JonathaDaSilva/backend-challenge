import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { loadConfig } from '../config';

// Persistence records (plain classes such as WalletRecord) are mapped with
// EntitySchema inside each module's infrastructure/persistence folder. Domain
// classes are never mapped: repositories convert records through mappers that
// call the aggregate's rehydrate() factory (README §6.0).
export const entities = [];

export function createMikroOrmConfig(databaseUrl = loadConfig().databaseUrl) {
  return defineConfig({
    clientUrl: databaseUrl,
    entities,
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    preferTs: true,
    migrations: {
      path: 'migrations',
      pathTs: 'migrations',
      glob: '!(*.d).{js,ts}',
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      // Schema changes are written by hand: constraints and triggers are part of
      // the design (README restriction 9), so no snapshot-based diffing.
      snapshot: false,
      emit: 'ts',
    },
  });
}

export default createMikroOrmConfig();
