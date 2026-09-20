import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { PrismaService } from './persistence/prisma.service';
import { IntakeModule } from './intake/intake.module';
import { LibraryModule } from './library/library.module';
import { DuplicatesModule } from './duplicates/duplicates.module';
import { ProfilesModule } from './profiles/profiles.module';
import { JobsModule } from './jobs/jobs.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { LinkingModule } from './linking/linking.module';
import { TasksModule } from './tasks/tasks.module';
import { ScreeningModule } from './screening/screening.module';
import { ComparisonsModule } from './comparisons/comparisons.module';
import { DecisionsModule } from './decisions/decisions.module';
import { DeliveriesModule } from './deliveries/deliveries.module';
import { SettingsModule } from './settings/settings.module';
import { CoreRecordModule } from './core-record/core-record.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    HealthModule,
    IntakeModule,
    LibraryModule,
    DuplicatesModule,
    ProfilesModule,
    JobsModule,
    DiscoveryModule,
    LinkingModule,
    TasksModule,
    ScreeningModule,
    ComparisonsModule,
    DecisionsModule,
    DeliveriesModule,
    SettingsModule,
    CoreRecordModule,
  ],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class AppModule {}
