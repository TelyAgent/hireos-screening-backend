import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../auth/workspace.guard';
import { PrismaService } from '../persistence/prisma.service';
import { ScreeningController } from './screening.controller';
import { ScreeningService } from './screening.service';
import { AiScreeningEvaluatorService } from './ai-screening-evaluator.service';

@Module({
  controllers: [ScreeningController],
  providers: [PrismaService, WorkspaceGuard, ScreeningService, AiScreeningEvaluatorService],
})
export class ScreeningModule {}
