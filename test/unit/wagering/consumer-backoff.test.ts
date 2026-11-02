import { describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { ProcessWagerMessageUseCase } from '../../../src/modules/wagering/application/process-wager-message.use-case';
import type { RecordFailedTransactionUseCase } from '../../../src/modules/wagering/application/record-failed-transaction.use-case';
import { WagerTransactionsConsumer } from '../../../src/modules/wagering/infrastructure/messaging/wager-transactions.consumer';
import type { Metrics } from '../../../src/shared/application/observability';
import { loadConfig } from '../../../src/shared/infrastructure/config';

const { sqs } = loadConfig();
const consumer = new WagerTransactionsConsumer(
  {} as SQSClient,
  {} as ProcessWagerMessageUseCase,
  {} as RecordFailedTransactionUseCase,
  { ...sqs, queueName: 'q.fifo', dlqName: 'dlq.fifo' },
  {} as Metrics,
);

describe('consumer backoff', () => {
  test('doubles from 2s and caps at 60s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((count) => consumer.backoffSeconds(count))).toEqual([2, 4, 8, 16, 32, 60, 60]);
  });

  test('the default 7 attempts span about two minutes, the target failover window', () => {
    const waits = Array.from({ length: sqs.maxAttempts - 1 }, (_, index) => consumer.backoffSeconds(index + 1));
    expect(sqs.maxAttempts).toBe(7);
    expect(waits.reduce((sum, seconds) => sum + seconds)).toBe(122);
  });

  test('never asks SQS for less than one second', () => {
    const fast = new WagerTransactionsConsumer(
      {} as SQSClient,
      {} as ProcessWagerMessageUseCase,
      {} as RecordFailedTransactionUseCase,
      { ...sqs, queueName: 'q.fifo', dlqName: 'dlq.fifo', backoffBaseMs: 100 },
      {} as Metrics,
    );
    expect(fast.backoffSeconds(1)).toBe(1);
  });
});
