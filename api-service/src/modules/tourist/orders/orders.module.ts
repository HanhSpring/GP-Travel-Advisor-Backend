import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { ItineraryOrdersController } from './itinerary-orders.controller';
import { OrderActionsController } from './order-actions.controller';
import { OrdersService } from './orders.service';

@Module({
  controllers: [OrdersController, ItineraryOrdersController, OrderActionsController],
  providers: [OrdersService],
})
export class OrdersModule {}
