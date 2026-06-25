import { Module } from '@nestjs/common';
import { ItineraryReviewsController } from './itinerary-reviews.controller';
import { ItineraryReviewsService } from './itinerary-reviews.service';
import { ModerationModule } from '../../moderation/moderation.module';

@Module({
  imports: [ModerationModule],
  controllers: [ItineraryReviewsController],
  providers: [ItineraryReviewsService],
})
export class ItineraryReviewsModule {}
