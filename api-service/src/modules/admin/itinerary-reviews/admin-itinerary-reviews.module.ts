import { Module } from '@nestjs/common';
import { AdminItineraryReviewsController } from './admin-itinerary-reviews.controller';
import { AdminItineraryReviewsService } from './admin-itinerary-reviews.service';

@Module({
  controllers: [AdminItineraryReviewsController],
  providers: [AdminItineraryReviewsService],
})
export class AdminItineraryReviewsModule {}
