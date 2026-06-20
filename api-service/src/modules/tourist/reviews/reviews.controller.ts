import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
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
