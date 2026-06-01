import { Module } from '@nestjs/common';
import { DashboardController } from './admin-dashboard.controller';
import { DashboardService } from './admin-dashboard.service';

@Module({
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class AdminDashboardModule {}
