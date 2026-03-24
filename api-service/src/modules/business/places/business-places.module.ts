import { Module } from '@nestjs/common';
import { BusinessPlacesController } from './business-places.controller';
import { BusinessPlacesService } from './business-places.service';

@Module({
  controllers: [BusinessPlacesController],
  providers: [BusinessPlacesService],
})
export class BusinessPlacesModule {}
