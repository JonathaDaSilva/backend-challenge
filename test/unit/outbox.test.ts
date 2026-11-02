import { describe, expect, test } from 'bun:test';
import { WalletBalanceChanged } from '../../src/modules/wagering/application/events';
import { Wallet } from '../../src/modules/wallet/domain/wallet';
import type { EventPublisher, OutboxRepository } from '../../src/shared/application/outbox';
import { OutboxBackoff, OutboxPublisher } from '../../src/shared/application/outbox-publisher';
import type { TransactionRunner } from '../../src/shared/application/transaction-runner';
import { Money } from '../../src/shared/domain/money';
import { OutboxMessage } from '../../src/shared/domain/outbox-message';

const at = new Date('2026-11-02T10:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function balanceChanged(causationId?: string) {
  const { wallet, openingEntry } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('100.00'),
    openingTransactionId: 'tx-1',
    openingEntryId: 'entry-1',
    at,
  });
  if (!openingEntry) throw new Error('expected an opening entry');
  return WalletBalanceChanged.from(wallet, openingEntry, {
    eventId: 'event-1',
    correlationId: 'corr-1',
    ...(causationId ? { causationId } : {}),
    occurredAt: at,
  });
}

describe('IntegrationEvent envelope', () => {
  test('serializes type, version and MoneyProps as decimal strings', () => {
    expect(JSON.parse(JSON.stringify(balanceChanged('tx-1')))).toEqual({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'tx-1',
      occurredAt: '2026-11-02T10:00:00.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: 'CREDIT',
        money: { amount: '100.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '100.00', currency: 'BRL' },
        walletVersion: 1,
      },
    });
  });

  test('omits causationId when there is none and freezes the data', () => {
    const event = balanceChanged();
    expect('causationId' in event.toJSON()).toBe(false);
    expect(Object.isFrozen(event.data)).toBe(true);
  });
});

describe('OutboxMessage', () => {
  test('enqueue keeps the event identity and is due immediately', () => {
    const message = OutboxMessage.enqueue(balanceChanged());
    expect(message).toMatchObject({ id: 'event-1', aggregateId: 'wallet-1', eventType: 'WalletBalanceChanged', attempts: 0 });
    expect(message.payload).toMatchObject({ eventType: 'WalletBalanceChanged', version: 1 });
    expect(message.isDue(at)).toBe(true);
  });

  test('scheduleRetry bumps attempts and pushes the next attempt', () => {
    const message = OutboxMessage.enqueue(balanceChanged());
    message.scheduleRetry(at, { delayMs: (attempts) => attempts * 1000 });
    message.scheduleRetry(at, { delayMs: (attempts) => attempts * 1000 });
    expect(message.attempts).toBe(2);
    expect(message.isDue(at)).toBe(false);
    expect(message.isDue(new Date(at.getTime() + 2000))).toBe(true);
  });

  test('a published message is no longer due and keeps its first publication time', () => {
    const message = OutboxMessage.enqueue(balanceChanged());
    message.markPublished(at);
    message.markPublished(new Date(at.getTime() + 1));
    expect(message.publishedAt).toEqual(at);
    expect(message.isDue(at)).toBe(false);
  });
});

describe('OutboxBackoff', () => {
  test('doubles from 1s up to 5 minutes', () => {
    const backoff = new OutboxBackoff({ baseDelayMs: 1000, maxDelayMs: 300_000 }, () => 1);
    expect([1, 2, 3, 9, 10, 20].map((attempts) => backoff.delayMs(attempts))).toEqual([
      1000, 2000, 4000, 256_000, 300_000, 300_000,
    ]);
  });
});

describe('OutboxPublisher', () => {
  const runner: TransactionRunner = { run: (work) => work() };
  const backoff = new OutboxBackoff({ baseDelayMs: 1000, maxDelayMs: 300_000 }, () => 1);

  function setup(publisher: EventPublisher) {
    const messages = ['a', 'b', 'c'].map((id) =>
      OutboxMessage.rehydrate({
        id,
        aggregateId: 'agg',
        eventType: 'T',
        payload: {},
        occurredAt: at,
        attempts: 0,
        nextAttemptAt: at,
        publishedAt: undefined,
      }),
    );
    let claimed = false;
    const saved: OutboxMessage[] = [];
    const outbox: OutboxRepository = {
      add: async () => undefined,
      claimDue: async () => {
        if (claimed) return [];
        claimed = true;
        return messages;
      },
      save: async (batch) => {
        saved.push(...batch);
      },
      nextDueAt: async () => undefined,
    };
    return { saved, publisher: new OutboxPublisher({ outbox, publisher, runner, backoff, batchSize: 10 }) };
  }

  test('marks published what the destination accepted and reschedules the rest', async () => {
    const { saved, publisher } = setup({ publish: async () => ({ failed: new Set(['b']) }) });
    await publisher.processDue(at);

    expect(saved.map((message) => [message.id, message.publishedAt !== undefined, message.attempts])).toEqual([
      ['a', true, 0],
      ['b', false, 1],
      ['c', true, 0],
    ]);
  });

  test('a destination that throws reschedules the whole batch without losing it', async () => {
    const { saved, publisher } = setup({
      publish: () => Promise.reject(new Error('destination unavailable')),
    });
    await publisher.processDue(at);

    expect(saved.every((message) => message.publishedAt === undefined && message.attempts === 1)).toBe(true);
    expect(saved.every((message) => message.nextAttemptAt?.getTime() === at.getTime() + 1000)).toBe(true);
  });
});
