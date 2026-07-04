import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { RecommendationService } from './recommendation.service';
import { MlClientService } from './ml-client.service';
import { RecommendationController } from './recommendation.controller';
import { TwoTowerConfigService } from './two-tower-config.service';

@Module({
  imports: [HttpModule],
  controllers: [RecommendationController],
  providers: [RecommendationService, MlClientService, TwoTowerConfigService],
  exports: [RecommendationService, TwoTowerConfigService],
})
export class RecommendationModule {}
