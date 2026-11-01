import type { Clock } from '../../../shared/application/clock';
import type { IdGenerator } from '../../../shared/application/id-generator';
import type { TransactionRunner } from '../../../shared/application/transaction-runner';
import type { Money } from '../../../shared/domain/money';
import type { WagerTransactionRepository } from '../../wagering/application/ports';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { UnsupportedCurrencyError, WalletAlreadyExistsError } from './errors';
import type { LedgerRepository, WalletRepository } from './ports';

export interface OpenWalletCommand {
  readonly playerId: string;
  readonly initialBalance: Money;
}

export interface OpenWalletDependencies {
  readonly wallets: WalletRepository;
  readonly ledger: LedgerRepository;
  readonly transactions: WagerTransactionRepository;
  readonly runner: TransactionRunner;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly supportedCurrencies: readonly string[];
}

export class OpenWalletUseCase {
  constructor(private readonly deps: OpenWalletDependencies) {}

  async execute(command: OpenWalletCommand): Promise<Wallet> {
    const { currency } = command.initialBalance;
    if (!this.deps.supportedCurrencies.includes(currency)) {
      throw new UnsupportedCurrencyError(currency, this.deps.supportedCurrencies);
    }

    try {
      return await this.deps.runner.run(() => this.open(command));
    } catch (error) {
      if (!(error instanceof WalletAlreadyExistsError)) throw error;
      const existing = await this.deps.wallets.findByPlayerAndCurrency(command.playerId, currency);
      throw new WalletAlreadyExistsError(command.playerId, currency, existing?.id);
    }
  }

  private async open(command: OpenWalletCommand): Promise<Wallet> {
    const { ids, clock } = this.deps;
    const at = clock.now();
    const { wallet, openingEntry } = Wallet.open({
      id: ids.next(),
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      openingTransactionId: ids.next(),
      openingEntryId: ids.next(),
      at,
    });

    await this.deps.wallets.insert(wallet);

    if (openingEntry) {
      await this.deps.transactions.insert(
        WagerTransaction.opening({
          id: openingEntry.transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: openingEntry.money,
          at,
        }),
      );
      await this.deps.ledger.append(openingEntry);
    }

    return wallet;
  }
}
