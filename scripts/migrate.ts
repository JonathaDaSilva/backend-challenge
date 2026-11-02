import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../src/shared/infrastructure/config';
import { createMikroOrmConfig } from '../src/shared/infrastructure/database/mikro-orm.config';

const [command, ...args] = process.argv.slice(2);

const orm = await MikroORM.init(createMikroOrmConfig(loadConfig().migrationDatabaseUrl));
const migrator = orm.migrator;

try {
  switch (command) {
    case 'up': {
      const executed = await migrator.up();
      console.log(executed.length ? `Applied: ${executed.map((m) => m.name).join(', ')}` : 'Nothing to apply.');
      break;
    }
    case 'down': {
      const all = args.includes('--all');
      const to = args[args.indexOf('--to') + 1];
      const options = all ? { to: 0 } : args.includes('--to') && to ? { to } : undefined;
      const reverted = await migrator.down(options);
      console.log(reverted.length ? `Reverted: ${reverted.map((m) => m.name).join(', ')}` : 'Nothing to revert.');
      break;
    }
    case 'create': {
      const name = args[0];
      if (!name) throw new Error('Usage: bun run db:migrate:create <name>');
      const result = await migrator.create(undefined, true, false, name);
      console.log(`Created: ${result.fileName}`);
      break;
    }
    case 'pending': {
      const pending = await migrator.getPending();
      console.log(pending.length ? pending.map((m) => m.name).join('\n') : 'No pending migrations.');
      break;
    }
    default:
      throw new Error(`Unknown command "${command ?? ''}". Use up, down, create or pending.`);
  }
} finally {
  await orm.close(true);
}
