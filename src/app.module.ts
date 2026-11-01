import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { HealthModule } from './modules/health/health.module';
import { createMikroOrmConfig } from './shared/infrastructure/database/mikro-orm.config';
import { InfrastructureModule } from './shared/infrastructure/infrastructure.module';

@Module({
  imports: [
    InfrastructureModule,
    MikroOrmModule.forRootAsync({
      useFactory: () => createMikroOrmConfig(),
    }),
    HealthModule,
  ],
})
export class AppModule {}
