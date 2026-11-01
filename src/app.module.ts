import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { HealthModule } from './modules/health/health.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { createMikroOrmConfig } from './shared/infrastructure/database/mikro-orm.config';
import { InfrastructureModule } from './shared/infrastructure/infrastructure.module';
import { ErrorFilter } from './shared/presentation/error.filter';

@Module({
  imports: [
    InfrastructureModule,
    MikroOrmModule.forRootAsync({
      useFactory: () => createMikroOrmConfig(),
    }),
    HealthModule,
    WalletModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ErrorFilter }],
})
export class AppModule {}
