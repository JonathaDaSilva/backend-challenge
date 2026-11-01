import Big from 'big.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const Decimal = Big();
Decimal.strict = true;

const SCALE = 2;
const MAX_INTEGER_DIGITS = 18;
const UPPER_BOUND = new Decimal(`1${'0'.repeat(MAX_INTEGER_DIGITS)}`);
const ZERO = new Decimal('0');

const CANONICAL_AMOUNT = /^-?(0|[1-9]\d*)\.\d{2}$/;
const EXCESS_DECIMALS = /^-?(0|[1-9]\d*)\.\d{3,}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Big,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    return Money.parse(props.amount, props.currency);
  }

  static fromInput(props: { amount: unknown; currency: unknown }): Money {
    const money = Money.parse(props.amount, props.currency);
    if (money.isNegative()) {
      throw new InvalidMoneyError('NEGATIVE_NOT_ALLOWED', 'Amount must not be negative');
    }
    return money;
  }

  static zero(currency: string): Money {
    return new Money(ZERO, Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.create(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.create(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.create(this.value.neg(), this.currency);
  }

  isZero(): boolean {
    return this.value.eq(ZERO);
  }

  isPositive(): boolean {
    return this.value.gt(ZERO);
  }

  isNegative(): boolean {
    return this.value.lt(ZERO);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.gte(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.eq(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parse(amount: unknown, currency: unknown): Money {
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('NOT_A_STRING', 'Amount must be a decimal string');
    }
    if (EXCESS_DECIMALS.test(amount)) {
      throw new InvalidMoneyError('TOO_MANY_DECIMALS', `Amount must have exactly ${SCALE} decimal places`);
    }
    if (!CANONICAL_AMOUNT.test(amount) || amount === '-0.00') {
      throw new InvalidMoneyError('INVALID_FORMAT', `Invalid amount: "${amount}"`);
    }
    return Money.create(new Decimal(amount), Money.assertCurrency(currency));
  }

  private static create(value: Big, currency: string): Money {
    if (value.abs().gte(UPPER_BOUND)) {
      throw new InvalidMoneyError('OUT_OF_RANGE', `Amount exceeds ${MAX_INTEGER_DIGITS} integer digits`);
    }
    return new Money(value.eq(ZERO) ? ZERO : value, currency);
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_CODE.test(currency)) {
      throw new InvalidMoneyError('INVALID_CURRENCY', 'Currency must be an ISO-4217 code such as "BRL"');
    }
    return currency;
  }
}
