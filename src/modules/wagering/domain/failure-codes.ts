export const FailureCode = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds: 'REVERSAL_INSUFFICIENT_FUNDS',
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  ReferenceAmountMismatch: 'REFERENCE_AMOUNT_MISMATCH',
  InvalidReferenceKind: 'INVALID_REFERENCE_KIND',
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  AlreadyReversed: 'ALREADY_REVERSED',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];
