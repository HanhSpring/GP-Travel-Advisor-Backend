import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AdminAlgorithmPipelineController } from './admin-algorithm-pipeline.controller';
import { AdminAlgorithmPipelineService } from './admin-algorithm-pipeline.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 600_000,
    }),
  ],
  controllers: [AdminAlgorithmPipelineController],
  providers: [AdminAlgorithmPipelineService],
})
export class AdminAlgorithmPipelineModule {}
