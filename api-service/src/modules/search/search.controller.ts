import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { SearchService } from './search.service'
import { SearchQueryDto } from './dto/search.dto'
import { AutocompleteItemDto } from './dto/search-response.dto'
import { SearchFilterDto } from './dto/search-filter.dto'
import { Controller, Get, Query } from '@nestjs/common'

@ApiTags('Search')
@Controller('search')
export class SearchController {

  constructor(private readonly service: SearchService) { }

  @Get('autocomplete')
  @ApiOperation({ summary: 'Search autocomplete (suggestions)' })
  @ApiResponse({ type: [AutocompleteItemDto] })
  autocomplete(@Query() query: SearchQueryDto) {
    return this.service.autocomplete(query.q)
  }

  @Get('filter')
  @ApiOperation({ summary: 'Filter places by city and category' })
  getPlacesByFilter(@Query() query: SearchFilterDto) {
    return this.service.getPlacesByFilter(
      query.city,
      query.category
    )
  }

  @Get('nearby')
  @ApiOperation({ summary: 'Get nearby places based on lat, lng' })
  getNearbyPlaces(
    @Query('lat') lat: number,
    @Query('lng') lng: number,
    @Query('limit') limit?: number,
    @Query('excludeIds') excludeIds?: string,
    @Query('preferCategory') preferCategory?: string,
    @Query('radius') radius?: number,
  ) {
    const ids = excludeIds ? excludeIds.split(',').filter(Boolean) : [];
    return this.service.getNearbyPlaces(
      Number(lat),
      Number(lng),
      limit ? Number(limit) : 20,
      ids,
      preferCategory ?? '',
      radius ? Number(radius) : 10,
    );
  }
}