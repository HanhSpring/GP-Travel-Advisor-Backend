import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { RecommendationService } from './recommendation.service';
import { RetrievalService } from './retrieval.service';
import { PlanningService } from './planning.service';
import { MlClientService } from './ml-client.service';
import { RecommendationController } from './recommendation.controller';
import { TwoTowerConfigService } from './two-tower-config.service';

@Module({
  imports: [HttpModule],
  controllers: [RecommendationController],
  providers: [RecommendationService, MlClientService, TwoTowerConfigService, RetrievalService, PlanningService],
  exports: [RecommendationService],
})
export class RecommendationModule {}
