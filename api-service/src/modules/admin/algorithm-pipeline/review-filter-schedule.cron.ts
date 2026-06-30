import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AdminAlgorithmPipelineService } from './admin-algorithm-pipeline.service';

@Injectable()
export class ReviewFilterScheduleCron {
  private readonly logger = new Logger(ReviewFilterScheduleCron.name);
  private isRunning = false;

  constructor(private readonly pipelineService: AdminAlgorithmPipelineService) {}

  @Cron('* * * * *')
  async handleReviewFilterSchedule(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    try {
      await this.pipelineService.runReviewFilterIfDue();
    } catch (error: any) {
      this.logger.error(
        `Review filter schedule check failed: ${error?.message ?? error}`,
      );
    } finally {
      this.isRunning = false;
    }
  }
}
