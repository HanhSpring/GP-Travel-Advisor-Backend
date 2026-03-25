import { Module } from '@nestjs/common';
import { BusinessReviewsController } from './business-reviews.controller';
import { BusinessReviewsService } from './business-reviews.service';

@Module({
  controllers: [BusinessReviewsController],
  providers: [BusinessReviewsService],
})
export class BusinessReviewsModule {}
