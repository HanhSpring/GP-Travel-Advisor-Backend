import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { PlacesService } from './places.service';
import {
  PlaceDetailResponseDto,
  PlaceFoodItemsResponseDto,
  PlaceReviewsResponseDto,
} from './dto/place-detail-response.dto';

@ApiTags('Tourist Places')
@Controller('places')
export class PlacesController {
  constructor(private readonly service: PlacesService) {}

  @Get(':id/food-items')
  @ApiOperation({ summary: 'Get food items for a tourist place' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ type: PlaceFoodItemsResponseDto })
  getPlaceFoodItems(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<PlaceFoodItemsResponseDto> {
    return this.service.getPlaceFoodItems(
      id,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 10,
    );
  }

  @Get(':id/reviews')
  @ApiOperation({ summary: 'Get place reviews with pagination' })
  @ApiQuery({ name: 'tourist_id', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ type: PlaceReviewsResponseDto })
  getPlaceReviews(
    @Param('id') id: string,
    @Query('tourist_id') touristId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<PlaceReviewsResponseDto> {
    return this.service.getPlaceReviews(
      id,
      touristId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 10,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get tourist place detail by place ID' })
  @ApiQuery({ name: 'tourist_id', required: false, type: String })
  @ApiOkResponse({ type: PlaceDetailResponseDto })
  getPlaceDetail(
    @Param('id') id: string,
    @Query('tourist_id') touristId?: string,
  ) {
    return this.service.getPlaceDetail(id, touristId);
  }
}
