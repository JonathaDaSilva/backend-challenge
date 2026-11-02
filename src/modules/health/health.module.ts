import { Module } from '@nestjs/common';
import { HealthController } from './presentation/health.controller';
import { MetricsController } from './presentation/metrics.controller';

@Module({
  controllers: [HealthController, MetricsController],
})
export class HealthModule {}
