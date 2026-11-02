import { Logger } from '@nestjs/common';
import type { StructuredLogger } from '../application/observability';

export class NestStructuredLogger implements StructuredLogger {
  private readonly logger = new Logger('App');

  info(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.logger.log(JSON.stringify({ message, ...fields }));
  }

  warn(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.logger.warn(JSON.stringify({ message, ...fields }));
  }
}
