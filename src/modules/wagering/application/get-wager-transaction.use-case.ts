import type { WagerTransaction } from '../domain/wager-transaction';
import { TransactionNotFoundError } from './errors';
import type { WagerTransactionRepository } from './ports';

export class GetWagerTransactionUseCase {
  constructor(private readonly transactions: WagerTransactionRepository) {}

  async byId(id: string): Promise<WagerTransaction> {
    const transaction = await this.transactions.findById(id);
    if (!transaction) throw new TransactionNotFoundError(`Transaction ${id} not found`);
    return transaction;
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const transaction = await this.transactions.findByProviderAndExternalId(providerId, externalTransactionId);
    if (!transaction) {
      throw new TransactionNotFoundError(`Transaction ${externalTransactionId} from ${providerId} not found`);
    }
    return transaction;
  }
}
