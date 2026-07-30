import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search.dto';
import { AutocompleteItemDto } from './dto/search-response.dto';
import { SearchFilterDto } from './dto/search-filter.dto';
import { Controller, Get, Query } from '@nestjs/common';

@ApiTags('Search')
@Controller('search')
export class SearchController {
  constructor(private readonly service: SearchService) {}

  @Get('autocomplete')
  @ApiOperation({ summary: 'Search autocomplete (suggestions)' })
  @ApiResponse({ type: [AutocompleteItemDto] })
  autocomplete(@Query() query: SearchQueryDto) {
    return this.service.autocomplete(query.q);
  }

  @Get('filter')
  @ApiOperation({ summary: 'Filter places by city and category' })
  getPlacesByFilter(@Query() query: SearchFilterDto) {
    return this.service.getPlacesByFilter(query.city, query.category);
  }

  @Get('all')
  @ApiOperation({
    summary:
      'Search all types (itinerary, activity, restaurant, hotel) — top 10 each',
  })
  searchAll(@Query('q') q: string) {
    return this.service.searchAll(q ?? '');
  }

  @Get('results')
  @ApiOperation({ summary: 'Paginated search for one type' })
  searchByType(
    @Query('q') q: string,
    @Query('type') type: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.searchByType(
      q ?? '',
      type ?? 'activity',
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 10,
    );
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
    @Query('q') q?: string,
    @Query('city') city?: string,
  ) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ids = excludeIds ? excludeIds.split(',').filter(id => Boolean(id) && uuidRegex.test(id)) : [];
    return this.service.getNearbyPlaces(
      Number(lat),
      Number(lng),
      limit ? Number(limit) : 20,
      ids,
      preferCategory ?? '',
      radius ? Number(radius) : 10,
      q,
      city,
    );
  }
}
