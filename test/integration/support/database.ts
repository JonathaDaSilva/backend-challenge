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
