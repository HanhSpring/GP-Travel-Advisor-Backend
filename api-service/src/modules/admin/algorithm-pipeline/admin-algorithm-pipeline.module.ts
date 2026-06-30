import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AdminAlgorithmPipelineController } from './admin-algorithm-pipeline.controller';
import { AdminAlgorithmPipelineService } from './admin-algorithm-pipeline.service';
import { AdminAlgorithmSettingsModule } from '../algorithm-settings/admin-algorithm-settings.module';
import { ReviewFilterScheduleCron } from './review-filter-schedule.cron';

@Module({
  imports: [
    HttpModule.register({
      timeout: 600_000, // 10 phút — pipeline ML có thể chạy lâu
    }),
    AdminAlgorithmSettingsModule,
  ],
  controllers: [AdminAlgorithmPipelineController],
  providers: [AdminAlgorithmPipelineService, ReviewFilterScheduleCron],
})
export class AdminAlgorithmPipelineModule {}
