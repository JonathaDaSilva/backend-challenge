import 'reflect-metadata';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module';
import { type AppConfig, loadConfig } from '../../../src/shared/infrastructure/config';
import { STRUCTURED_LOGGER } from '../../../src/shared/application/observability';
import { APP_CONFIG } from '../../../src/shared/infrastructure/tokens';

export interface StartedApp {
  readonly url: string;
  get<T>(token: unknown): T;
  close(): Promise<void>;
}

export async function startApp(
  configure: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
  options: { logger?: LoggerService } = {},
): Promise<StartedApp> {
  let builder = configure(Test.createTestingModule({ imports: [AppModule] }));
  if (options.logger) builder = builder.overrideProvider(STRUCTURED_LOGGER).useValue(options.logger);
  const moduleRef = await builder.compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: options.logger ?? false });
  await app.listen(0);
  const url = await app.getUrl();
  return {
    url,
    get: <T>(token: unknown) => app.get(token as never) as T,
    close: () => app.close(),
  };
}

export function withConfig(
  overrides: (config: AppConfig) => AppConfig,
): (builder: TestingModuleBuilder) => TestingModuleBuilder {
  return (builder) => builder.overrideProvider(APP_CONFIG).useValue(overrides(loadConfig()));
}

export function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
