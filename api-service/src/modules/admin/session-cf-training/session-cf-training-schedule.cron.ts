import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SessionCfTrainingService } from './session-cf-training.service';

@Injectable()
export class SessionCfTrainingScheduleCron {
  private readonly logger = new Logger(SessionCfTrainingScheduleCron.name);
  private isRunning = false;

  constructor(private readonly trainingService: SessionCfTrainingService) {}

  @Cron('* * * * *')
  async handleSessionCfTrainingSchedule(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    try {
      await this.trainingService.runIfDue();
    } catch (error: any) {
      this.logger.error(
        `Session-CF training schedule check failed: ${error?.message ?? error}`,
      );
    } finally {
      this.isRunning = false;
    }
  }
}
