import { afterAll } from 'bun:test';
import { registeredWallets } from '../support/wallet-registry';

// Roda uma vez, depois de todos os arquivos de teste: nenhuma wallet criada pela suíte pode terminar inconsistente.
afterAll(async () => {
  const walletIds = registeredWallets();
  if (walletIds.length === 0) return;

  const { MikroORM } = await import('@mikro-orm/postgresql');
  const { loadConfig } = await import('../../src/shared/infrastructure/config');
  const { createMikroOrmConfig } = await import('../../src/shared/infrastructure/database/mikro-orm.config');
  const { findInvariantViolations } = await import('../support/ledger-invariant');

  const orm = await MikroORM.init(createMikroOrmConfig(loadConfig().migrationDatabaseUrl));
  try {
    const violations = await findInvariantViolations(orm.em.fork(), walletIds);
    if (violations.length > 0) {
      const detail = violations.map((violation) => `${violation.walletId}: ${violation.problem}`).join('\n');
      throw new Error(`Ledger invariant broken for ${violations.length} wallet(s):\n${detail}`);
    }
  } finally {
    await orm.close(true);
  }
});
