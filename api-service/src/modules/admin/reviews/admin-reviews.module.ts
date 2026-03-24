import { Module } from '@nestjs/common';
import { AdminReviewsController } from './admin-reviews.controller';
import { AdminReviewsService } from './admin-reviews.service';

@Module({
  controllers: [AdminReviewsController],
  providers: [AdminReviewsService],
})
export class AdminReviewsModule {}
