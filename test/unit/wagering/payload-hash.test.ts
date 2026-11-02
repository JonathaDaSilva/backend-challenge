import { describe, expect, test } from 'bun:test';
import { canonicalJson, type WagerPayload, wagerPayloadHash } from '../../../src/modules/wagering/application/payload-hash';

const payload: WagerPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  test('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: [2, { f: true, e: null }] }, z: undefined })).toBe(
      '{"a":{"c":[2,{"e":null,"f":true}],"d":"x"},"b":1}',
    );
  });
});

describe('wagerPayloadHash', () => {
  test('is a sha256 hex digest', () => {
    expect(wagerPayloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('ignores key order', () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as unknown as WagerPayload;
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(payload));
  });

  test('ignores fields outside the business subset', () => {
    const withTransport = { ...payload, idempotencyKey: 'provider-a:transaction-123', messageId: 'msg-1' };
    expect(wagerPayloadHash(withTransport)).toBe(wagerPayloadHash(payload));
  });

  test.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['walletId', { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }],
    ['roundId', { roundId: 'round-988' }],
    ['gameId', { gameId: 'other-game' }],
    ['kind', { kind: 'WIN' }],
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['reference', { referenceExternalTransactionId: 'transaction-100' }],
  ])('changes when %s changes', (_, overrides) => {
    expect(wagerPayloadHash({ ...payload, ...overrides })).not.toBe(wagerPayloadHash(payload));
  });
});
