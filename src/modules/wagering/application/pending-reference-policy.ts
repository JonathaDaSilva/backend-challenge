export interface PendingReferencePolicyOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export class PendingReferencePolicy {
  constructor(
    readonly options: PendingReferencePolicyOptions,
    private readonly random: () => number = Math.random,
  ) {}

  isExhausted(attempts: number): boolean {
    return attempts >= this.options.maxAttempts;
  }

  nextAttemptAt(now: Date, attempts: number): Date {
    return new Date(now.getTime() + this.delayMs(attempts));
  }

  delayMs(attempts: number): number {
    const ceiling = Math.min(this.options.baseDelayMs * 2 ** attempts, this.options.maxDelayMs);
    return Math.round(ceiling / 2 + (this.random() * ceiling) / 2);
  }
}
