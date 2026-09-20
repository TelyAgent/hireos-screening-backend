import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../auth/workspace.guard';
import { PrismaService } from '../persistence/prisma.service';
import { DuplicatesController } from './duplicates.controller';
import { DuplicatesService } from './duplicates.service';
import { ProfilesModule } from '../profiles/profiles.module';

@Module({
  imports: [ProfilesModule],
  controllers: [DuplicatesController],
  providers: [PrismaService, WorkspaceGuard, DuplicatesService],
})
export class DuplicatesModule {}
