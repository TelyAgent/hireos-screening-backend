import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../auth/workspace.guard';
import { PrismaService } from '../persistence/prisma.service';
import { DecisionsController } from './decisions.controller';
import { DecisionsService } from './decisions.service';
import { InterviewHandoffDispatcherService } from './interview-handoff-dispatcher.service';

@Module({
  controllers: [DecisionsController],
  providers: [PrismaService, WorkspaceGuard, DecisionsService, InterviewHandoffDispatcherService],
})
export class DecisionsModule {}
