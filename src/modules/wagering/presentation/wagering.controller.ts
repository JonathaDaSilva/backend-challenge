import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import { z } from 'zod';
import { parseWith } from '../../../shared/presentation/validation';
import { GetWagerTransactionUseCase } from '../application/get-wager-transaction.use-case';
import { SubmitWagerTransactionUseCase } from '../application/submit-wager-transaction.use-case';
import { httpStatusFor, type SubmitResponse, toSubmitResponse, toTransactionView } from './wager-transaction.view';
import { identifier, toSubmitCommand, WagerTransactionPayloadSchema } from './wager-transaction.schema';

const SubmitWagerTransactionSchema = z.object({
  idempotencyKey: identifier,
  body: WagerTransactionPayloadSchema,
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
    const { transaction, idempotentReplay } = await this.submitTransaction.execute(
      toSubmitCommand(input.body, input.idempotencyKey),
    );
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
