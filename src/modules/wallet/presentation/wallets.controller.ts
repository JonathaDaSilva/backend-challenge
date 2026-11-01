import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { type MoneyProps, Money } from '../../../shared/domain/money';
import { parseWith } from '../../../shared/presentation/validation';
import { GetWalletUseCase } from '../application/get-wallet.use-case';
import { OpenWalletUseCase } from '../application/open-wallet.use-case';
import type { Wallet } from '../domain/wallet';

const CreateWalletSchema = z.object({
  playerId: z.uuid(),
  initialBalance: z.object({ amount: z.unknown(), currency: z.unknown() }),
});

const WalletParamsSchema = z.object({ walletId: z.uuid() });

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

function toResponse(wallet: Wallet): WalletResponse {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(OpenWalletUseCase) private readonly openWallet: OpenWalletUseCase,
    @Inject(GetWalletUseCase) private readonly getWallet: GetWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown): Promise<WalletResponse> {
    const input = parseWith(CreateWalletSchema, body);
    const wallet = await this.openWallet.execute({
      playerId: input.playerId,
      initialBalance: Money.fromInput(input.initialBalance),
    });
    return toResponse(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string): Promise<WalletResponse> {
    const params = parseWith(WalletParamsSchema, { walletId });
    return toResponse(await this.getWallet.execute(params.walletId));
  }
}
