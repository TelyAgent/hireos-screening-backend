import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../auth/workspace.guard';
import { PrismaService } from '../persistence/prisma.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { MailService } from './mail.service';

@Module({
  controllers: [SettingsController],
  providers: [PrismaService, WorkspaceGuard, SettingsService, MailService],
  exports: [SettingsService],
})
export class SettingsModule {}
