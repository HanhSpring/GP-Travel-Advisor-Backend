import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AlgorithmTrainingService } from './algorithm-training.service';

// Chi tu dong hoa buoc "Chuan bi du lieu" -- KHONG bao gio tu goi train (train can GPU that tien,
// phai la hanh dong admin chu dich, dung nguyen tac da nhac trong docs/trigger/README.md muc 4).
@Injectable()
export class AlgorithmTrainingScheduleCron {
  private readonly logger = new Logger(AlgorithmTrainingScheduleCron.name);
  private isRunning = false;

  constructor(private readonly trainingService: AlgorithmTrainingService) {}

  @Cron('* * * * *')
  async handleAlgorithmTrainingSchedule(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    try {
      await this.trainingService.runPrepareDatasetIfDue();
    } catch (error: any) {
      this.logger.error(`Algorithm training schedule check failed: ${error?.message ?? error}`);
    } finally {
      this.isRunning = false;
    }
  }
}
