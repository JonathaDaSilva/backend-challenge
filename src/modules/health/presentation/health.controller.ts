import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../../shared/infrastructure/config';
import { APP_CONFIG, SQS_CLIENT } from '../../../shared/infrastructure/tokens';

type CheckStatus = 'up' | 'down';

const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('live')
  @HttpCode(200)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HttpCode(200)
  async ready(): Promise<{ status: 'ok'; checks: Record<string, CheckStatus> }> {
    const [postgres, sqs] = await Promise.allSettled([
      withTimeout(this.orm.em.getConnection().execute('select 1'), CHECK_TIMEOUT_MS),
      this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.wagerQueue }), {
        abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      }),
    ]);

    const checks: Record<string, CheckStatus> = {
      postgres: postgres.status === 'fulfilled' ? 'up' : 'down',
      sqs: sqs.status === 'fulfilled' ? 'up' : 'down',
    };

    if (Object.values(checks).includes('down')) {
      throw new ServiceUnavailableException({ status: 'error', checks });
    }
    return { status: 'ok', checks };
  }
}
