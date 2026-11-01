import type { Money } from '../../../shared/domain/money';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface WagerTransactionState {
  readonly id: string;
  readonly providerId: string | undefined;
  readonly externalTransactionId: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly payloadHash: string | undefined;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | undefined;
  readonly gameId: string | undefined;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId: string | undefined;
  readonly failureCode: string | undefined;
  readonly processedAt: Date | undefined;
  readonly resultBalance: Money | undefined;
}

export interface OpeningProps {
  readonly id: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly at: Date;
}

export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string | undefined,
    readonly externalTransactionId: string | undefined,
    readonly idempotencyKey: string | undefined,
    readonly payloadHash: string | undefined,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string | undefined,
    readonly gameId: string | undefined,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | undefined,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: string | undefined,
    private _processedAt: Date | undefined,
    private _resultBalance: Money | undefined,
  ) {}

  static opening(props: OpeningProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      undefined,
      undefined,
      undefined,
      undefined,
      props.walletId,
      props.playerId,
      undefined,
      undefined,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.at,
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      props.at,
      props.money,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): string | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: this._processedAt,
      resultBalance: this._resultBalance,
    };
  }
}
