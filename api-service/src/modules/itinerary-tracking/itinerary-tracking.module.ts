import { Module } from '@nestjs/common';
import { ItineraryTrackingController } from './itinerary-tracking.controller';
import { ItineraryTrackingService } from './itinerary-tracking.service';

@Module({
  controllers: [ItineraryTrackingController],
  providers: [ItineraryTrackingService],
})
export class ItineraryTrackingModule {}
