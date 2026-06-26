import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ModerationService } from './moderation.service';
import { ReviewModerationCronService } from './review-moderation.cron';
import { NotificationsModule } from '../tourist/notifications/notifications.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    NotificationsModule,
  ],
  providers: [ModerationService, ReviewModerationCronService],
  exports: [ModerationService],
})
export class ModerationModule {}
