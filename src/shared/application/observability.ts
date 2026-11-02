export type Labels = Readonly<Record<string, string>>;

export interface Metrics {
  increment(name: string, labels?: Labels, value?: number): void;
}

export interface StructuredLogger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export const METRICS = Symbol('METRICS');
export const STRUCTURED_LOGGER = Symbol('STRUCTURED_LOGGER');
