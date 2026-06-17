import { Module } from '@nestjs/common';
import { ItineraryTrackingController } from './itinerary-tracking.controller';
import { ItineraryTrackingService } from './itinerary-tracking.service';
import { ItineraryTrackingQueryService } from './services/itinerary-tracking-query.service';

@Module({
  controllers: [ItineraryTrackingController],
  providers: [ItineraryTrackingService, ItineraryTrackingQueryService],
})
export class ItineraryTrackingModule {}
