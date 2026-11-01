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

export class InvalidPayloadError extends ApplicationError {
  readonly code = 'INVALID_PAYLOAD';

  constructor(readonly issues: readonly PayloadIssue[]) {
    super('Invalid payload');
  }
}
