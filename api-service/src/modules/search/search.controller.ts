import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { SearchService } from './search.service'
import { SearchQueryDto } from './dto/search.dto'
import { AutocompleteItemDto, SearchResultDto } from './dto/search-response.dto'
import { SearchFilterDto } from './dto/search-filter.dto'
import {
  Controller,
  Get,
  Query,
  Post,
  Body,
  UploadedFile,
  UseInterceptors
} from '@nestjs/common'

import { FileInterceptor } from '@nestjs/platform-express'

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
}