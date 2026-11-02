import type { Clock } from '../../../shared/application/clock';
import type { IdGenerator } from '../../../shared/application/id-generator';
import { MetricNames, type Metrics, type StructuredLogger } from '../../../shared/application/observability';
import type { TransactionRunner } from '../../../shared/application/transaction-runner';
import { WalletNotFoundError } from './errors';
import type { LedgerQuery, ReconciliationRepository, WalletReconciliation, WalletRepository } from './ports';

export interface ReconcileWalletDependencies {
  readonly wallets: WalletRepository;
  readonly ledger: LedgerQuery;
  readonly reconciliations: ReconciliationRepository;
  readonly runner: TransactionRunner;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly metrics: Metrics;
  readonly logger: StructuredLogger;
}

export class ReconcileWalletUseCase {
  constructor(private readonly deps: ReconcileWalletDependencies) {}

  async execute(walletId: string): Promise<WalletReconciliation> {
    const { runner, wallets, ledger } = this.deps;

    const { wallet, totals } = await runner.run(
      async () => {
        const found = await wallets.findById(walletId);
        if (!found) throw new WalletNotFoundError(walletId);
        return { wallet: found, totals: await ledger.totals(walletId, found.currency) };
      },
      { snapshot: true },
    );

    const difference = wallet.balance.subtract(totals.balance);
    const reconciliation: WalletReconciliation = {
      id: this.deps.ids.next(),
      walletId,
      storedBalance: wallet.balance,
      calculatedBalance: totals.balance,
      difference,
      consistent: difference.isZero(),
      checkedEntries: totals.entries,
      checkedAt: this.deps.clock.now(),
    };
    await runner.run(() => this.deps.reconciliations.insert(reconciliation));

    if (!reconciliation.consistent) {
      this.deps.metrics.increment(MetricNames.ReconciliationDivergences, { currency: wallet.currency });
      this.deps.logger.warn('wallet reconciliation found a divergence', {
        walletId,
        reconciliationId: reconciliation.id,
        storedBalance: reconciliation.storedBalance.toString(),
        calculatedBalance: reconciliation.calculatedBalance.toString(),
        difference: difference.toString(),
        checkedEntries: totals.entries,
      });
    }
    return reconciliation;
  }
}
