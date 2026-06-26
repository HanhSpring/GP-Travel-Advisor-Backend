import { Module } from '@nestjs/common';
import { PlaceTypesController } from './place-type.controller';
import { PlaceTypesService } from './place-type.service';

@Module({
  controllers: [PlaceTypesController],
  providers: [PlaceTypesService],
})
export class PlaceTypesModule {}
