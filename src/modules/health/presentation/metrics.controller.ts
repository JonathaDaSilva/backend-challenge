import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import { PromMetrics } from '../../../shared/infrastructure/prom-metrics';
import { Public } from '../../../shared/presentation/auth/auth.guard';

interface ContentTypeSetter {
  setHeader(name: string, value: string): void;
}

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(PromMetrics) private readonly metrics: PromMetrics) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(@Res({ passthrough: true }) response: ContentTypeSetter): Promise<string> {
    response.setHeader('Content-Type', this.metrics.contentType());
    return this.metrics.metrics();
  }
}
