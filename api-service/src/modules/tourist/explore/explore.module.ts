import { Module } from '@nestjs/common';
import { ExploreController } from './explore.controller';
import { ExploreService } from './explore.service';
import { ExploreCacheService } from './services/explore-cache.service';
import { ExploreItineraryService } from './services/explore-itinerary.service';
import { ExplorePlacesService } from './services/explore-places.service';

@Module({
  controllers: [ExploreController],
  providers: [
    ExploreService,
    ExploreCacheService,
    ExploreItineraryService,
    ExplorePlacesService,
  ],
})
export class ExploreModule {}
