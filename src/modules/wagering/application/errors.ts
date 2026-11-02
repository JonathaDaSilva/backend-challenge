import { ApplicationError } from '../../../shared/application/errors';

export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(
    readonly idempotencyKey: string,
    readonly transactionId: string,
  ) {
    super(`Idempotency-Key ${idempotencyKey} was already used with a different payload`);
  }
}

export class DuplicateExternalTransactionError extends ApplicationError {
  readonly code = 'DUPLICATE_EXTERNAL_TRANSACTION';

  constructor(
    readonly providerId: string,
    readonly externalTransactionId: string,
  ) {
    super(`Transaction ${externalTransactionId} from ${providerId} was already submitted with another Idempotency-Key`);
  }
}

export class DuplicateIdempotencyKeyError extends ApplicationError {
  readonly code = 'DUPLICATE_IDEMPOTENCY_KEY';
}

export class WalletPlayerMismatchError extends ApplicationError {
  readonly code = 'WALLET_PLAYER_MISMATCH';

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} does not belong to the given player`);
  }
}

export class WalletCurrencyMismatchError extends ApplicationError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly walletCurrency: string,
    readonly currency: string,
  ) {
    super(`Wallet currency is ${walletCurrency}, transaction currency is ${currency}`);
  }
}

export class UnknownWalletError extends ApplicationError {
  readonly code = 'UNKNOWN_WALLET';

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} does not exist`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}
