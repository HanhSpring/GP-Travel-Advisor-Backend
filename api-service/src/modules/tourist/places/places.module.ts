import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PlacesController } from './places.controller';
import { PlacesService } from './places.service';
import { RecommendationsService } from './recommendations.service';

@Module({
  imports: [HttpModule],
  controllers: [PlacesController],
  providers: [PlacesService, RecommendationsService],
  exports: [RecommendationsService],
})
export class PlacesModule {}
