import { Module } from '@nestjs/common';
import { CitiesController } from './city.controller';
import { CitiesService } from './city.service';

@Module({
  controllers: [CitiesController],
  providers: [CitiesService],
})
export class CitiesModule {}
