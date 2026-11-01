import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module';

export interface StartedApp {
  readonly url: string;
  close(): Promise<void>;
}

export async function startApp(
  configure: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<StartedApp> {
  const moduleRef = await configure(Test.createTestingModule({ imports: [AppModule] })).compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: false });
  await app.listen(0);
  const url = await app.getUrl();
  return { url, close: () => app.close() };
}

export function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
