import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/database/mikro-orm-transaction-runner';
import { initTestOrm } from './support/database';

let orm: MikroORM;
let runner: MikroOrmTransactionRunner;

// Stands in for a real repository: it holds the global EntityManager and never
// receives a transaction handle, exactly like the repositories from #04 onwards.
class ProbeRepository {
  constructor(private readonly em: EntityManager) {}

  insert(id: string, value = '0.00'): Promise<unknown> {
    return this.em.execute('insert into tx_probe (id, value) values (?, ?)', [id, value]);
  }

  lock(id: string): Promise<unknown> {
    return this.em.execute('select id from tx_probe where id = ? for update', [id]);
  }
}

let repository: ProbeRepository;

async function ids(): Promise<string[]> {
  const rows = await orm.em.fork().execute<{ id: string }[]>('select id from tx_probe order by id');
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  orm = await initTestOrm();
  runner = new MikroOrmTransactionRunner(orm.em);
  repository = new ProbeRepository(orm.em);
  await orm.em
    .fork()
    .execute('create table if not exists tx_probe (id text primary key, value numeric(20,2) not null)');
});

beforeEach(async () => {
  await orm.em.fork().execute('truncate tx_probe');
});

afterAll(async () => {
  await orm.em.fork().execute('drop table if exists tx_probe');
  await orm.close(true);
});

describe('MikroOrmTransactionRunner', () => {
  test('commits the work', async () => {
    await runner.run(() => repository.insert('a'));
    expect(await ids()).toEqual(['a']);
  });

  test('rolls back every write when the work throws', async () => {
    const run = runner.run(async () => {
      await repository.insert('a');
      await repository.insert('b');
      throw new Error('business failure');
    });
    await expect(run).rejects.toThrow('business failure');
    expect(await ids()).toEqual([]);
  });

  test('propagates the transaction to repositories through AsyncLocalStorage', async () => {
    // em.execute() resolves the transactional fork from TransactionContext, while
    // em.getConnection().execute() bypasses it and autocommits on its own. This is
    // why repositories must never write through the raw connection.
    await runner
      .run(async () => {
        await repository.insert('joined');
        await orm.em.getConnection().execute("insert into tx_probe (id, value) values ('bypass', 0)");
        throw new Error('rollback');
      })
      .catch(() => undefined);

    expect(await ids()).toEqual(['bypass']);
  });

  test('nested runs join the outer transaction', async () => {
    await runner
      .run(async () => {
        await runner.run(() => repository.insert('inner'));
        await repository.insert('outer');
        throw new Error('outer failure');
      })
      .catch(() => undefined);

    expect(await ids()).toEqual([]);
  });

  test('SELECT FOR UPDATE serializes concurrent debits on the same row', async () => {
    await orm.em.fork().execute("insert into tx_probe (id, value) values ('wallet', 100.00)");

    // Two concurrent 80.00 debits against 100.00: the check runs under the row
    // lock, so the second debit sees the result of the first one.
    const debit = () =>
      runner.run(async () => {
        const [row] = await orm.em.execute<{ enough: boolean }[]>(
          "select value >= 80.00 as enough from tx_probe where id = 'wallet' for update",
        );
        await Bun.sleep(50);
        if (!row?.enough) return 'REJECTED';
        await orm.em.execute("update tx_probe set value = value - 80.00 where id = 'wallet'");
        return 'PROCESSED';
      });

    const results = await Promise.all([debit(), debit()]);
    const [final] = await orm.em
      .fork()
      .execute<{ value: string }[]>("select value from tx_probe where id = 'wallet'");

    expect(results.sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(final?.value).toBe('20.00');
  });

  test('retries a transient failure and returns the result', async () => {
    let attempts = 0;
    const result = await runner.run(async () => {
      attempts++;
      await repository.insert(`attempt-${attempts}`);
      if (attempts === 1) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    expect(await ids()).toEqual(['attempt-2']);
  });

  test('does not retry non-transient failures', async () => {
    let attempts = 0;
    const run = runner.run(async () => {
      attempts++;
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    });
    await expect(run).rejects.toThrow('duplicate key');
    expect(attempts).toBe(1);
  });

  test('gives up after the attempt limit', async () => {
    const limited = new MikroOrmTransactionRunner(orm.em, { maxAttempts: 3, baseDelayMs: 1 });
    let attempts = 0;
    const run = limited.run(async () => {
      attempts++;
      throw Object.assign(new Error('could not serialize access'), { code: '40001' });
    });
    await expect(run).rejects.toThrow('could not serialize access');
    expect(attempts).toBe(3);
  });

  test(
    'recovers from a real PostgreSQL deadlock',
    async () => {
      await orm.em.fork().execute("insert into tx_probe (id, value) values ('x', 0), ('y', 0)");
      const xLocked = Promise.withResolvers<void>();
      const yLocked = Promise.withResolvers<void>();
      let attempts = 0;

      // Opposite lock order: PostgreSQL aborts one side with 40P01 and the runner retries it.
      const first = runner.run(async () => {
        attempts++;
        await repository.lock('x');
        xLocked.resolve();
        await yLocked.promise;
        await repository.lock('y');
      });
      const second = runner.run(async () => {
        attempts++;
        await repository.lock('y');
        yLocked.resolve();
        await xLocked.promise;
        await repository.lock('x');
      });

      await Promise.all([first, second]);
      expect(attempts).toBe(3);
    },
    { timeout: 10_000 },
  );

  test('reads numeric(20,2) as an exact decimal string', async () => {
    await runner.run(async () => {
      await repository.insert('a', '0.10');
      await repository.insert('b', '0.20');
    });
    const [row] = await orm.em.fork().execute<{ total: unknown }[]>('select sum(value) as total from tx_probe');
    expect(row?.total).toBe('0.30');
  });
});
