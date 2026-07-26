import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ExploreController } from './explore.controller';
import { ExploreService } from './explore.service';
import { ItineraryLifecycleCron } from './itinerary-lifecycle.cron';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [ExploreController],
  providers: [ExploreService, ItineraryLifecycleCron],
})
export class ExploreModule {}
