import { describe, expect, test } from 'bun:test';
import { MetricNames } from '../../src/shared/application/observability';
import { annotateContext, runWithContext } from '../../src/shared/infrastructure/async-correlation-context';
import { JsonLogger } from '../../src/shared/infrastructure/json-logger';
import { PromMetrics } from '../../src/shared/infrastructure/prom-metrics';

function capture(level: 'debug' | 'info' | 'warn' | 'error' = 'debug') {
  const lines: Record<string, unknown>[] = [];
  const logger = new JsonLogger(level, (line) => lines.push(JSON.parse(line) as Record<string, unknown>));
  return { logger, lines };
}

describe('JsonLogger', () => {
  test('writes one JSON object per line with time, level and message', () => {
    const { logger, lines } = capture();
    logger.info('hello', { walletId: 'w-1', status: 'PROCESSED' });
    expect(lines).toEqual([
      { time: expect.any(String), level: 'info', msg: 'hello', walletId: 'w-1', status: 'PROCESSED' },
    ]);
  });

  test('drops entries below the configured level', () => {
    const { logger, lines } = capture('warn');
    logger.info('quiet');
    logger.debug('quieter');
    logger.warn('loud');
    expect(lines.map((line) => line.msg)).toEqual(['loud']);
  });

  test('redacts amounts, balances, bodies and payloads at any depth', () => {
    const { logger, lines } = capture();
    logger.info('payment', {
      money: { amount: '25.00', currency: 'BRL' },
      nested: { balanceAfter: { amount: '75.00' }, list: [{ amount: '1.00' }], body: { secret: true } },
      payload: 'raw',
      kind: 'BET',
    });
    expect(lines[0]).toMatchObject({
      money: '[redacted]',
      nested: { balanceAfter: '[redacted]', list: [{ amount: '[redacted]' }], body: '[redacted]' },
      payload: '[redacted]',
      kind: 'BET',
    });
    expect(JSON.stringify(lines)).not.toContain('25.00');
  });

  test('keeps the reconciliation fields, the documented exception', () => {
    const { logger, lines } = capture();
    logger.warn('divergence', { storedBalance: '85.00', calculatedBalance: '80.00', difference: '5.00' });
    expect(lines[0]).toMatchObject({ storedBalance: '85.00', calculatedBalance: '80.00', difference: '5.00' });
  });

  test('every line carries the execution context, including later annotations', () => {
    const { logger, lines } = capture();
    runWithContext({ correlationId: 'corr-1', source: 'http' }, () => {
      annotateContext({ walletId: 'w-1', providerId: undefined });
      logger.info('first');
      runWithContext({ messageId: 'm-1' }, () => logger.info('nested'));
      annotateContext({ transactionId: 't-1' });
      logger.info('last');
    });
    logger.info('outside');

    expect(lines.map(({ msg, correlationId, walletId, messageId, transactionId }) => ({ msg, correlationId, walletId, messageId, transactionId }))).toEqual([
      { msg: 'first', correlationId: 'corr-1', walletId: 'w-1', messageId: undefined, transactionId: undefined },
      { msg: 'nested', correlationId: 'corr-1', walletId: 'w-1', messageId: 'm-1', transactionId: undefined },
      { msg: 'last', correlationId: 'corr-1', walletId: 'w-1', messageId: undefined, transactionId: 't-1' },
      { msg: 'outside', correlationId: undefined, walletId: undefined, messageId: undefined, transactionId: undefined },
    ]);
    expect('providerId' in (lines[0] ?? {})).toBe(false);
  });

  test('understands the Nest LoggerService calling conventions', () => {
    const { logger, lines } = capture();
    logger.log('started', 'NestFactory');
    logger.error('boom', 'Error: boom\n    at x', 'ExceptionsHandler');
    logger.warn('careful', 'Scheduler');
    expect(lines).toMatchObject([
      { level: 'info', msg: 'started', logger: 'NestFactory' },
      { level: 'error', msg: 'boom', logger: 'ExceptionsHandler', stack: 'Error: boom\n    at x' },
      { level: 'warn', msg: 'careful', logger: 'Scheduler' },
    ]);
  });
});

describe('PromMetrics', () => {
  test('counts by label set and exposes the Prometheus text format', async () => {
    const metrics = new PromMetrics();
    metrics.increment(MetricNames.WagerTransactions, { kind: 'BET', status: 'PROCESSED', source: 'http' });
    metrics.increment(MetricNames.WagerTransactions, { kind: 'BET', status: 'PROCESSED', source: 'http' });
    metrics.increment(MetricNames.WagerTransactions, { kind: 'BET', status: 'REJECTED', source: 'sqs' });

    expect(await metrics.value(MetricNames.WagerTransactions, { status: 'PROCESSED' })).toBe(2);
    expect(await metrics.value(MetricNames.WagerTransactions)).toBe(3);
    expect(await metrics.metrics()).toContain('wager_transactions_total{kind="BET",status="REJECTED",source="sqs"} 1');
  });

  test('histograms count observations', async () => {
    const metrics = new PromMetrics();
    metrics.observe(MetricNames.HttpRequestDuration, { method: 'GET', route: '/x', status: '200' }, 0.02);
    metrics.observe(MetricNames.HttpRequestDuration, { method: 'GET', route: '/x', status: '200' }, 0.3);
    expect(await metrics.value(MetricNames.HttpRequestDuration, { route: '/x' })).toBe(2);
  });

  test('a counter cannot be observed and a histogram cannot be incremented', () => {
    const metrics = new PromMetrics();
    expect(() => metrics.observe(MetricNames.WagerTransactions, {}, 1)).toThrow();
    expect(() => metrics.increment(MetricNames.HttpRequestDuration)).toThrow();
  });

  test('each instance has its own registry', async () => {
    const first = new PromMetrics();
    const second = new PromMetrics();
    first.increment(MetricNames.OutboxPublished, {}, 5);
    expect(await second.value(MetricNames.OutboxPublished)).toBe(0);
  });
});
