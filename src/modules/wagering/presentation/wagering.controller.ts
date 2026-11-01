import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import { z } from 'zod';
import { Money } from '../../../shared/domain/money';
import { parseWith } from '../../../shared/presentation/validation';
import { GetWagerTransactionUseCase } from '../application/get-wager-transaction.use-case';
import { SubmitWagerTransactionUseCase } from '../application/submit-wager-transaction.use-case';
import type { WagerTransactionKind } from '../domain/wager-transaction';
import { httpStatusFor, type SubmitResponse, toSubmitResponse, toTransactionView } from './wager-transaction.view';

const identifier = z.string().min(1).max(255);

const SubmitWagerTransactionSchema = z.object({
  idempotencyKey: identifier,
  body: z.object({
    providerId: identifier,
    externalTransactionId: identifier,
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: identifier,
    gameId: identifier,
    kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
    money: z.object({ amount: z.unknown(), currency: z.unknown() }),
    referenceExternalTransactionId: identifier.optional(),
  }),
});

const TransactionParamsSchema = z.object({ transactionId: z.uuid() });
const ExternalParamsSchema = z.object({ providerId: identifier, externalTransactionId: identifier });

interface StatusSetter {
  status(code: number): unknown;
}

@Controller()
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransactionUseCase) private readonly submitTransaction: SubmitWagerTransactionUseCase,
    @Inject(GetWagerTransactionUseCase) private readonly getTransaction: GetWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusSetter,
  ): Promise<SubmitResponse> {
    const input = parseWith(SubmitWagerTransactionSchema, { idempotencyKey, body });
    const { transaction, idempotentReplay } = await this.submitTransaction.execute({
      ...input.body,
      idempotencyKey: input.idempotencyKey,
      kind: input.body.kind as WagerTransactionKind,
      money: Money.fromInput(input.body.money),
      referenceExternalTransactionId: input.body.referenceExternalTransactionId,
    });
    response.status(httpStatusFor(transaction));
    return toSubmitResponse(transaction, idempotentReplay);
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string) {
    const params = parseWith(TransactionParamsSchema, { transactionId });
    return toTransactionView(await this.getTransaction.byId(params.transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const params = parseWith(ExternalParamsSchema, { providerId, externalTransactionId });
    return toTransactionView(await this.getTransaction.byExternalId(params.providerId, params.externalTransactionId));
  }
}
