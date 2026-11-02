export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface PayloadIssue {
  readonly path: string;
  readonly message: string;
}

export class ConcurrentModificationError extends ApplicationError {
  readonly code = 'CONCURRENT_MODIFICATION';
}

export class DuplicateMessageError extends ApplicationError {
  readonly code = 'DUPLICATE_MESSAGE';
}

export class UnauthenticatedError extends ApplicationError {
  readonly code = 'UNAUTHENTICATED';
}

export class ProviderMismatchError extends ApplicationError {
  readonly code = 'PROVIDER_MISMATCH';

  constructor(
    readonly authorizedProviderId: string,
    readonly requestedProviderId: string,
  ) {
    super(`Credentials for ${authorizedProviderId} cannot submit transactions for ${requestedProviderId}`);
  }
}

export class InvalidPayloadError extends ApplicationError {
  readonly code = 'INVALID_PAYLOAD';

  constructor(readonly issues: readonly PayloadIssue[]) {
    super('Invalid payload');
  }
}
