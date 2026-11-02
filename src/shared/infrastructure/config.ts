import type { LogLevel } from './json-logger';
function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function port(name: string, fallback: string): number {
  const raw = required(name, fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`Invalid port in ${name}: ${raw}`);
  }
  return value;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function logLevel(name: string, fallback: LogLevel): LogLevel {
  const raw = required(name, fallback) as LogLevel;
  if (!LOG_LEVELS.includes(raw)) throw new Error(`Invalid ${name}: ${raw}`);
  return raw;
}

function positiveInt(name: string, fallback: string): number {
  const raw = required(name, fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid positive integer in ${name}: ${raw}`);
  }
  return value;
}

function currencyList(name: string, fallback: string): readonly string[] {
  const codes = required(name, fallback)
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code !== '');
  const invalid = codes.filter((code) => !/^[A-Z]{3}$/.test(code));
  if (codes.length === 0 || invalid.length > 0) {
    throw new Error(`Invalid currency list in ${name}: ${invalid.join(', ') || '(empty)'}`);
  }
  return codes;
}

export interface AppConfig {
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  readonly migrationDatabaseUrl: string;
  readonly supportedCurrencies: readonly string[];
  readonly database: {
    readonly poolMax: number;
    readonly lockTimeoutMs: number;
    readonly statementTimeoutMs: number;
  };
  readonly pendingReference: {
    readonly workerEnabled: boolean;
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly batchSize: number;
  };
  readonly events: {
    readonly publisherEnabled: boolean;
    readonly queueName: string;
    readonly batchSize: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly publishTimeoutMs: number;
  };
  readonly aws: {
    readonly region: string;
    readonly endpoint: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
  readonly sqs: {
    readonly wagerQueue: string;
    readonly wagerDlq: string;
    readonly consumerEnabled: boolean;
    readonly maxAttempts: number;
    readonly backoffBaseMs: number;
    readonly backoffMaxMs: number;
    readonly visibilityTimeoutSeconds: number;
    readonly waitTimeSeconds: number;
    readonly batchSize: number;
    readonly shutdownGraceMs: number;
  };
}

export function loadConfig(): AppConfig {
  return {
    port: port('PORT', '3000'),
    logLevel: logLevel('LOG_LEVEL', 'info'),
    databaseUrl: required('DATABASE_URL', 'postgres://wallet_app:wallet_app@localhost:5432/wallet'),
    migrationDatabaseUrl: required('MIGRATION_DATABASE_URL', 'postgres://wallet:wallet@localhost:5432/wallet'),
    supportedCurrencies: currencyList('SUPPORTED_CURRENCIES', 'BRL'),
    database: {
      poolMax: positiveInt('DATABASE_POOL_MAX', '10'),
      lockTimeoutMs: positiveInt('DATABASE_LOCK_TIMEOUT_MS', '2000'),
      statementTimeoutMs: positiveInt('DATABASE_STATEMENT_TIMEOUT_MS', '5000'),
    },
    pendingReference: {
      workerEnabled: required('PENDING_REFERENCE_WORKER_ENABLED', 'true') !== 'false',
      maxAttempts: positiveInt('PENDING_REFERENCE_MAX_ATTEMPTS', '8'),
      baseDelayMs: positiveInt('PENDING_REFERENCE_BASE_DELAY_MS', '1000'),
      maxDelayMs: positiveInt('PENDING_REFERENCE_MAX_DELAY_MS', '60000'),
      batchSize: positiveInt('PENDING_REFERENCE_BATCH_SIZE', '50'),
    },
    events: {
      publisherEnabled: required('EVENTS_PUBLISHER_ENABLED', 'true') !== 'false',
      queueName: required('EVENTS_QUEUE', 'wallet-events.fifo'),
      batchSize: positiveInt('EVENTS_BATCH_SIZE', '10'),
      baseDelayMs: positiveInt('EVENTS_BASE_DELAY_MS', '1000'),
      maxDelayMs: positiveInt('EVENTS_MAX_DELAY_MS', '300000'),
      publishTimeoutMs: positiveInt('EVENTS_PUBLISH_TIMEOUT_MS', '3000'),
    },
    aws: {
      region: required('AWS_REGION', 'us-east-1'),
      endpoint: required('AWS_ENDPOINT_URL', 'http://localhost:4566'),
      accessKeyId: required('AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: required('AWS_SECRET_ACCESS_KEY', 'test'),
    },
    sqs: {
      wagerQueue: required('SQS_WAGER_QUEUE', 'wager-transactions.fifo'),
      wagerDlq: required('SQS_WAGER_DLQ', 'wager-transactions-dlq.fifo'),
      consumerEnabled: required('SQS_CONSUMER_ENABLED', 'true') !== 'false',
      maxAttempts: positiveInt('SQS_MAX_ATTEMPTS', '7'),
      backoffBaseMs: positiveInt('SQS_BACKOFF_BASE_MS', '2000'),
      backoffMaxMs: positiveInt('SQS_BACKOFF_MAX_MS', '60000'),
      visibilityTimeoutSeconds: positiveInt('SQS_VISIBILITY_TIMEOUT_SECONDS', '30'),
      waitTimeSeconds: positiveInt('SQS_WAIT_TIME_SECONDS', '20'),
      batchSize: positiveInt('SQS_BATCH_SIZE', '10'),
      shutdownGraceMs: positiveInt('SQS_SHUTDOWN_GRACE_MS', '10000'),
    },
  };
}
