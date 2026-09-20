import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../auth/workspace.guard';
import { PrismaService } from '../persistence/prisma.service';
import { LinkingController } from './linking.controller';
import { LinkingService } from './linking.service';
import { CoreRecordModule } from '../core-record/core-record.module';

@Module({
  imports: [CoreRecordModule],
  controllers: [LinkingController],
  providers: [PrismaService, WorkspaceGuard, LinkingService],
  exports: [LinkingService],
})
export class LinkingModule {}
