import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { ItineraryOrdersController } from './itinerary-orders.controller';
import { OrdersService } from './orders.service';

@Module({
  controllers: [OrdersController, ItineraryOrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
