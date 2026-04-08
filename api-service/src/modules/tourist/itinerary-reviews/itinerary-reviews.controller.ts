import { Controller, Get, Param, Post, Query, Body } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  ItineraryReviewDetailResponseDto,
  ItineraryReviewPopupResponseDto,
} from './dto/itinerary-review-response.dto';
import { SubmitItineraryReviewDto } from './dto/submit-itinerary-review.dto';
import { ItineraryReviewsService } from './itinerary-reviews.service';

type SubmitReviewResponse = {
  success: boolean;
  itinerary_review_id: string;
  saved_place_reviews: number;
  saved_media_count: number;
  message: string;
};

@ApiTags('Tourist Itinerary Reviews')
@Controller('itinerary-reviews')
export class ItineraryReviewsController {
  constructor(private readonly service: ItineraryReviewsService) {}

  @Get('popup')
  @ApiOperation({
    summary: 'Get popup data for itinerary review after trip completion',
  })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiQuery({ name: 'itinerary_id', required: true, type: String })
  @ApiOkResponse({ type: ItineraryReviewPopupResponseDto })
  getPopup(
    @Query('tourist_id') touristId: string,
    @Query('itinerary_id') itineraryId: string,
  ): Promise<ItineraryReviewPopupResponseDto> {
    return this.service.getPopup(touristId, itineraryId);
  }

  @Get(':itineraryId/detail')
  @ApiOperation({ summary: 'Get detailed itinerary review screen data' })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiOkResponse({ type: ItineraryReviewDetailResponseDto })
  getDetail(
    @Param('itineraryId') itineraryId: string,
    @Query('tourist_id') touristId: string,
  ): Promise<ItineraryReviewDetailResponseDto> {
    return this.service.getDetail(touristId, itineraryId);
  }

  @Post(':itineraryId/submit')
  @ApiOperation({
    summary: 'Submit itinerary review from popup or detailed review screen',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        success: true,
        itinerary_review_id: '67cd8f10-7a59-4d03-8d60-eb4dfbd14f44',
        saved_place_reviews: 3,
      },
    },
  })
  submitReview(
    @Param('itineraryId') itineraryId: string,
    @Body() body: SubmitItineraryReviewDto,
  ): Promise<SubmitReviewResponse> {
    return this.service.submitReview(body.tourist_id, itineraryId, body);
  }
}
