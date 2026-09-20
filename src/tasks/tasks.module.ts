import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../auth/workspace.guard';
import { PrismaService } from '../persistence/prisma.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  controllers: [TasksController],
  providers: [PrismaService, WorkspaceGuard, TasksService],
  exports: [TasksService],
})
export class TasksModule {}
