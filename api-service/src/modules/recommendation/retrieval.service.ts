import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { supabase } from '../../config/supabase';
import { MlClientService } from './ml-client.service';
import { CreateItineraryDto } from '../itinerary/dto/create-itinerary.dto';
import { TwoTowerRetrievalResponseDto, CandidatePlaceDto } from '../itinerary/dto/retrieval-response.dto';
import { diversifyTopK, getStratifiedFetchPlan, PlaceCandidate, parseTripIntents, dedupeByPlaceIdKeepBestScore } from './utils/mmr-rerank';
import { resolveIntentVibe } from './utils/intent-vibe';
import { DEFAULT_TWO_TOWER_RUNTIME_CONFIG, TwoTowerRuntimeConfig } from './two-tower-config.types';

@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(private readonly mlClient: MlClientService) {}

  async retrieveCandidates(
    dto: CreateItineraryDto,
    topK = 100,
    config: TwoTowerRuntimeConfig = DEFAULT_TWO_TOWER_RUNTIME_CONFIG,
  ): Promise<TwoTowerRetrievalResponseDto> {
    const runtimeConfig = config.isActive ? config : DEFAULT_TWO_TOWER_RUNTIME_CONFIG;
    if (!config.isActive) {
      this.logger.warn('Two Tower config is inactive; using default runtime config for safety');
    }
    const safeTopK = Math.min(Math.max(Math.trunc(topK) || runtimeConfig.defaultTopK, 1), runtimeConfig.maxTopK);

    const cityName = await this.getCityName(dto.destinationLocationId);
    const numDays = this.calcNumDays(dto.startDate, dto.endDate);

    const selectedIntents = parseTripIntents(dto.tripIntent);
    const specificIntents = selectedIntents.filter((i) => i !== 'Khám phá tổng hợp');
    const rawIntents = specificIntents.length > 0 ? specificIntents : selectedIntents;
    const intents = rawIntents.length > 0 ? rawIntents.slice(0, runtimeConfig.maxIntents) : ['Khám phá tổng hợp'];
    const intentVibe = resolveIntentVibe(dto.adultCount, dto.childCount);

    this.logger.debug({ selectedIntents: intents, intentVibe, numDays, topK: safeTopK }, 'multi-intent late fusion retrieval');

    const allPools = await Promise.all(
      intents.map((intent) =>
        this.retrieveCandidatesForSingleIntent({
          dto, cityId: dto.destinationLocationId, cityName, intent, intentVibe, numDays, config: runtimeConfig,
        }),
      ),
    );

    const merged = dedupeByPlaceIdKeepBestScore(allPools.flat());
    this.logger.debug(`merged=${merged.length} final before diversify`);

    const diversePool = diversifyTopK(merged, numDays, intents.join(', '), safeTopK, {
      intentQuota: runtimeConfig.intentQuota,
      enableDiversityBudget: runtimeConfig.enableDiversityBudget,
    });
    this.logger.debug(`final=${diversePool.length}`);

    const candidates: CandidatePlaceDto[] = diversePool.map((c) => ({
      place_id: c.place_id,
      place_name: c.place_name,
      address: c.address,
      image_url: c.image_url,
      category: c.category,
      cosine_score: c.score,
      predict_ranking: null,
    }));

    return {
      destination_name: cityName,
      city_id: dto.destinationLocationId,
      total_candidates: candidates.length,
      candidates,
    };
  }

  private async retrieveCandidatesForSingleIntent(args: {
    dto: CreateItineraryDto; cityId: string; cityName: string; intent: string; intentVibe: string; numDays: number; config: TwoTowerRuntimeConfig;
  }): Promise<PlaceCandidate[]> {
    const { dto, cityId, cityName, intent, intentVibe, numDays, config } = args;

    let embedding: number[];
    try {
      embedding = await this.mlClient.encodeQuery({
        user_id: dto.userId, city: cityName, trip_intent: intent, intent_vibe: intentVibe, history_types: [], history_vibes: [], history_biz: [],
      });
    } catch (err: any) {
      throw new ServiceUnavailableException(`AI Service lỗi: ${err?.message ?? String(err)}`);
    }

    const fetchPlan = getStratifiedFetchPlan(intent, numDays, {
      intentQuota: config.intentQuota, fetchBufferMultiplier: config.fetchBufferMultiplier, enableAttractionTravelTypeFilter: config.enableAttractionTravelTypeFilter,
    });
    const poolChunks = await Promise.all(
      fetchPlan.map(({ slotType, limit, travelType }) => this.fetchBySlot(embedding, cityId, slotType, limit, travelType)),
    );

    const seenIds = new Set<string>();
    const pool: PlaceCandidate[] = [];
    for (const chunk of poolChunks) {
      for (const c of chunk) {
        if (!seenIds.has(c.place_id)) {
          seenIds.add(c.place_id);
          pool.push(c);
        }
      }
    }

    this.logger.debug(`intent=${intent} pool=${pool.length}`);
    return pool;
  }

  private calcNumDays(startDate: string, endDate: string): number {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
    return Math.max(1, days);
  }

  private async getCityName(cityId: string): Promise<string> {
    const { data, error } = await supabase.schema('travel').from('cities').select('name').eq('id', cityId).single();
    if (error || !data) throw new NotFoundException(`Không tìm thấy thành phố với id: ${cityId}`);
    return (data as any).name as string;
  }

  private async fetchBySlot(embedding: number[], cityId: string, slotType: string, limit: number, travelType?: string): Promise<PlaceCandidate[]> {
    const { data, error } = await supabase.rpc('recommend_places_by_slot', {
      query_embedding: `[${embedding.join(',')}]`, target_city_id: cityId, p_slot_type: slotType, p_limit: limit, p_travel_type: travelType ?? null,
    });

    if (error) {
      this.logger.error(`fetchBySlot [${slotType}] error: ${error.message}`);
      return [];
    }

    return (data ?? []) as PlaceCandidate[];
  }
}
