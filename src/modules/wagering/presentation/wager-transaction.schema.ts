import { z } from 'zod';
import { Money } from '../../../shared/domain/money';
import type { SubmitWagerTransactionCommand } from '../application/submit-wager-transaction.use-case';
import type { WagerTransactionKind } from '../domain/wager-transaction';

export const identifier = z.string().min(1).max(255);

export const WagerTransactionPayloadSchema = z.object({
  providerId: identifier,
  externalTransactionId: identifier,
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: identifier,
  gameId: identifier,
  kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money: z.object({ amount: z.unknown(), currency: z.unknown() }),
  referenceExternalTransactionId: identifier.optional(),
});

export const WagerTransactionRequestedSchema = z.object({
  messageId: identifier,
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: WagerTransactionPayloadSchema.extend({ idempotencyKey: identifier }),
});

export type WagerTransactionPayload = z.infer<typeof WagerTransactionPayloadSchema>;

export function toSubmitCommand(payload: WagerTransactionPayload, idempotencyKey: string): SubmitWagerTransactionCommand {
  return {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    idempotencyKey,
    kind: payload.kind as WagerTransactionKind,
    money: Money.fromInput(payload.money),
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
}
