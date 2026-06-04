import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { RecommendationService } from './recommendation.service';
import { MlClientService } from './ml-client.service';
import { RecommendationController } from './recommendation.controller';

@Module({
  imports: [HttpModule],
  controllers: [RecommendationController],
  providers: [RecommendationService, MlClientService],
  exports: [RecommendationService],
})
export class RecommendationModule {}
