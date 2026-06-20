import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { ReviewResponseDto } from './dto/review-response.dto';

@ApiTags('Tourist Reviews')
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Get()
  @ApiOperation({
    summary: 'List pending and submitted itinerary/place reviews',
  })
  @ApiQuery({ name: 'tourist_id', required: true })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'reviewed', 'all'],
  })
  @ApiOkResponse({ type: Object })
  getReviews(
    @Query('tourist_id') touristId: string,
    @Query('status') status = 'all',
  ) {
    return this.reviewsService.getReviewCatalog(touristId, status);
  }

  @Get(':reviewId')
  @ApiOperation({ summary: 'Get a submitted place review' })
  @ApiQuery({ name: 'tourist_id', required: true })
  getReview(
    @Param('reviewId') reviewId: string,
    @Query('tourist_id') touristId: string,
  ) {
    return this.reviewsService.getReview(reviewId, touristId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new review for a place' })
  @ApiCreatedResponse({ type: ReviewResponseDto })
  async createReview(@Body() body: CreateReviewDto) {
    return this.reviewsService.createReview(body);
  }
}
