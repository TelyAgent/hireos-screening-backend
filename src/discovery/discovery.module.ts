import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../auth/workspace.guard';
import { PrismaService } from '../persistence/prisma.service';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';
import { AiMatcherService } from './ai-matcher.service';

@Module({
  controllers: [DiscoveryController],
  providers: [PrismaService, WorkspaceGuard, DiscoveryService, AiMatcherService],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
