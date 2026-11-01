export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export type InvalidMoneyReason =
  | 'NOT_A_STRING'
  | 'INVALID_FORMAT'
  | 'TOO_MANY_DECIMALS'
  | 'OUT_OF_RANGE'
  | 'NEGATIVE_NOT_ALLOWED'
  | 'INVALID_CURRENCY';

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(
    readonly reason: InvalidMoneyReason,
    message: string,
  ) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}
