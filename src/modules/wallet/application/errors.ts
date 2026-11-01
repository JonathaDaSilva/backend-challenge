import { ApplicationError } from '../../../shared/application/errors';

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(
    readonly playerId: string,
    readonly currency: string,
    readonly existingWalletId?: string,
  ) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class UnsupportedCurrencyError extends ApplicationError {
  readonly code = 'UNSUPPORTED_CURRENCY';

  constructor(
    readonly currency: string,
    readonly supported: readonly string[],
  ) {
    super(`Currency ${currency} is not supported (supported: ${supported.join(', ')})`);
  }
}
