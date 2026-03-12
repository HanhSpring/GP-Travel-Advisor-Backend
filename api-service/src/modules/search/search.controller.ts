import { Controller, Get, Query } from '@nestjs/common'
import { SearchService } from './search.service'
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger'

@ApiTags('Search')
@Controller('search')
export class SearchController {

  constructor(private readonly searchService: SearchService){}

  @Get()
  @ApiOperation({ summary: 'Search places by name' })
  @ApiQuery({ name: 'q', required: false })
  async search(@Query('q') q: string){
    return this.searchService.searchPlaces(q)
  }

}