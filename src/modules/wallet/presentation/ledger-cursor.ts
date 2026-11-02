import { InvalidPayloadError } from '../../../shared/application/errors';

const VERSION = 1;
const SEQ = /^[1-9]\d{0,18}$/;

export function encodeLedgerCursor(beforeSeq: string): string {
  return Buffer.from(JSON.stringify({ v: VERSION, before: beforeSeq })).toString('base64url');
}

export function decodeLedgerCursor(cursor: string): string {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; before?: unknown };
    if (decoded.v === VERSION && typeof decoded.before === 'string' && SEQ.test(decoded.before)) return decoded.before;
  } catch {
    // tratado abaixo como cursor inválido
  }
  throw new InvalidPayloadError([{ path: 'cursor', message: 'Invalid cursor' }]);
}
