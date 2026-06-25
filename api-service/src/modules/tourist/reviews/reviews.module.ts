import { Module } from '@nestjs/common';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { AuthModule } from '../../auth/auth.module';
import { ModerationModule } from '../../moderation/moderation.module';

@Module({
  imports: [AuthModule, ModerationModule],
  controllers: [ReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}
