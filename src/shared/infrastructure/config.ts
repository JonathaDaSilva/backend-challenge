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

export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
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

// Defaults match docker-compose.yml so a fresh clone runs without a .env file.
export function loadConfig(): AppConfig {
  return {
    port: port('PORT', '3000'),
    databaseUrl: required('DATABASE_URL', 'postgres://wallet:wallet@localhost:5432/wallet'),
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
