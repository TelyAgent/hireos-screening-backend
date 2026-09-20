import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../auth/workspace.guard';
import { PrismaService } from '../persistence/prisma.service';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { CoreRecordModule } from '../core-record/core-record.module';
import { JobCriteriaFacade } from './job-criteria.facade';

@Module({
  imports: [CoreRecordModule],
  controllers: [JobsController],
  providers: [PrismaService, WorkspaceGuard, JobsService, JobCriteriaFacade],
  exports: [JobsService],
})
export class JobsModule {}
