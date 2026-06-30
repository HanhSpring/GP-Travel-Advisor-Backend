import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../../../common/decorators/roles.decorator';
import { Role } from '../../../common/enum/role.enum';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { ReviewResponseDto } from './dto/review-response.dto';

@ApiTags('Tourist Reviews')
@Controller('reviews')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TOURIST)
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
  async createReview(@Req() req: any, @Body() body: CreateReviewDto) {
    return this.reviewsService.createReview({
      ...body,
      tourist_id: req.user.userId,
    });
  }
}
