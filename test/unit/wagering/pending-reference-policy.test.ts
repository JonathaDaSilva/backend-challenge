import { describe, expect, test } from 'bun:test';
import { PendingReferencePolicy } from '../../../src/modules/wagering/application/pending-reference-policy';

const options = { maxAttempts: 8, baseDelayMs: 1000, maxDelayMs: 60_000 };

describe('PendingReferencePolicy', () => {
  test('doubles the delay per attempt up to the cap', () => {
    const policy = new PendingReferencePolicy(options, () => 1);
    expect(Array.from({ length: 8 }, (_, attempt) => policy.delayMs(attempt))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000,
    ]);
  });

  test('jitter keeps each delay between half and the full ceiling', () => {
    expect(new PendingReferencePolicy(options, () => 0).delayMs(3)).toBe(4000);
    expect(new PendingReferencePolicy(options, () => 0.5).delayMs(3)).toBe(6000);
  });

  test('the full schedule fits in about three minutes', () => {
    const policy = new PendingReferencePolicy(options, () => 1);
    const total = Array.from({ length: options.maxAttempts }, (_, attempt) => policy.delayMs(attempt)).reduce(
      (sum, delay) => sum + delay,
    );
    expect(total).toBe(183_000);
  });

  test('is exhausted after the configured number of attempts', () => {
    const policy = new PendingReferencePolicy(options);
    expect(policy.isExhausted(7)).toBe(false);
    expect(policy.isExhausted(8)).toBe(true);
  });

  test('nextAttemptAt adds the delay to now', () => {
    const now = new Date('2026-11-01T12:00:00.000Z');
    expect(new PendingReferencePolicy(options, () => 1).nextAttemptAt(now, 2)).toEqual(
      new Date('2026-11-01T12:00:04.000Z'),
    );
  });
});
