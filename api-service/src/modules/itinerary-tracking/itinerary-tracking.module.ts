import { Module } from '@nestjs/common';
import { ItineraryTrackingController } from './itinerary-tracking.controller';
import { ItineraryTrackingService } from './itinerary-tracking.service';
import { NotificationsModule } from '../tourist/notifications/notifications.module';
import { ItineraryModule } from '../itinerary/itinerary.module';

@Module({
  imports: [NotificationsModule, ItineraryModule],
  controllers: [ItineraryTrackingController],
  providers: [ItineraryTrackingService],
})
export class ItineraryTrackingModule {}
