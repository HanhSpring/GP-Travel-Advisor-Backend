import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BusinessReviewsService } from './business-reviews.service';
import { BusinessReviewsResponseDto } from './dto/business-review.dto';

@ApiTags('Business - Reviews')
@Controller('business/reviews')
export class BusinessReviewsController {
  constructor(private readonly service: BusinessReviewsService) {}

  @Get(':place_id')
  @ApiOperation({
    summary: 'Get review dashboard data for a business place',
  })
  @ApiQuery({ name: 'vendor_id', required: true })
  @ApiQuery({ name: 'page', required: false, description: 'Default: 1' })
  @ApiQuery({ name: 'limit', required: false, description: 'Default: 10' })
  @ApiQuery({ name: 'rating', required: false, description: '1..5' })
  @ApiQuery({
    name: 'sort',
    required: false,
    description: 'newest | oldest | highest_rating | lowest_rating',
  })
  @ApiQuery({ name: 'topic', required: false })
  @ApiQuery({
    name: 'has_images',
    required: false,
    description: 'true/false',
  })
  @ApiResponse({ status: 200, type: BusinessReviewsResponseDto })
  getReviews(
    @Param('place_id') placeId: string,
    @Query('vendor_id') vendorId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('rating') rating?: string,
    @Query('sort')
    sort?: 'newest' | 'oldest' | 'highest_rating' | 'lowest_rating',
    @Query('topic') topic?: string,
    @Query('has_images') hasImages?: string,
  ) {
    const parsedRating = rating ? parseInt(rating, 10) : undefined;
    const parsedHasImages =
      hasImages === undefined ? undefined : hasImages === 'true';

    return this.service.getReviews(
      placeId,
      vendorId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 10,
      parsedRating,
      sort ?? 'newest',
      topic,
      parsedHasImages,
    );
  }
}
