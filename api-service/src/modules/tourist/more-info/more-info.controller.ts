import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { MoreInfoService } from './more-info.service';
import {
  TouristMoreInfoResponseDto,
  TouristOrderDetailResponseDto,
  TouristOrdersResponseDto,
} from './dto/tourist-more-info-response.dto';

@ApiTags('Tourist More Info')
@Controller('more-info')
export class MoreInfoController {
  constructor(private readonly service: MoreInfoService) {}

  @Get()
  @ApiOperation({ summary: 'Get data for tourist more-info side panel' })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiOkResponse({ type: TouristMoreInfoResponseDto })
  getMoreInfo(
    @Query('tourist_id') touristId: string,
  ): Promise<TouristMoreInfoResponseDto> {
    return this.service.getMoreInfo(touristId);
  }

  @Get('orders')
  @ApiOperation({ summary: 'Get all food orders for a tourist' })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiOkResponse({ type: TouristOrdersResponseDto })
  getOrders(
    @Query('tourist_id') touristId: string,
  ): Promise<TouristOrdersResponseDto> {
    return this.service.getOrders(touristId);
  }

  @Get('orders/:orderId')
  @ApiOperation({ summary: 'Get food order detail for a tourist' })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiOkResponse({ type: TouristOrderDetailResponseDto })
  getOrderDetail(
    @Param('orderId') orderId: string,
    @Query('tourist_id') touristId: string,
  ): Promise<TouristOrderDetailResponseDto> {
    return this.service.getOrderDetail(orderId, touristId);
  }
}
