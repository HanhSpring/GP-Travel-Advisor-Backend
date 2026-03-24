import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BusinessPlacesService } from './business-places.service';
import { BusinessPlaceListResponseDto } from './dto/business-place.dto';

@ApiTags('Business - Places')
@Controller('business/places')
export class BusinessPlacesController {
  constructor(private readonly service: BusinessPlacesService) {}

  @Get()
  @ApiOperation({ summary: 'Get business place list for management screen' })
  @ApiQuery({ name: 'vendor_id', required: true })
  @ApiQuery({ name: 'page', required: false, description: 'Default: 1' })
  @ApiQuery({ name: 'limit', required: false, description: 'Default: 10' })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'all | pending | approved | rejected',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by place name',
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    description: 'default | popular | newest',
  })
  @ApiResponse({ status: 200, type: BusinessPlaceListResponseDto })
  getPlaces(
    @Query('vendor_id') vendorId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: 'all' | 'pending' | 'approved' | 'rejected',
    @Query('search') search?: string,
    @Query('sort') sort?: 'default' | 'popular' | 'newest',
  ) {
    return this.service.getPlaces(
      vendorId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 10,
      status ?? 'all',
      search,
      sort ?? 'default',
    );
  }
}
