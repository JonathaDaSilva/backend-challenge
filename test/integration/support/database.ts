import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../../../src/shared/infrastructure/database/mikro-orm.config';

export async function initTestOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init(createMikroOrmConfig());
  await orm.migrator.up();
  return orm;
}
