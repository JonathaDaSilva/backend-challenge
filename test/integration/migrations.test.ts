import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { createMikroOrmConfig } from '../../src/shared/infrastructure/database/mikro-orm.config';

const DATABASE = `wallet_migrations_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`;
const APPLICATION_TABLES = [
  'inbox_messages',
  'outbox_messages',
  'wager_transaction_reversals',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallet_reconciliations',
  'wallets',
];

let admin: MikroORM;
let scratch: MikroORM;

function urlFor(database: string): string {
  const url = new URL(loadConfig().migrationDatabaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function tables(orm: MikroORM): Promise<string[]> {
  const rows = await orm.em
    .fork()
    .execute<{ table_name: string }[]>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name <> 'mikro_orm_migrations' order by table_name",
    );
  return rows.map((row) => row.table_name);
}

async function triggers(orm: MikroORM): Promise<string[]> {
  const rows = await orm.em
    .fork()
    .execute<{ name: string }[]>("select tgname as name from pg_trigger where not tgisinternal order by tgname");
  return rows.map((row) => row.name);
}

beforeAll(async () => {
  admin = await MikroORM.init(createMikroOrmConfig(loadConfig().migrationDatabaseUrl));
  await admin.em.fork().execute(`create database ${DATABASE}`);
  scratch = await MikroORM.init(createMikroOrmConfig(urlFor(DATABASE)));
});

afterAll(async () => {
  await scratch?.close(true);
  await admin.em.fork().execute(`drop database if exists ${DATABASE} with (force)`);
  await admin.close(true);
});

describe('migrations on a throwaway database', () => {
  test('up creates every table and trigger, down removes them all, up again restores them', async () => {
    const applied = await scratch.migrator.up();
    expect(applied.length).toBeGreaterThan(0);
    expect(await tables(scratch)).toEqual(APPLICATION_TABLES);
    const triggersAfterUp = await triggers(scratch);
    expect(triggersAfterUp).toEqual(
      expect.arrayContaining([
        'wallet_ledger_append_only_trg',
        'wallet_ledger_no_truncate_trg',
        'wager_tx_reversals_match_trg',
        'wager_tx_pending_reference_notify_trg',
        'outbox_messages_notify_trg',
        'wallet_reconciliations_append_only_trg',
      ]),
    );

    const reverted = await scratch.migrator.down({ to: 0 });
    expect(reverted.map((migration) => migration.name)).toEqual(applied.map((migration) => migration.name).reverse());
    expect(await tables(scratch)).toEqual([]);
    expect(await triggers(scratch)).toEqual([]);
    expect(await scratch.migrator.getPending()).toHaveLength(applied.length);

    const reapplied = await scratch.migrator.up();
    expect(reapplied.map((migration) => migration.name)).toEqual(applied.map((migration) => migration.name));
    expect(await tables(scratch)).toEqual(APPLICATION_TABLES);
    expect(await triggers(scratch)).toEqual(triggersAfterUp);
  });

  test('the application role gets exactly the documented privileges', async () => {
    const rows = await scratch.em.fork().execute<{ table_name: string; privileges: string }[]>(
      `select table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges
         from information_schema.role_table_grants
        where grantee = 'wallet_app'
        group by table_name
        order by table_name`,
    );
    expect(Object.fromEntries(rows.map((row) => [row.table_name, row.privileges]))).toEqual({
      inbox_messages: 'INSERT,SELECT,UPDATE',
      outbox_messages: 'INSERT,SELECT,UPDATE',
      wager_transaction_reversals: 'INSERT,SELECT',
      wager_transactions: 'INSERT,SELECT,UPDATE',
      wallet_ledger_entries: 'INSERT,SELECT',
      wallet_reconciliations: 'INSERT,SELECT',
      wallets: 'INSERT,SELECT,UPDATE',
    });
  });
});
