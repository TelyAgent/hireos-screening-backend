import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../auth/workspace.guard';
import { PrismaService } from '../persistence/prisma.service';
import { CandidatesService } from './candidates.service';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';
import { DiscoveryModule } from '../discovery/discovery.module';
import { CoreRecordModule } from '../core-record/core-record.module';

@Module({
  imports: [DiscoveryModule, CoreRecordModule],
  controllers: [LibraryController],
  providers: [PrismaService, WorkspaceGuard, CandidatesService, LibraryService],
  exports: [CandidatesService, LibraryService],
})
export class LibraryModule {}
