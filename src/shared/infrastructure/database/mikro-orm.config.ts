import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { loadConfig } from '../config';

// Entities are mapped with EntitySchema inside each module's infrastructure layer,
// keeping domain classes free of ORM decorators (README §6).
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
