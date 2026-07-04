import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OrdersController } from './orders.controller';
import { ItineraryOrdersController } from './itinerary-orders.controller';
import { OrderActionsController } from './order-actions.controller';
import { OrdersService } from './orders.service';
import { OrdersCompletionCron } from './orders-completion.cron';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [
    OrdersController,
    ItineraryOrdersController,
    OrderActionsController,
  ],
  providers: [OrdersService, OrdersCompletionCron],
})
export class OrdersModule {}
