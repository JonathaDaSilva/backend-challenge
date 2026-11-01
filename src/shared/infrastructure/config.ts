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
  readonly databaseUrl: string;
  readonly migrationDatabaseUrl: string;
  readonly supportedCurrencies: readonly string[];
  readonly database: {
    readonly poolMax: number;
    readonly lockTimeoutMs: number;
    readonly statementTimeoutMs: number;
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
  };
}

export function loadConfig(): AppConfig {
  return {
    port: port('PORT', '3000'),
    databaseUrl: required('DATABASE_URL', 'postgres://wallet_app:wallet_app@localhost:5432/wallet'),
    migrationDatabaseUrl: required('MIGRATION_DATABASE_URL', 'postgres://wallet:wallet@localhost:5432/wallet'),
    supportedCurrencies: currencyList('SUPPORTED_CURRENCIES', 'BRL'),
    database: {
      poolMax: positiveInt('DATABASE_POOL_MAX', '10'),
      lockTimeoutMs: positiveInt('DATABASE_LOCK_TIMEOUT_MS', '2000'),
      statementTimeoutMs: positiveInt('DATABASE_STATEMENT_TIMEOUT_MS', '5000'),
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
    },
  };
}
