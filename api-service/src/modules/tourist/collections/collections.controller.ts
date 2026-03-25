import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  CollectionsHomeResponseDto,
  FavoritePlacesResponseDto,
  FavoriteItinerariesResponseDto,
} from './dto/collection-response.dto';
import { CollectionsService } from './collections.service';

@ApiTags('Tourist Collections')
@Controller('collections')
export class CollectionsController {
  constructor(private readonly service: CollectionsService) {}

  @Get()
  @ApiOperation({ summary: 'Get collections home screen data' })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiOkResponse({ type: CollectionsHomeResponseDto })
  getCollectionsHome(@Query('tourist_id') touristId: string) {
    return this.service.getCollectionsHome(touristId);
  }

  @Get('itineraries')
  @ApiOperation({ summary: 'Get all favorite itineraries with pagination' })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ type: FavoriteItinerariesResponseDto })
  getFavoriteItineraries(
    @Query('tourist_id') touristId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getFavoriteItineraries(
      touristId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 5,
    );
  }

  @Get('places')
  @ApiOperation({ summary: 'Get all favorite places with pagination' })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ type: FavoritePlacesResponseDto })
  getFavoritePlaces(
    @Query('tourist_id') touristId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getFavoritePlaces(
      touristId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 5,
    );
  }
}
