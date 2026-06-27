import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { OrdersService } from './orders.service';

@ApiTags('Order Email Actions')
@Controller('order-actions')
export class OrderActionsController {
  constructor(private readonly service: OrdersService) {}

  @Get(':token')
  @ApiOperation({ summary: 'Handle order status action from restaurant email link' })
  @ApiQuery({
    name: 'action',
    required: true,
    description: 'confirm | complete | cancel',
  })
  handleAction(
    @Param('token') token: string,
    @Query('action') action: string,
  ) {
    return this.service.handleOrderEmailAction(token, action);
  }
}
