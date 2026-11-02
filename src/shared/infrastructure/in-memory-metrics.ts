import type { Labels, Metrics } from '../application/observability';

const key = (name: string, labels: Labels) =>
  `${name}${JSON.stringify(Object.fromEntries(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1))))}`;

export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, number>();

  increment(name: string, labels: Labels = {}, value = 1): void {
    const id = key(name, labels);
    this.counters.set(id, (this.counters.get(id) ?? 0) + value);
  }

  value(name: string, labels: Labels = {}): number {
    return this.counters.get(key(name, labels)) ?? 0;
  }
}
