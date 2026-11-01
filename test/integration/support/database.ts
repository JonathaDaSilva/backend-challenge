import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../../../src/shared/infrastructure/database/mikro-orm.config';

// Integration tests run against the real PostgreSQL from docker-compose.
// Migrations are applied up front so a fresh database works out of the box.
export async function initTestOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init(createMikroOrmConfig());
  await orm.migrator.up();
  return orm;
}
