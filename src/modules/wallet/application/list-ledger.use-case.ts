import { WalletNotFoundError } from './errors';
import type { LedgerPageEntry, LedgerQuery, WalletRepository } from './ports';

export interface LedgerPage {
  readonly walletId: string;
  readonly entries: readonly LedgerPageEntry[];
  readonly nextBeforeSeq: string | undefined;
}

export class ListLedgerUseCase {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerQuery,
  ) {}

  async execute(walletId: string, beforeSeq: string | undefined, limit: number): Promise<LedgerPage> {
    if (!(await this.wallets.findById(walletId))) throw new WalletNotFoundError(walletId);

    const rows = await this.ledger.page(walletId, beforeSeq, limit + 1);
    const entries = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return { walletId, entries, nextBeforeSeq: hasMore ? entries.at(-1)?.seq : undefined };
  }
}
