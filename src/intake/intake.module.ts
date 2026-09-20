import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../auth/workspace.guard';
import { PrismaService } from '../persistence/prisma.service';
import { IntakeController } from './intake.controller';
import { ImportsService } from './imports.service';
import { MaterialsService } from './materials.service';
import { ProfilesModule } from '../profiles/profiles.module';

@Module({
  imports: [ProfilesModule],
  controllers: [IntakeController],
  providers: [PrismaService, WorkspaceGuard, MaterialsService, ImportsService],
  exports: [MaterialsService, ImportsService],
})
export class IntakeModule {}
