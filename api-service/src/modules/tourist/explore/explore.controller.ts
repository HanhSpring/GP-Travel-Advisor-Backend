import { Controller, Get, Param, Patch, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  ExplorePlacesResponseDto,
  ExplorePublicItinerariesResponseDto,
  ExploreResponseDto,
  StartItineraryResponseDto,
} from './dto/explore-response.dto';
import { ExploreService } from './explore.service';

@ApiTags('Tourist Explore')
@Controller('explore')
export class ExploreController {
  constructor(private readonly service: ExploreService) {}

  @Get('home')
  @ApiOperation({ summary: 'Get data for explore home screen' })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiOkResponse({ type: ExploreResponseDto })
  getExploreHome(@Query('tourist_id') touristId: string) {
    return this.service.getExploreHome(touristId);
  }

  @Patch('itineraries/:itineraryId/start')
  @ApiOperation({ summary: 'Set itinerary status to ongoing' })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiOkResponse({ type: StartItineraryResponseDto })
  startItinerary(
    @Param('itineraryId') itineraryId: string,
    @Query('tourist_id') touristId: string,
  ) {
    return this.service.startItinerary(touristId, itineraryId);
  }

  @Get('itineraries/public')
  @ApiOperation({ summary: 'Get public itineraries for suggestions/view-all' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ type: ExplorePublicItinerariesResponseDto })
  getPublicItineraries(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getPublicItineraries(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 5,
    );
  }

  @Get('places')
  @ApiOperation({
    summary:
      'Get featured places or places by category (lưu trú, ẩm thực, etc.)',
  })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ type: ExplorePlacesResponseDto })
  getPlaces(
    @Query('category') category?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getPlacesByCategory(
      category,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 5,
    );
  }

  @Get('cities')
  @ApiOperation({ summary: 'Get featured cities for explore section' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getFeaturedCities(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getFeaturedCities(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 5,
    );
  }

  @Get('cities/:cityId/overview')
  @ApiOperation({ summary: 'Get city overview data for city detail screen' })
  getCityOverview(@Param('cityId') cityId: string) {
    return this.service.getCityOverview(cityId);
  }
}
