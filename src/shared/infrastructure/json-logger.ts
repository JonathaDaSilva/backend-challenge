import type { LoggerService } from '@nestjs/common';
import type { LogFields, StructuredLogger } from '../application/observability';
import { currentContext } from './async-correlation-context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSink = (line: string) => void;

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Rede de segurança da política de dados: valores e saldos de rotina nunca saem no log.
// A divergência de reconciliação usa storedBalance/calculatedBalance/difference de propósito.
const REDACTED_KEYS = new Set(['money', 'amount', 'balance', 'balanceBefore', 'balanceAfter', 'initialBalance', 'body', 'payload']);
const REDACTED = '[redacted]';

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, REDACTED_KEYS.has(key) ? REDACTED : redact(entry, depth + 1)]),
  );
}

const stdout: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export class JsonLogger implements LoggerService, StructuredLogger {
  constructor(
    private readonly minimum: LogLevel = 'info',
    private readonly sink: LogSink = stdout,
  ) {}

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, ...this.nestArguments(rest));
  }

  error(message: unknown, ...rest: unknown[]): void {
    const [fields, context] = this.nestArguments(rest);
    const stack = rest.length >= 2 && typeof rest[0] === 'string' ? rest[0] : undefined;
    this.write('error', message, { ...fields, ...(stack ? { stack } : {}) }, context);
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, ...this.nestArguments(rest));
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, ...this.nestArguments(rest));
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, ...this.nestArguments(rest));
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, ...this.nestArguments(rest));
  }

  private nestArguments(rest: unknown[]): [LogFields | undefined, string | undefined] {
    const fields = rest.find((item): item is LogFields => typeof item === 'object' && item !== null);
    const last = rest.at(-1);
    return [fields, typeof last === 'string' ? last : undefined];
  }

  private write(level: LogLevel, message: unknown, fields?: LogFields, context?: string): void {
    if (SEVERITY[level] < SEVERITY[this.minimum]) return;
    const text = typeof message === 'string' ? message : message instanceof Error ? message.message : undefined;
    const extra = text === undefined && typeof message === 'object' && message !== null ? message : {};
    const entry = {
      time: new Date().toISOString(),
      level,
      ...(context ? { logger: context } : {}),
      msg: text ?? '',
      ...currentContext(),
      ...(redact({ ...extra, ...fields }) as Record<string, unknown>),
    };
    this.sink(JSON.stringify(entry));
  }
}
