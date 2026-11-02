import type { FailureCode } from '../../modules/wagering/domain/failure-codes';

export type FailureCategory =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BUSINESS_REJECTION'
  | 'TRANSIENT'
  | 'INTERNAL'
  | 'PERMANENT';

export interface FailureDefinition {
  readonly category: FailureCategory;
  readonly status: number;
  readonly retryable: boolean;
  readonly description: string;
}

const define = (category: FailureCategory, status: number, retryable: boolean, description: string) =>
  ({ category, status, retryable, description }) as const;

const rejection = (description: string) => define('BUSINESS_REJECTION', 422, false, description);

export const FAILURE_CATALOG = {
  INVALID_PAYLOAD: define('VALIDATION', 400, false, 'Payload, header ou parâmetro da URL malformado; corrija antes de reenviar'),
  PAYLOAD_TOO_LARGE: define('VALIDATION', 413, false, 'Corpo da requisição maior que o limite aceito'),
  UNSUPPORTED_MEDIA_TYPE: define('VALIDATION', 415, false, 'O corpo precisa ser application/json'),

  NOT_FOUND: define('NOT_FOUND', 404, false, 'A rota não existe'),
  WALLET_NOT_FOUND: define('NOT_FOUND', 404, false, 'A wallet da URL não existe'),
  TRANSACTION_NOT_FOUND: define('NOT_FOUND', 404, false, 'A transação da URL não existe'),

  WALLET_ALREADY_EXISTS: define('CONFLICT', 409, false, 'O player já tem wallet nessa moeda; o corpo traz o walletId dela'),
  IDEMPOTENCY_CONFLICT: define('CONFLICT', 409, false, 'Idempotency-Key já usada com outro payload'),
  DUPLICATE_EXTERNAL_TRANSACTION: define('CONFLICT', 409, false, 'Transação do provedor já enviada com outra Idempotency-Key'),

  UNSUPPORTED_CURRENCY: rejection('Moeda não habilitada para novas wallets'),
  UNKNOWN_WALLET: rejection('O walletId do corpo não existe'),
  WALLET_PLAYER_MISMATCH: rejection('A wallet não pertence ao playerId do corpo'),
  CURRENCY_MISMATCH: rejection('Moeda da transação diferente da moeda da wallet'),
  INSUFFICIENT_FUNDS: rejection('Saldo menor que o valor do BET'),
  REVERSAL_INSUFFICIENT_FUNDS: rejection('A reversão deixaria o saldo negativo'),
  REFERENCE_NOT_FOUND: rejection('A transação referenciada não chegou dentro da janela de tentativas'),
  REFERENCE_MISMATCH: rejection('A referência é de outro provider, player, wallet, moeda ou rodada'),
  REFERENCE_AMOUNT_MISMATCH: rejection('Valor da reversão diferente do valor da referência'),
  INVALID_REFERENCE_KIND: rejection('REFUND só reverte BET; ROLLBACK só reverte BET, WIN ou REFUND'),
  REFERENCE_NOT_PROCESSED: rejection('A referência foi rejeitada ou falhou; não há o que reverter'),
  ALREADY_REVERSED: rejection('A referência já foi revertida'),

  TRANSIENT_FAILURE: define('TRANSIENT', 503, true, 'Falha temporária de infraestrutura; reenvie com a mesma Idempotency-Key'),
  SERVICE_UNAVAILABLE: define('TRANSIENT', 503, true, 'Uma dependência está inacessível'),

  INTERNAL_ERROR: define('INTERNAL', 500, true, 'Erro inesperado; nada foi gravado e reenviar a mesma key é seguro'),
  PERMANENT_FAILURE: define('PERMANENT', 500, false, 'Falha permanente de infraestrutura, gravada como FAILED (consumer SQS)'),
} as const satisfies Record<string, FailureDefinition>;

export type CatalogCode = keyof typeof FAILURE_CATALOG;

export const TRANSACTION_FAILURE_CODES: Record<FailureCode, FailureDefinition> = FAILURE_CATALOG;

export function failureDefinition(code: CatalogCode): FailureDefinition {
  return FAILURE_CATALOG[code];
}

export function isCatalogCode(code: string): code is CatalogCode {
  return Object.hasOwn(FAILURE_CATALOG, code);
}
