import { Module } from '@nestjs/common';
import { ItineraryTrackingController } from './itinerary-tracking.controller';
import { ItineraryTrackingService } from './itinerary-tracking.service';
import { NotificationsModule } from '../tourist/notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [ItineraryTrackingController],
  providers: [ItineraryTrackingService],
})
export class ItineraryTrackingModule {}
