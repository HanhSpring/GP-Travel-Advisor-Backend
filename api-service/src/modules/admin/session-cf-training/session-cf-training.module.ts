import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { SessionCfTrainingController } from './session-cf-training.controller';
import { SessionCfTrainingService } from './session-cf-training.service';
import { SessionCfTrainingScheduleCron } from './session-cf-training-schedule.cron';

@Module({
  imports: [
    HttpModule.register({
      timeout: 600_000, // 10 phút — train có thể mất vài phút khi dữ liệu lớn hơn
    }),
  ],
  controllers: [SessionCfTrainingController],
  providers: [SessionCfTrainingService, SessionCfTrainingScheduleCron],
})
export class SessionCfTrainingModule {}
