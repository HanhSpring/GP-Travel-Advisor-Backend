import { BadRequestException, Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminReviewActionDto } from '../reviews/dto/admin-review-action.dto';
import { AdminItineraryReviewListResponseDto } from './dto/admin-itinerary-review-list.dto';
import { AdminItineraryReviewsService } from './admin-itinerary-reviews.service';

@ApiTags('Admin - Itinerary Reviews')
@Controller('admin/itinerary-reviews')
export class AdminItineraryReviewsController {
  constructor(private readonly service: AdminItineraryReviewsService) {}

  @Get()
  @ApiOperation({ summary: 'Get itinerary reviews list with filtering' })
  @ApiResponse({
    status: 200,
    description: 'Itinerary reviews list retrieved successfully',
    type: AdminItineraryReviewListResponseDto,
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['pending', 'approved', 'violation'] })
  @ApiQuery({ name: 'sort', required: false, enum: ['newest', 'oldest', 'highest_rating', 'lowest_rating'] })
  @ApiQuery({ name: 'date_sent', required: false, enum: ['all', 'today', 'yesterday', 'last_7_days', 'last_30_days'] })
  @ApiQuery({ name: 'date_exact', required: false, type: String, description: 'Exact sent date in YYYY-MM-DD format' })
  @ApiQuery({ name: 'rating', required: false, enum: [1, 2, 3, 4, 5] })
  async getReviews(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('sort') sort?: 'newest' | 'oldest' | 'highest_rating' | 'lowest_rating',
    @Query('date_sent') dateSent?: 'all' | 'today' | 'yesterday' | 'last_7_days' | 'last_30_days',
    @Query('date_exact') dateExact?: string,
    @Query('rating') rating?: string,
  ): Promise<AdminItineraryReviewListResponseDto> {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    const ratingNum = rating ? parseInt(rating, 10) : undefined;

    if (Number.isNaN(pageNum) || Number.isNaN(limitNum)) {
      throw new BadRequestException('Page and limit must be valid numbers');
    }

    if (ratingNum !== undefined && (Number.isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5)) {
      throw new BadRequestException('Rating must be between 1 and 5');
    }

    return this.service.getReviews(
      pageNum,
      limitNum,
      search,
      status,
      sort,
      dateSent,
      dateExact,
      ratingNum,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get itinerary review detail by ID' })
  @ApiResponse({ status: 200, description: 'Itinerary review detail retrieved successfully' })
  async getReviewById(@Param('id') id: string) {
    return this.service.getReviewById(id);
  }

  @Put(':id/approve')
  @ApiOperation({ summary: 'Approve itinerary review' })
  @ApiResponse({ status: 200, description: 'Itinerary review approved successfully' })
  async approveReview(@Param('id') id: string) {
    return this.service.approveReview(id);
  }

  @Put(':id/reject')
  @ApiOperation({ summary: 'Reject itinerary review as violation' })
  @ApiResponse({ status: 200, description: 'Itinerary review rejected successfully' })
  async rejectReview(@Param('id') id: string, @Body() dto: AdminReviewActionDto) {
    if (dto.status !== 'violation') {
      throw new BadRequestException('Only violation status is allowed for reject endpoint');
    }

    return this.service.rejectReview(id, dto.reason);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update itinerary review status' })
  @ApiResponse({ status: 200, description: 'Itinerary review status updated successfully' })
  async updateReviewStatus(@Param('id') id: string, @Body() dto: AdminReviewActionDto) {
    return this.service.updateReviewStatus(id, dto.status, dto.reason);
  }
}
