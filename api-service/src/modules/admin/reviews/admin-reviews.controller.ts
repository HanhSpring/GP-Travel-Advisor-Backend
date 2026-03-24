import {
  Controller,
  Get,
  Param,
  Put,
  Query,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { AdminReviewsService } from './admin-reviews.service';
import { AdminReviewListResponseDto } from './dto/admin-review-list.dto';
import { AdminReviewDetailDto } from './dto/admin-review-detail.dto';
import { AdminReviewActionDto } from './dto/admin-review-action.dto';

@ApiTags('Admin - Reviews')
@Controller('admin/reviews')
export class AdminReviewsController {
  constructor(private service: AdminReviewsService) {}

  @Get()
  @ApiOperation({ summary: 'Get reviews list with filtering' })
  @ApiResponse({
    status: 200,
    description: 'Reviews list retrieved successfully',
    type: AdminReviewListResponseDto,
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'approved', 'violation'],
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: ['newest', 'oldest', 'highest_rating', 'lowest_rating'],
  })
  @ApiQuery({
    name: 'classification',
    required: false,
    enum: ['short-term', 'long-term', 'need-action', 'unclassified'],
  })
  @ApiQuery({
    name: 'date_sent',
    required: false,
    enum: ['all', 'today', 'yesterday', 'last_7_days', 'last_30_days'],
  })
  @ApiQuery({ name: 'rating', required: false, enum: [1, 2, 3, 4, 5] })
  async getReviews(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('sort')
    sort?: 'newest' | 'oldest' | 'highest_rating' | 'lowest_rating',
    @Query('classification')
    classification?:
      | 'short-term'
      | 'long-term'
      | 'need-action'
      | 'unclassified',
    @Query('date_sent')
    dateSent?: 'all' | 'today' | 'yesterday' | 'last_7_days' | 'last_30_days',
    @Query('rating') rating?: string,
  ): Promise<AdminReviewListResponseDto> {
    const pageNum = page ? parseInt(page) : 1;
    const limitNum = limit ? parseInt(limit) : 10;
    const ratingNum = rating ? parseInt(rating) : undefined;

    if (isNaN(pageNum) || isNaN(limitNum)) {
      throw new BadRequestException('Page and limit must be valid numbers');
    }

    if (
      ratingNum !== undefined &&
      (Number.isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5)
    ) {
      throw new BadRequestException('Rating must be between 1 and 5');
    }

    return this.service.getReviews(
      pageNum,
      limitNum,
      search,
      status,
      sort,
      classification,
      dateSent,
      ratingNum,
    );
  }

  @Get('filters')
  @ApiOperation({ summary: 'Get filter options' })
  @ApiResponse({
    status: 200,
    description: 'Filter options retrieved successfully',
  })
  async getFilterOptions() {
    return this.service.getFilterOptions();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get review detail' })
  @ApiResponse({
    status: 200,
    description: 'Review detail retrieved successfully',
    type: AdminReviewDetailDto,
  })
  async getReviewDetail(
    @Param('id') id: string,
  ): Promise<AdminReviewDetailDto> {
    return this.service.getReviewDetail(id);
  }

  @Put(':id/approve')
  @ApiOperation({ summary: 'Approve review' })
  @ApiResponse({
    status: 200,
    description: 'Review approved successfully',
  })
  async approveReview(@Param('id') id: string) {
    return this.service.updateReviewStatus(id, 'approved');
  }

  @Put(':id/reject')
  @ApiOperation({ summary: 'Reject review as violation' })
  @ApiResponse({
    status: 200,
    description: 'Review rejected successfully',
  })
  async rejectReview(
    @Param('id') id: string,
    @Body() dto: AdminReviewActionDto,
  ) {
    if (dto.status !== 'violation') {
      throw new BadRequestException(
        'Only violation status is allowed for reject endpoint',
      );
    }
    return this.service.updateReviewStatus(id, 'violation', dto.reason);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update review status' })
  @ApiResponse({
    status: 200,
    description: 'Review status updated successfully',
  })
  async updateReviewStatus(
    @Param('id') id: string,
    @Body() dto: AdminReviewActionDto,
  ) {
    return this.service.updateReviewStatus(id, dto.status, dto.reason);
  }
}
