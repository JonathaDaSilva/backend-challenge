import type { Money } from '../../../shared/domain/money';
import { LedgerDirection } from '../../wallet/domain/wallet-ledger-entry';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from './errors';
import { FailureCode } from './failure-codes';

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

const TERMINAL_STATUSES = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

const REVERSAL_KINDS = new Set([WagerTransactionKind.Refund, WagerTransactionKind.Rollback]);

const REVERSIBLE_KINDS: Partial<Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>> = {
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
};

export type ReversalCheck = 'OK' | 'WAIT' | Exclude<FailureCode, 'INSUFFICIENT_FUNDS'>;

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

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly at: Date;
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

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING_NOT_ALLOWED', 'OPENING is internal and cannot be submitted');
    }
    const isReversal = REVERSAL_KINDS.has(props.kind);
    if (isReversal && props.referenceExternalTransactionId === undefined) {
      throw new InvalidWagerTransactionError('REFERENCE_REQUIRED', `${props.kind} requires a reference`);
    }
    if (!isReversal && props.referenceExternalTransactionId !== undefined) {
      throw new InvalidWagerTransactionError('REFERENCE_NOT_ALLOWED', `${props.kind} cannot carry a reference`);
    }
    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError('NEGATIVE_AMOUNT', 'Amount must not be negative');
    }
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError('AMOUNT_MUST_BE_POSITIVE', `${props.kind} amount must be positive`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.at,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  }

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

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultBalance: Money): void {
    this.assertNotTerminal('process');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
  }

  markPendingReference(observedBalance: Money): void {
    if (this._status !== WagerTransactionStatus.Pending || !this.requiresReference()) {
      throw new InvalidTransactionStateError(`Cannot wait for a reference from ${this._status} (${this.kind})`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._resultBalance = observedBalance;
  }

  reject(code: string, resultBalance: Money | undefined): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultBalance = resultBalance;
  }

  fail(code: string): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REVERSAL_KINDS.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  checkReversalOf(reference: WagerTransaction): ReversalCheck {
    if (!this.requiresReference()) {
      throw new InvalidTransactionStateError(`${this.kind} does not reverse anything`);
    }
    if (reference.status === WagerTransactionStatus.PendingReference || reference.status === WagerTransactionStatus.Pending) {
      return 'WAIT';
    }
    const sameScope =
      reference.providerId === this.providerId &&
      reference.externalTransactionId === this.referenceExternalTransactionId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.money.currency === this.money.currency &&
      reference.roundId === this.roundId;
    if (!sameScope) return FailureCode.ReferenceMismatch;
    if (!REVERSIBLE_KINDS[this.kind]?.has(reference.kind)) return FailureCode.InvalidReferenceKind;
    if (!reference.money.equals(this.money)) return FailureCode.ReferenceAmountMismatch;
    if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;
    return 'OK';
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidTransactionStateError('ROLLBACK needs its reference to pick a direction');
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not move the balance');
    }
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

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot ${action} transaction ${this.id}: already ${this._status}`);
    }
  }
}
