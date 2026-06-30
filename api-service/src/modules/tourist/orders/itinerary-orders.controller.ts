import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ItineraryOrderPlacesResponseDto } from './dto/itinerary-order-places-response.dto';
import { OrdersService } from './orders.service';

@ApiTags('Tourist Orders')
@Controller('itineraries/:itineraryId/order')
export class ItineraryOrdersController {
  constructor(private readonly service: OrdersService) {}

  @Get('places')
  @ApiOperation({
    summary:
      'Get itinerary places eligible for preorder popup (Cafe/Restaurant) in chronological order',
  })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiOkResponse({ type: ItineraryOrderPlacesResponseDto })
  getItineraryOrderPlaces(
    @Param('itineraryId') itineraryId: string,
    @Query('tourist_id') touristId: string,
  ) {
    return this.service.getItineraryOrderPlaces(itineraryId, touristId);
  }
}
