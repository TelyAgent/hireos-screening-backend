import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreRecordClient } from './core-record.client';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [CoreRecordClient],
  exports: [CoreRecordClient],
})
export class CoreRecordModule {}
