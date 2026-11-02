export type Labels = Readonly<Record<string, string>>;

export const MetricNames = {
  WagerTransactions: 'wager_transactions_total',
  WagerDuplicates: 'wager_duplicates_total',
  WagerProcessingDuration: 'wager_processing_duration_seconds',
  SqsMessageRetries: 'sqs_message_retries_total',
  SqsDeadLetters: 'sqs_dead_letters_total',
  DbTransactionRetries: 'db_transaction_retries_total',
  DbLockConflicts: 'db_lock_conflicts_total',
  OutboxPublished: 'outbox_published_total',
  OutboxPublishFailures: 'outbox_publish_failures_total',
  HttpRequestDuration: 'http_request_duration_seconds',
  ReconciliationDivergences: 'wallet_reconciliation_divergences_total',
} as const;

export type MetricName = (typeof MetricNames)[keyof typeof MetricNames];

export interface Metrics {
  increment(name: MetricName, labels?: Labels, value?: number): void;
  observe(name: MetricName, labels: Labels, value: number): void;
}

export type LogFields = Readonly<Record<string, unknown>>;

export interface StructuredLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const METRICS = Symbol('METRICS');
export const STRUCTURED_LOGGER = Symbol('STRUCTURED_LOGGER');
