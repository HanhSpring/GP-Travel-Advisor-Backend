import { Module } from '@nestjs/common';
import { ItineraryController } from './itinerary.controller';
import { ItineraryService } from './itinerary.service';
import { IncurredCostsController } from './incurred-costs.controller';
import { IncurredCostsService } from './incurred-costs.service';
import { RecommendationModule } from '../recommendation/recommendation.module';
import { PlacesModule } from '../tourist/places/places.module';

@Module({
  imports: [RecommendationModule, PlacesModule],
  controllers: [ItineraryController, IncurredCostsController],
  providers: [ItineraryService, IncurredCostsService],
  exports: [ItineraryService, IncurredCostsService],
})
export class ItineraryModule {}
