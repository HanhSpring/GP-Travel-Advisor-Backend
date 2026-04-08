import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { OrderFoodItemsResponseDto } from './dto/order-food-items-response.dto';
import { OrderPopupResponseDto } from './dto/order-popup-response.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreateOrderResponseDto } from './dto/create-order-response.dto';
import { OrdersService } from './orders.service';

@ApiTags('Tourist Orders')
@Controller('places/:placeId/order')
export class OrdersController {
  constructor(private readonly service: OrdersService) {}

  @Get('popup')
  @ApiOperation({
    summary: 'Get popup data for quick food ordering suggestion',
  })
  @ApiOkResponse({ type: OrderPopupResponseDto })
  getOrderPopup(@Param('placeId') placeId: string) {
    return this.service.getOrderPopup(placeId);
  }

  @Get('items')
  @ApiOperation({
    summary: 'Get food items for a place order screen',
  })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'category',
    required: false,
    description: 'all | main | drink',
    type: String,
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ type: OrderFoodItemsResponseDto })
  getFoodItems(
    @Param('placeId') placeId: string,
    @Query('search') search?: string,
    @Query('category') category?: 'all' | 'main' | 'drink',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getFoodItems(
      placeId,
      search,
      category ?? 'all',
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @Post()
  @ApiOperation({ summary: 'Create preorder for selected food items' })
  @ApiOkResponse({ type: CreateOrderResponseDto })
  createOrder(@Param('placeId') placeId: string, @Body() body: CreateOrderDto) {
    return this.service.createOrder(placeId, body);
  }
}
