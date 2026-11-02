import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { type MoneyProps, Money } from '../../../shared/domain/money';
import { parseWith } from '../../../shared/presentation/validation';
import { GetWalletUseCase } from '../application/get-wallet.use-case';
import { ListLedgerUseCase } from '../application/list-ledger.use-case';
import { OpenWalletUseCase } from '../application/open-wallet.use-case';
import type { WalletReconciliation } from '../application/ports';
import { ReconcileWalletUseCase } from '../application/reconcile-wallet.use-case';
import type { Wallet } from '../domain/wallet';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';

const CreateWalletSchema = z.object({
  playerId: z.uuid(),
  initialBalance: z.object({ amount: z.unknown(), currency: z.unknown() }),
});

const WalletParamsSchema = z.object({ walletId: z.uuid() });

const LedgerQuerySchema = z.object({
  walletId: z.uuid(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

function toReconciliationResponse(reconciliation: WalletReconciliation) {
  return {
    reconciliationId: reconciliation.id,
    walletId: reconciliation.walletId,
    storedBalance: reconciliation.storedBalance.toJSON(),
    calculatedBalance: reconciliation.calculatedBalance.toJSON(),
    difference: reconciliation.difference.toJSON(),
    consistent: reconciliation.consistent,
    checkedEntries: reconciliation.checkedEntries,
    checkedAt: reconciliation.checkedAt.toISOString(),
  };
}

function toResponse(wallet: Wallet): WalletResponse {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(OpenWalletUseCase) private readonly openWallet: OpenWalletUseCase,
    @Inject(GetWalletUseCase) private readonly getWallet: GetWalletUseCase,
    @Inject(ListLedgerUseCase) private readonly listLedger: ListLedgerUseCase,
    @Inject(ReconcileWalletUseCase) private readonly reconcileWallet: ReconcileWalletUseCase,
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

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    const query = parseWith(LedgerQuerySchema, { walletId, cursor, limit });
    const beforeSeq = query.cursor === undefined ? undefined : decodeLedgerCursor(query.cursor);
    const page = await this.listLedger.execute(query.walletId, beforeSeq, query.limit);
    return {
      walletId: page.walletId,
      entries: page.entries.map(({ entry, kind }) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        kind,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.nextBeforeSeq === undefined ? null : encodeLedgerCursor(page.nextBeforeSeq),
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    const params = parseWith(WalletParamsSchema, { walletId });
    return toReconciliationResponse(await this.reconcileWallet.execute(params.walletId));
  }
}
