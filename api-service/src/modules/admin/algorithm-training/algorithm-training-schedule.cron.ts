import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AlgorithmTrainingService } from './algorithm-training.service';

// Khi den lich: luon tu dong "Chuan bi du lieu"; chi tu dong goi tiep "Train" (GPU that tien)
// neu thuc su co du lieu moi va da qua cooldown toi thieu -- xem
// AlgorithmTrainingService.runAutoTrainingIfDue() de biet dieu kien chi tiet. Ngoai lich tu dong
// nay, admin van co the bam "Train lai" thu cong bat cu luc nao (khong phu thuoc cron).
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
      await this.trainingService.runAutoTrainingIfDue();
    } catch (error: any) {
      this.logger.error(`Algorithm training schedule check failed: ${error?.message ?? error}`);
    } finally {
      this.isRunning = false;
    }
  }
}
