import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminPlacesService } from './admin-places.service';
import { AdminPlaceListDto } from './dto/admin-place-list.dto';
import { AdminPlaceDetailDto } from './dto/admin-place-detail.dto';
import { AdminPlaceRejectRequestDto } from './dto/admin-place-approval.dto';

@ApiTags('Admin - Places Management')
@Controller('admin/places')
export class AdminPlacesController {
  constructor(private readonly service: AdminPlacesService) {}

  @Get()
  @ApiOperation({
    summary: 'Get list of places for admin',
    description: 'Retrieve places with pagination and status filter',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by status: all, pending, approved, rejected',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by place name and submitter name (accent-insensitive)',
  })
  @ApiQuery({
    name: 'category_name',
    required: false,
    description: 'Filter by category name',
  })
  @ApiQuery({
    name: 'vendor_id',
    required: false,
    description: 'Filter by vendor user ID',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Items per page (default: 10)',
  })
  @ApiResponse({
    status: 200,
    description: 'List of places retrieved successfully',
    type: AdminPlaceListDto,
  })
  async getPlaces(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('category_name') categoryName?: string,
    @Query('vendor_id') vendorId?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    return this.service.getPlaces(
      status as 'all' | 'pending' | 'approved' | 'rejected',
      pageNum,
      limitNum,
      search,
      categoryName,
      vendorId,
    );
  }

  @Get('categories')
  @ApiOperation({
    summary: 'Get place categories for admin filters',
    description: 'Return available categories for the category filter dropdown',
  })
  async getPlaceCategories() {
    return this.service.getPlaceCategories();
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Get place statistics for admin dashboard',
    description: 'Return total, pending, and current month place counts',
  })
  async getPlaceStats() {
    return this.service.getPlaceStats();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get place detail for admin',
    description:
      'Retrieve complete place information including vendor and recent reviews (readonly)',
  })
  @ApiResponse({
    status: 200,
    description: 'Place details retrieved successfully',
    type: AdminPlaceDetailDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Place not found',
  })
  async getPlaceDetail(@Param('id') id: string) {
    return this.service.getPlaceDetail(id);
  }

  @Patch(':id/approve')
  @ApiOperation({
    summary: 'Approve a place',
    description: 'Mark a place as approved',
  })
  @ApiResponse({
    status: 200,
    description: 'Place approved successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Place not found',
  })
  async approvePlace(@Param('id') id: string) {
    return this.service.approvePlace(id);
  }

  @Patch(':id/reject')
  @ApiOperation({
    summary: 'Reject a place',
    description:
      'Mark a place as rejected/unapproved. Optional note is returned only, not saved yet.',
  })
  @ApiResponse({
    status: 200,
    description: 'Place rejected successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Place not found',
  })
  async rejectPlace(
    @Param('id') id: string,
    @Body() body: AdminPlaceRejectRequestDto,
  ) {
    return this.service.rejectPlace(id, body?.note);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a place',
    description: 'Permanently delete a place by ID',
  })
  @ApiResponse({ status: 204, description: 'Place deleted successfully' })
  @ApiResponse({ status: 404, description: 'Place not found' })
  async deletePlace(@Param('id') id: string) {
    return this.service.deletePlace(id);
  }
}
