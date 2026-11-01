import { afterEach, describe, expect, test } from 'bun:test';
import { loadConfig } from '../../src/shared/infrastructure/config';

const originalPort = process.env.PORT;

afterEach(() => {
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
});

describe('loadConfig', () => {
  test('falls back to docker-compose defaults', () => {
    delete process.env.PORT;
    expect(loadConfig().port).toBe(3000);
  });

  test('rejects an invalid port', () => {
    process.env.PORT = 'abc';
    expect(() => loadConfig()).toThrow('Invalid port in PORT');
  });
});
