import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import type { Clock } from '../../application/clock';
import { runWithCorrelation } from '../async-correlation-context';

export interface DeadlineJob {
  processDue(now: Date): Promise<unknown>;
  nextDueAt(): Promise<Date | undefined>;
}

const MAX_TIMER_MS = 2_147_483_647;
const RECONNECT_DELAY_MS = 1_000;

// Sem polling: um único timer apontado para o próximo vencimento, adiantado por LISTEN/NOTIFY.
export class DeadlineScheduler {
  private readonly logger: Logger;
  private client: Client | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerTarget: number | undefined;
  private running = false;
  private rerunRequested = false;
  private stopped = false;

  constructor(
    private readonly channel: string,
    private readonly job: DeadlineJob,
    private readonly clock: Clock,
    private readonly databaseUrl: string,
  ) {
    this.logger = new Logger(`DeadlineScheduler:${channel}`);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.listen();
    await this.rescheduleFromDatabase();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
  }

  schedule(dueAt: number): void {
    if (this.stopped) return;
    if (this.timerTarget !== undefined && this.timerTarget <= dueAt) return;
    this.clearTimer();
    this.timerTarget = dueAt;
    const delay = Math.min(Math.max(dueAt - this.clock.now().getTime(), 0), MAX_TIMER_MS);
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private async run(): Promise<void> {
    this.clearTimer();
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerunRequested = false;
        await runWithCorrelation(Bun.randomUUIDv7(), () => this.job.processDue(this.clock.now()));
      } while (this.rerunRequested && !this.stopped);
      await this.rescheduleFromDatabase();
    } catch (error) {
      this.logger.error(`scheduled run failed: ${String(error)}`);
      this.schedule(this.clock.now().getTime() + RECONNECT_DELAY_MS);
    } finally {
      this.running = false;
    }
  }

  private async rescheduleFromDatabase(): Promise<void> {
    const dueAt = await this.job.nextDueAt();
    if (dueAt) this.schedule(dueAt.getTime());
  }

  private async listen(): Promise<void> {
    const client = new Client({ connectionString: this.databaseUrl });
    client.on('notification', (message) => {
      const dueAt = Number(message.payload);
      if (Number.isFinite(dueAt)) this.schedule(dueAt);
    });
    client.on('error', (error) => {
      this.logger.warn(`listener connection lost: ${error.message}`);
      void this.reconnect(client);
    });
    await client.connect();
    await client.query(`LISTEN ${this.channel}`);
    this.client = client;
  }

  // Ao reconectar, notificações perdidas são compensadas relendo o próximo vencimento no banco.
  private async reconnect(failed: Client): Promise<void> {
    if (this.stopped || this.client !== failed) return;
    this.client = undefined;
    await failed.end().catch(() => undefined);
    while (!this.stopped) {
      try {
        await this.listen();
        await this.rescheduleFromDatabase();
        return;
      } catch {
        await Bun.sleep(RECONNECT_DELAY_MS);
      }
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerTarget = undefined;
  }
}
