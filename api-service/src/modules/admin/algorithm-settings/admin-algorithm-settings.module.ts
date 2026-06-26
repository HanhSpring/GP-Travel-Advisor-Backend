import { Module } from '@nestjs/common';
import { AdminAlgorithmSettingsController } from './admin-algorithm-settings.controller';
import { AdminAlgorithmSettingsService } from './admin-algorithm-settings.service';

@Module({
  controllers: [AdminAlgorithmSettingsController],
  providers: [AdminAlgorithmSettingsService],
  exports: [AdminAlgorithmSettingsService],
})
export class AdminAlgorithmSettingsModule {}
