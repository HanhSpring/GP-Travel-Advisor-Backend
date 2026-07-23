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
import { AdminReviewTimeLabelDto } from './dto/admin-review-time-label.dto';
import { AdminReviewHideDto } from './dto/admin-review-visibility.dto';

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
    enum: ['pending', 'approved', 'violation', 'hidden'],
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
  @ApiQuery({
    name: 'date_exact',
    required: false,
    type: String,
    description: 'Exact sent date in YYYY-MM-DD format',
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
    @Query('date_exact') dateExact?: string,
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
      dateExact,
      ratingNum,
    );
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

  @Put(':id/hide')
  @ApiOperation({ summary: 'Hide review with an admin-provided reason' })
  @ApiResponse({
    status: 200,
    description: 'Review hidden successfully',
  })
  async hideReview(
    @Param('id') id: string,
    @Body() dto: AdminReviewHideDto,
  ) {
    return this.service.hideReview(id, dto.reason);
  }

  @Put(':id/unhide')
  @ApiOperation({ summary: 'Make a hidden review visible again' })
  @ApiResponse({
    status: 200,
    description: 'Review made visible successfully',
  })
  async unhideReview(@Param('id') id: string) {
    return this.service.unhideReview(id);
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

  @Put(':id/time-label')
  @ApiOperation({ summary: 'Update review content time label' })
  @ApiResponse({
    status: 200,
    description: 'Review time label updated successfully',
  })
  async updateReviewTimeLabel(
    @Param('id') id: string,
    @Body() dto: AdminReviewTimeLabelDto,
  ) {
    return this.service.updateReviewTimeLabel(id, dto.time_label);
  }
}
