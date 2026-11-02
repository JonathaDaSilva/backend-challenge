import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { type Labels, type MetricName, MetricNames, type Metrics } from '../application/observability';

type Definition =
  | { readonly type: 'counter'; readonly help: string; readonly labelNames: readonly string[] }
  | { readonly type: 'histogram'; readonly help: string; readonly labelNames: readonly string[]; readonly buckets: number[] };

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

const DEFINITIONS: Record<MetricName, Definition> = {
  [MetricNames.WagerTransactions]: {
    type: 'counter',
    help: 'Wager transactions settled, by kind, final status and entry point',
    labelNames: ['kind', 'status', 'source'],
  },
  [MetricNames.WagerDuplicates]: {
    type: 'counter',
    help: 'Duplicates detected: idempotent replays and inbox redeliveries',
    labelNames: ['type'],
  },
  [MetricNames.WagerProcessingDuration]: {
    type: 'histogram',
    help: 'Time to process a wager transaction submission',
    labelNames: ['source', 'kind'],
    buckets: LATENCY_BUCKETS,
  },
  [MetricNames.SqsMessageRetries]: {
    type: 'counter',
    help: 'SQS messages scheduled for another attempt',
    labelNames: ['failure_code'],
  },
  [MetricNames.SqsDeadLetters]: {
    type: 'counter',
    help: 'SQS messages moved to the dead-letter queue',
    labelNames: ['failure_code'],
  },
  [MetricNames.DbTransactionRetries]: {
    type: 'counter',
    help: 'Database transactions retried by the transaction runner',
    labelNames: ['reason'],
  },
  [MetricNames.DbLockConflicts]: {
    type: 'counter',
    help: 'Lock conflicts: lock timeouts, deadlocks and serialization failures',
    labelNames: ['reason'],
  },
  [MetricNames.OutboxPublished]: { type: 'counter', help: 'Outbox events published', labelNames: [] },
  [MetricNames.OutboxPublishFailures]: { type: 'counter', help: 'Outbox events that failed to publish', labelNames: [] },
  [MetricNames.HttpRequestDuration]: {
    type: 'histogram',
    help: 'HTTP request duration by route pattern',
    labelNames: ['method', 'route', 'status'],
    buckets: LATENCY_BUCKETS,
  },
  [MetricNames.ReconciliationDivergences]: {
    type: 'counter',
    help: 'Wallet reconciliations that found a divergence',
    labelNames: ['currency'],
  },
};

export class PromMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly counters = new Map<MetricName, Counter>();
  private readonly histograms = new Map<MetricName, Histogram>();

  constructor() {
    for (const [name, definition] of Object.entries(DEFINITIONS) as [MetricName, Definition][]) {
      const common = { name, help: definition.help, labelNames: [...definition.labelNames], registers: [this.registry] };
      if (definition.type === 'counter') this.counters.set(name, new Counter(common));
      else this.histograms.set(name, new Histogram({ ...common, buckets: definition.buckets }));
    }
  }

  increment(name: MetricName, labels: Labels = {}, value = 1): void {
    const counter = this.counters.get(name);
    if (!counter) throw new Error(`${name} is not a counter`);
    counter.inc(labels, value);
  }

  observe(name: MetricName, labels: Labels, value: number): void {
    const histogram = this.histograms.get(name);
    if (!histogram) throw new Error(`${name} is not a histogram`);
    histogram.observe(labels, value);
  }

  registerGauge(name: string, help: string, collect: () => Promise<number>): void {
    new Gauge({
      name,
      help,
      registers: [this.registry],
      async collect() {
        this.set(await collect());
      },
    });
  }

  async value(name: MetricName, labels: Labels = {}): Promise<number> {
    const metric = this.counters.get(name) ?? this.histograms.get(name);
    const { values } = (await metric?.get()) ?? { values: [] };
    const matches = (candidate: Record<string, unknown>) =>
      Object.entries(labels).every(([key, value]) => candidate[key] === value);
    const suffix = this.histograms.has(name) ? `${name}_count` : name;
    return values
      .filter((sample) => ((sample as { metricName?: string }).metricName ?? name) === suffix && matches(sample.labels))
      .reduce((sum, sample) => sum + sample.value, 0);
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }
}
