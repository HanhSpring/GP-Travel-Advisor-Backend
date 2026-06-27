import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
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
  ItineraryReviewSummaryResponseDto,
  ItinerarySubmittedReviewResponseDto,
} from './dto/itinerary-review-response.dto';
import { SubmitItineraryReviewDto } from './dto/submit-itinerary-review.dto';
import { ItineraryReviewsService } from './itinerary-reviews.service';

type SubmitReviewResponse = {
  success: boolean;
  itinerary_review_id: string | null;
  saved_place_reviews: number;
  saved_media_count: number;
  message: string;
};

@ApiTags('Tourist Itinerary Reviews')
@Controller('itinerary-reviews')
export class ItineraryReviewsController {
  private readonly logger = new Logger(ItineraryReviewsController.name);

  constructor(private readonly service: ItineraryReviewsService) {}

  private logApiError(
    route: string,
    error: unknown,
    context: Record<string, unknown>,
  ) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    this.logger.error(
      `${route} failed: ${message} | context=${JSON.stringify(context)}`,
      stack,
    );
  }

  @Get('popup')
  @ApiOperation({
    summary: 'Get popup data for itinerary review after trip completion',
  })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiQuery({ name: 'itinerary_id', required: true, type: String })
  @ApiOkResponse({ type: ItineraryReviewPopupResponseDto })
  async getPopup(
    @Query('tourist_id') touristId: string,
    @Query('itinerary_id') itineraryId: string,
  ): Promise<ItineraryReviewPopupResponseDto> {
    try {
      return await this.service.getPopup(touristId, itineraryId);
    } catch (error) {
      this.logApiError('GET /itinerary-reviews/popup', error, {
        touristId,
        itineraryId,
      });
      throw error;
    }
  }

  @Get(':itineraryId/review-detail')
  @ApiOperation({
    summary: 'Get itinerary review detail for read-only display',
  })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiOkResponse({ type: ItinerarySubmittedReviewResponseDto })
  async getReviewDetail(
    @Param('itineraryId') itineraryId: string,
    @Query('tourist_id') touristId: string,
  ): Promise<ItinerarySubmittedReviewResponseDto> {
    try {
      return await this.service.getSubmittedReview(touristId, itineraryId);
    } catch (error) {
      this.logApiError(
        'GET /itinerary-reviews/:itineraryId/review-detail',
        error,
        {
          touristId,
          itineraryId,
        },
      );
      throw error;
    }
  }
  @Get(':itineraryId/summary')
  @ApiOperation({
    summary:
      'Get itinerary review summary (rating + content) for popup mode check',
  })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiOkResponse({ type: ItineraryReviewSummaryResponseDto })
  async getSummary(
    @Param('itineraryId') itineraryId: string,
    @Query('tourist_id') touristId: string,
  ): Promise<ItineraryReviewSummaryResponseDto> {
    try {
      return await this.service.getSummary(touristId, itineraryId);
    } catch (error) {
      this.logApiError('GET /itinerary-reviews/:itineraryId/summary', error, {
        touristId,
        itineraryId,
      });
      throw error;
    }
  }

  @Get(':itineraryId/detail')
  @ApiOperation({ summary: 'Get detailed itinerary review screen data' })
  @ApiQuery({ name: 'tourist_id', required: true, type: String })
  @ApiOkResponse({ type: ItineraryReviewDetailResponseDto })
  async getDetail(
    @Param('itineraryId') itineraryId: string,
    @Query('tourist_id') touristId: string,
  ): Promise<ItineraryReviewDetailResponseDto> {
    try {
      return await this.service.getDetail(touristId, itineraryId);
    } catch (error) {
      this.logApiError('GET /itinerary-reviews/:itineraryId/detail', error, {
        touristId,
        itineraryId,
      });
      throw error;
    }
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
  async submitReview(
    @Param('itineraryId') itineraryId: string,
    @Body() body: SubmitItineraryReviewDto,
  ): Promise<SubmitReviewResponse> {
    try {
      return await this.service.submitReview(
        body.tourist_id,
        itineraryId,
        body,
      );
    } catch (error) {
      this.logApiError('POST /itinerary-reviews/:itineraryId/submit', error, {
        touristId: body.tourist_id,
        itineraryId,
        itineraryMediaCount: body.media?.length ?? 0,
        placeReviewCount: body.place_reviews?.length ?? 0,
        placeMediaCount:
          body.place_reviews?.reduce(
            (total, item) => total + (item.media?.length ?? 0),
            0,
          ) ?? 0,
      });
      throw error;
    }
  }
}
