import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../auth/workspace.guard';
import { PrismaService } from '../persistence/prisma.service';
import { DeliveriesController } from './deliveries.controller';
import { DeliveriesService } from './deliveries.service';

@Module({
  controllers: [DeliveriesController],
  providers: [PrismaService, WorkspaceGuard, DeliveriesService],
})
export class DeliveriesModule {}
