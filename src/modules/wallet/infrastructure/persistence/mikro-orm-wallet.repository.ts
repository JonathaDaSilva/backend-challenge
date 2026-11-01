import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrentModificationError } from '../../../../shared/application/errors';
import { isUniqueViolation } from '../../../../shared/infrastructure/database/constraint-violation';
import { WalletAlreadyExistsError } from '../../application/errors';
import type { LedgerRepository, WalletRepository } from '../../application/ports';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { LedgerEntryMapper, WalletMapper } from './wallet.mapper';
import { WalletLedgerEntryRecord } from './wallet-ledger-entry.record';
import { WalletRecord } from './wallet.record';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletRecord, WalletMapper.toRecord(wallet));
    } catch (error) {
      if (isUniqueViolation(error, 'wallets_player_currency_uq')) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id }, { disableIdentityMap: true });
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      { disableIdentityMap: true, lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const { balanceAmount, version, updatedAt } = WalletMapper.toRecord(wallet);
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balanceAmount, version, updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrentModificationError(`Wallet ${wallet.id} is no longer at version ${expectedVersion}`);
    }
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { playerId, currency }, { disableIdentityMap: true });
    return record ? WalletMapper.toDomain(record) : undefined;
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(WalletLedgerEntryRecord, LedgerEntryMapper.toRecord(entry));
  }
}
