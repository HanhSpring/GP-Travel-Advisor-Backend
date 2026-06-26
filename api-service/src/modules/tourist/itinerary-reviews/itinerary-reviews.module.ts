import { Module } from '@nestjs/common';
import { ItineraryReviewsController } from './itinerary-reviews.controller';
import { ItineraryReviewsService } from './itinerary-reviews.service';

@Module({
  imports: [],
  controllers: [ItineraryReviewsController],
  providers: [ItineraryReviewsService],
})
export class ItineraryReviewsModule {}
