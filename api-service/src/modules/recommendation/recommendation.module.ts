import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { RecommendationService } from './recommendation.service';
import { MlClientService } from './ml-client.service';
import { RecommendationController } from './recommendation.controller';
import { TwoTowerConfigService } from './two-tower-config.service';
import { TripCostConfigService } from './trip-cost-config.service';

@Module({
  imports: [HttpModule],
  controllers: [RecommendationController],
  providers: [
    RecommendationService,
    MlClientService,
    TwoTowerConfigService,
    TripCostConfigService,
  ],
  exports: [RecommendationService, TwoTowerConfigService, TripCostConfigService],
})
export class RecommendationModule {}
