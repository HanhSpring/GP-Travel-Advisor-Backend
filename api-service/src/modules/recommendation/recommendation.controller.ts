import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { RecommendationService } from './recommendation.service';
import { CreateItineraryDto } from '../itinerary/dto/create-itinerary.dto';
import { TwoTowerRetrievalResponseDto } from '../itinerary/dto/retrieval-response.dto';

@ApiTags('Recommendation')
@Controller('recommendation')
export class RecommendationController {
  constructor(private readonly service: RecommendationService) {}

  /**
   * Two-Tower retrieval: encode query → pgvector → diversity-aware top-K candidates.
   * predict_ranking = null (sẽ được ranking model điền sau).
   */
  @Post('candidates')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Two-Tower retrieval — top-K địa điểm đa dạng theo loại',
    description:
      'Gọi FastAPI encode-query → pgvector search (pool = top_k × 3) → ' +
      'diversity selection theo INTENT_QUOTA + numDays → trả top-K candidates. ' +
      'predict_ranking = null, sẽ được ranking model điền sau.',
  })
  @ApiQuery({
    name: 'top_k',
    required: false,
    type: Number,
    example: 100,
    description: 'Số candidates tối đa (mặc định 100, tối đa 200)',
  })
  @ApiBody({
    type: CreateItineraryDto,
    examples: {
      default: {
        summary: 'Test mẫu — Vũng Tàu, Khám phá & Sinh thái, 5 ngày',
        value: {
          userId: '5f56692b-8daa-4852-bfe7-1032a07635ff',
          tripType: 'ROUND_TRIP',
          departureLocationId: 'SGN',
          destinationLocationId: 'fc51a18f-b4bb-5183-9d81-6a7e03a0ca4a',
          transportMode: 'AIRPLANE',
          startDate: '2024-06-15',
          endDate: '2024-06-20',
          dailyStartTime: '07:00',
          dailyEndTime: '23:00',
          tripIntent: 'Khám phá & Sinh thái',
          adultCount: 2,
          childCount: 1,
          budget: 7500000,
          foodPreferences: ['LOCAL', 'VEGETARIAN'],
          customFoodPreferences: ['Không ăn cay', 'Thích đồ ngọt'],
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'Top-K địa điểm đa dạng theo cosine similarity + diversity quota',
    type: TwoTowerRetrievalResponseDto,
  })
  async getCandidates(
    @Body() dto: CreateItineraryDto,
    @Query('top_k') topK?: string,
  ): Promise<TwoTowerRetrievalResponseDto> {
    const k = topK ? Math.min(parseInt(topK, 10) || 100, 200) : 100;
    return this.service.retrieveCandidates(dto, k);
  }
}
