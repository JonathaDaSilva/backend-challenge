import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { createMikroOrmConfig } from './shared/infrastructure/database/mikro-orm.config';

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      useFactory: () => createMikroOrmConfig(),
    }),
  ],
})
export class AppModule {}
