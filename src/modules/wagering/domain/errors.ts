import { DomainError } from '../../../shared/domain/errors';

export type InvalidWagerTransactionReason =
  | 'OPENING_NOT_ALLOWED'
  | 'REFERENCE_REQUIRED'
  | 'REFERENCE_NOT_ALLOWED'
  | 'AMOUNT_MUST_BE_POSITIVE'
  | 'NEGATIVE_AMOUNT';

export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';

  constructor(
    readonly reason: InvalidWagerTransactionReason,
    message: string,
  ) {
    super(message);
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}
