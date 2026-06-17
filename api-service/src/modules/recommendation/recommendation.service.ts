import { Injectable } from '@nestjs/common';
import { CreateItineraryDto } from '../itinerary/dto/create-itinerary.dto';
import { TwoTowerRetrievalResponseDto } from '../itinerary/dto/retrieval-response.dto';
import { DEFAULT_TWO_TOWER_RUNTIME_CONFIG, TwoTowerRuntimeConfig } from './two-tower-config.types';
import { RetrievalService } from './retrieval.service';
import { PlanningService } from './planning.service';

/**
 * Facade cho Recommendation module.
 * Kết hợp RetrievalService (Two Tower) và PlanningService (GA Planner) lại với nhau.
 */
@Injectable()
export class RecommendationService {
  constructor(
    private readonly retrievalService: RetrievalService,
    private readonly planningService: PlanningService,
  ) {}

  async retrieveCandidates(
    dto: CreateItineraryDto,
    topK = 100,
    config: TwoTowerRuntimeConfig = DEFAULT_TWO_TOWER_RUNTIME_CONFIG,
  ): Promise<TwoTowerRetrievalResponseDto> {
    return this.retrievalService.retrieveCandidates(dto, topK, config);
  }

  async planItinerary(dto: CreateItineraryDto, topK = 60): Promise<unknown> {
    return this.planningService.planItinerary(dto, topK);
  }
}
