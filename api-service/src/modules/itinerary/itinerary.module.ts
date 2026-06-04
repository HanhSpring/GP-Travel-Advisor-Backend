import { Module } from '@nestjs/common';
import { ItineraryController } from './itinerary.controller';
import { ItineraryService } from './itinerary.service';
import { RecommendationModule } from '../recommendation/recommendation.module';

@Module({
  imports: [RecommendationModule],
  controllers: [ItineraryController],
  providers: [ItineraryService],
})
export class ItineraryModule {}
