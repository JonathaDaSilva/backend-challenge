import { failureDefinition, isCatalogCode } from '../../../shared/application/failure-catalog';
import type { MoneyProps } from '../../../shared/domain/money';
import { type WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';

export interface SubmitResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps | undefined;
  idempotentReplay: boolean;
  failureCode?: string;
  retryable?: boolean;
}

export function toSubmitResponse(transaction: WagerTransaction, idempotentReplay: boolean): SubmitResponse {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.resultBalance?.toJSON(),
    idempotentReplay,
    ...failureFields(transaction.failureCode),
  };
}

function failureFields(code: string | undefined): Pick<SubmitResponse, 'failureCode' | 'retryable'> {
  if (!code) return {};
  return { failureCode: code, retryable: isCatalogCode(code) ? failureDefinition(code).retryable : false };
}

const HTTP_STATUS_BY_RESULT: Partial<Record<WagerTransactionStatus, number>> = {
  [WagerTransactionStatus.Processed]: 201,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Rejected]: 422,
};

export function httpStatusFor(transaction: WagerTransaction): number {
  return HTTP_STATUS_BY_RESULT[transaction.status] ?? 500;
}

export function toTransactionView(transaction: WagerTransaction) {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
    balance: transaction.resultBalance?.toJSON(),
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString(),
  };
}
