import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { loadConfig } from '../config';

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
      snapshot: false,
      emit: 'ts',
    },
  });
}

export default createMikroOrmConfig();
