import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import {
  AlgorithmTrainingController,
  AlgorithmTrainingWebhookController,
} from './algorithm-training.controller';
import { AlgorithmTrainingService } from './algorithm-training.service';
import { AlgorithmTrainingScheduleCron } from './algorithm-training-schedule.cron';

@Module({
  imports: [
    HttpModule.register({
      timeout: 600_000, // prepare-dataset có thể mất vài chục giây tới vài phút
    }),
  ],
  controllers: [AlgorithmTrainingController, AlgorithmTrainingWebhookController],
  providers: [AlgorithmTrainingService, AlgorithmTrainingScheduleCron],
})
export class AlgorithmTrainingModule {}
