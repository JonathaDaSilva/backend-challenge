import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { HealthModule } from './modules/health/health.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { createMikroOrmConfig } from './shared/infrastructure/database/mikro-orm.config';
import { PersistenceModule } from './shared/infrastructure/database/persistence.module';
import { InfrastructureModule } from './shared/infrastructure/infrastructure.module';
import { OutboxModule } from './shared/infrastructure/outbox.module';
import { CorrelationMiddleware } from './shared/presentation/correlation.middleware';
import { ErrorFilter } from './shared/presentation/error.filter';
import { JsonContentTypeMiddleware } from './shared/presentation/json-content-type.middleware';

@Module({
  imports: [
    InfrastructureModule,
    MikroOrmModule.forRootAsync({
      useFactory: () => createMikroOrmConfig(),
    }),
    PersistenceModule,
    OutboxModule,
    HealthModule,
    WalletModule,
    WageringModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ErrorFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware, JsonContentTypeMiddleware).forRoutes('*');
  }
}
