import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/modules/wagering/domain/failure-codes';
import { FAILURE_CATALOG, type FailureCategory, isCatalogCode } from '../../src/shared/application/failure-catalog';
import { ERROR_MAPPINGS, INTERNAL_ERROR_TYPES } from '../../src/shared/infrastructure/error-classification';
import { renderFailureTable, TABLE_END, TABLE_START } from '../../scripts/failure-catalog-table';

const EXPECTED_STATUS: Record<FailureCategory, (status: number) => boolean> = {
  VALIDATION: (status) => status >= 400 && status < 500 && status !== 404 && status !== 409 && status !== 422,
  AUTHENTICATION: (status) => status === 401,
  AUTHORIZATION: (status) => status === 403,
  NOT_FOUND: (status) => status === 404,
  CONFLICT: (status) => status === 409,
  BUSINESS_REJECTION: (status) => status === 422,
  TRANSIENT: (status) => status === 503,
  INTERNAL: (status) => status === 500,
  PERMANENT: (status) => status === 500,
};

const RETRYABLE_CATEGORIES = new Set<FailureCategory>(['TRANSIENT', 'INTERNAL']);

async function declaredErrorClasses(): Promise<string[]> {
  const names: string[] = [];
  for await (const path of new Bun.Glob('src/**/*.ts').scan('.')) {
    const source = await Bun.file(path).text();
    for (const match of source.matchAll(/export class (\w+) extends (?:ApplicationError|DomainError)\b/g)) {
      if (match[1]) names.push(match[1]);
    }
  }
  return names.sort();
}

describe('failure catalog', () => {
  test.each(Object.entries(FAILURE_CATALOG))('%s has a status consistent with its category', (_, definition) => {
    expect(EXPECTED_STATUS[definition.category](definition.status)).toBe(true);
    expect(definition.retryable).toBe(RETRYABLE_CATEGORIES.has(definition.category));
    expect(definition.description.length).toBeGreaterThan(10);
  });

  test('every transaction failure code is in the catalog as a business rejection', () => {
    for (const code of Object.values(FailureCode)) {
      expect(isCatalogCode(code)).toBe(true);
      expect(FAILURE_CATALOG[code].category).toBe('BUSINESS_REJECTION');
    }
  });

  test('every application and domain error is either mapped or explicitly internal', async () => {
    const handled = [...ERROR_MAPPINGS.map((mapping) => mapping.type), ...INTERNAL_ERROR_TYPES].map((type) => type.name);
    const unhandled = (await declaredErrorClasses()).filter((name) => !handled.includes(name));
    expect(unhandled).toEqual([]);
  });

  test('no error class is both mapped and internal', () => {
    const mapped = new Set(ERROR_MAPPINGS.map((mapping) => mapping.type));
    expect(INTERNAL_ERROR_TYPES.filter((type) => mapped.has(type))).toEqual([]);
  });
});

describe('ARCHITECTURE.md', () => {
  test('the failure table matches the catalog (run `bun run docs:failures` to refresh)', async () => {
    const document = await Bun.file('ARCHITECTURE.md').text();
    const start = document.indexOf(TABLE_START);
    const end = document.indexOf(TABLE_END) + TABLE_END.length;
    expect(start).toBeGreaterThan(-1);
    expect(document.slice(start, end)).toBe(renderFailureTable());
  });
});
