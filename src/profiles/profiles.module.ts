import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../auth/workspace.guard';
import { PrismaService } from '../persistence/prisma.service';
import { ProfilesController } from './profiles.controller';
import { ProfileParserService } from './profile-parser.service';
import { AiProfileParserService } from './ai-profile-parser.service';
import { ProfilesService } from './profiles.service';
import { DiscoveryModule } from '../discovery/discovery.module';

@Module({
  imports: [DiscoveryModule],
  controllers: [ProfilesController],
  providers: [PrismaService, WorkspaceGuard, ProfileParserService, AiProfileParserService, ProfilesService],
  exports: [ProfilesService],
})
export class ProfilesModule {}
