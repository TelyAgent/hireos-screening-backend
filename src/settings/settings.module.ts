import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../auth/workspace.guard';
import { PrismaService } from '../persistence/prisma.service';
import { IntakeModule } from '../intake/intake.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { MailService } from './mail.service';

@Module({
  imports: [IntakeModule],
  controllers: [SettingsController],
  providers: [PrismaService, WorkspaceGuard, SettingsService, MailService],
  exports: [SettingsService],
})
export class SettingsModule {}
