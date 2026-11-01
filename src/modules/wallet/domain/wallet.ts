import { CurrencyMismatchError } from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/money';
import { InsufficientFundsError, InvalidMovementError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly openingTransactionId: string;
  readonly openingEntryId: string;
  readonly at: Date;
}

export interface BalanceMovement {
  readonly entryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly at: Date;
}

export interface OpenedWallet {
  readonly wallet: Wallet;
  readonly openingEntry: WalletLedgerEntry | undefined;
}

export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMovementError('Initial balance must not be negative');
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, Money.zero(currency), 0, props.at, props.at);

    if (props.initialBalance.isZero()) {
      wallet._version = 1;
      return { wallet, openingEntry: undefined };
    }

    const openingEntry = wallet.credit({
      entryId: props.openingEntryId,
      transactionId: props.openingTransactionId,
      money: props.initialBalance,
      at: props.at,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertMovement(movement.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(movement.money), movement);
  }

  debit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertMovement(movement.money);
    if (this._balance.isLessThan(movement.money)) {
      throw new InsufficientFundsError(this.id, this._balance.toString(), movement.money.toString());
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(movement.money), movement);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private apply(direction: LedgerDirection, balanceAfter: Money, movement: BalanceMovement): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertMovement(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
    if (!money.isPositive()) {
      throw new InvalidMovementError('Movement amount must be positive');
    }
  }
}
