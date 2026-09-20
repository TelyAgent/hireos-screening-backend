import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../auth/workspace.guard';
import { PrismaService } from '../persistence/prisma.service';
import { ComparisonsController } from './comparisons.controller';
import { ComparisonsService } from './comparisons.service';

@Module({
  controllers: [ComparisonsController],
  providers: [PrismaService, WorkspaceGuard, ComparisonsService],
})
export class ComparisonsModule {}
