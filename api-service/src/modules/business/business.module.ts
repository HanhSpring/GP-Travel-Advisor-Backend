import { Module } from '@nestjs/common';
import { ItineraryModule } from '../itinerary/itinerary.module';
import { BusinessController } from './business.controller';
import { BusinessService } from './business.service';

@Module({
  imports: [ItineraryModule],
  controllers: [BusinessController],
  providers: [BusinessService],
})
export class BusinessModule {}
