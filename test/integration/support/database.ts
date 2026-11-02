import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../../src/shared/infrastructure/config';
import { createMikroOrmConfig } from '../../../src/shared/infrastructure/database/mikro-orm.config';

export async function initOwnerOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init(createMikroOrmConfig(loadConfig().migrationDatabaseUrl));
  await orm.migrator.up();
  return orm;
}

export async function initTestOrm(): Promise<MikroORM> {
  const owner = await initOwnerOrm();
  await owner.close(true);
  return MikroORM.init(createMikroOrmConfig(loadConfig().databaseUrl));
}

export interface TestDatabases {
  readonly owner: MikroORM;
  readonly app: MikroORM;
  close(): Promise<void>;
}

export async function initTestDatabases(): Promise<TestDatabases> {
  const owner = await initOwnerOrm();
  const app = await MikroORM.init(createMikroOrmConfig(loadConfig().databaseUrl));
  return {
    owner,
    app,
    async close() {
      await app.close(true);
      await owner.close(true);
    },
  };
}
