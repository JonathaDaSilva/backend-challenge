import { DomainError } from '../../../shared/domain/errors';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(
    readonly walletId: string,
    readonly balance: string,
    readonly requested: string,
  ) {
    super(`Wallet ${walletId} has ${balance}, cannot debit ${requested}`);
  }
}

export class InvalidMovementError extends DomainError {
  readonly code = 'INVALID_MOVEMENT';
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}
