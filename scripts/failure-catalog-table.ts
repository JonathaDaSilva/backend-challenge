import { FAILURE_CATALOG } from '../src/shared/application/failure-catalog';

export const TABLE_START = '<!-- failure-catalog:start -->';
export const TABLE_END = '<!-- failure-catalog:end -->';
const DOCUMENT = 'ARCHITECTURE.md';

export function renderFailureTable(): string {
  const rows = Object.entries(FAILURE_CATALOG).map(
    ([code, definition]) =>
      `| \`${code}\` | ${definition.category} | ${definition.status} | ${definition.retryable ? 'sim' : 'não'} | ${definition.description} |`,
  );
  return [
    TABLE_START,
    '| `failureCode` | Categoria | HTTP | `retryable` | Significado |',
    '|---|---|---|---|---|',
    ...rows,
    TABLE_END,
  ].join('\n');
}

export function replaceFailureTable(document: string): string {
  const start = document.indexOf(TABLE_START);
  const end = document.indexOf(TABLE_END);
  if (start === -1 || end === -1) throw new Error(`${DOCUMENT} has no failure catalog markers`);
  return document.slice(0, start) + renderFailureTable() + document.slice(end + TABLE_END.length);
}

if (import.meta.main) {
  const document = await Bun.file(DOCUMENT).text();
  await Bun.write(DOCUMENT, replaceFailureTable(document));
  console.log(`${DOCUMENT}: failure catalog table updated`);
}
