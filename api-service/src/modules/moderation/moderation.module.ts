import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ModerationService } from './moderation.service';
import { ModerationCron } from './moderation.cron';
import { NotificationsModule } from '../tourist/notifications/notifications.module';
import { AdminAlgorithmSettingsModule } from '../admin/algorithm-settings/admin-algorithm-settings.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    NotificationsModule,
    AdminAlgorithmSettingsModule,
  ],
  providers: [ModerationService, ModerationCron],
  exports: [ModerationService],
})
export class ModerationModule {}
