import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { supabase } from '../../config/supabase';
import { ItineraryPlanPayload, MlClientService } from './ml-client.service';
import { CreateItineraryDto } from '../itinerary/dto/create-itinerary.dto';
import {
  TwoTowerRetrievalResponseDto,
  CandidatePlaceDto,
} from '../itinerary/dto/retrieval-response.dto';
import { diversifyTopK, getStratifiedFetchPlan, PlaceCandidate } from './utils/mmr-rerank';

@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);
  private readonly foodCategoryId = '97029cfb-069b-4dba-a152-dfb3d36634d3';

  constructor(private readonly mlClient: MlClientService) {}

  /**
   * Two-Tower retrieval pipeline (khớp notebook retrieve_diverse_topk):
   *   1. Encode query embedding
   *   2. Tính số ngày → slot limits
   *   3. Gọi recommend_places_by_slot riêng cho từng slot (song song)
   *      - Slot filter TRƯỚC, ANN search TRONG pool đó
   *   4. Gộp kết quả → diversifyTopK lấy top theo quota
   */
  async retrieveCandidates(
    dto: CreateItineraryDto,
    topK = 100,
  ): Promise<TwoTowerRetrievalResponseDto> {
    // ── 1. City name ──────────────────────────────────────────────────────────
    const cityName = await this.getCityName(dto.destinationLocationId);

    // ── 2. Encode query via FastAPI Two-Tower ─────────────────────────────────
    let embedding: number[];
    try {
      embedding = await this.mlClient.encodeQuery({
        user_id: dto.userId,
        city: cityName,
        trip_intent: dto.tripIntent,
        intent_vibe: '',
        history_types: [],
        history_vibes: [],
        history_biz: [],
      });
    } catch (err: any) {
      const detail = err?.message ?? String(err);
      throw new ServiceUnavailableException(`AI Service lỗi: ${detail}`);
    }

    // ── 3. Tính số ngày ───────────────────────────────────────────────────────
    const numDays = this.calcNumDays(dto.startDate, dto.endDate);

    // ── 4. Stratified slot fetch — mỗi slot 1 RPC call (song song) ───────────
    //    Slot filter TRƯỚC, ANN trong pool đó → đảm bảo đa dạng như notebook
    const fetchPlan = getStratifiedFetchPlan(dto.tripIntent, numDays);
    const poolChunks = await Promise.all(
      fetchPlan.map(({ slotType, limit, travelType }) =>
        this.fetchBySlot(embedding, dto.destinationLocationId, slotType, limit, travelType),
      ),
    );

    // ── 5. Gộp + deduplicate ──────────────────────────────────────────────────
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

    this.logger.debug(
      `Pool: ${pool.length} places (${fetchPlan.map(p => `${p.slotType}:${p.limit / 2}`).join(', ')})`,
    );

    // ── 6. Diversity-aware top-K (phase 2 fill nếu 1 slot thiếu) ─────────────
    const diversePool = diversifyTopK(pool, numDays, dto.tripIntent, topK);

    // ── 7. Map → response DTO ─────────────────────────────────────────────────
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

  async planItinerary(dto: CreateItineraryDto, topK = 60): Promise<unknown> {
    const numDays = this.calcNumDays(dto.startDate, dto.endDate);
    const retrieval = await this.retrieveCandidates(dto, topK);
    const plannerCandidates = retrieval.candidates;
    const details = await this.fetchPlannerPlaceDetails(plannerCandidates);
    if (!details.length) {
      throw new NotFoundException('No place details found for itinerary planning');
    }
    if (!details.some((place) => place.place_type === 'hotel')) {
      throw new NotFoundException(
        'No real hotel/accommodation candidate found for itinerary planning',
      );
    }

    this.logger.warn(
      `Planning with ${details.length}/${retrieval.candidates.length} candidates ` +
        `(days=${numDays}, retrievalTopK=${topK}, plannerCap=none)`,
    );
    this.logger.warn(
      `Planner candidate mix: ${this.formatPlaceTypeCounts(details)} ` +
        `(retrieval mix: ${this.formatCandidateCounts(retrieval.candidates)})`,
    );

    const payload: ItineraryPlanPayload = {
      places: details,
      num_days: numDays,
      daily_start_time: dto.dailyStartTime,
      daily_end_time: dto.dailyEndTime,
      use_goong: true,
      travel_vehicle: this.resolveGoongVehicle(dto.transportMode),
      population_size: 50,
      generations: 120,
      mutation_rate: 0.3,
      seed: 42,
    };

    try {
      return await this.mlClient.planItinerary(payload);
    } catch (err: any) {
      const detail = err?.message ?? String(err);
      throw new ServiceUnavailableException(`AI Service error: ${detail}`);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private calcNumDays(startDate: string, endDate: string): number {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const days =
      Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
    return Math.max(1, days);
  }

  private async getCityName(cityId: string): Promise<string> {
    const { data, error } = await supabase
      .schema('travel')
      .from('cities')
      .select('name')
      .eq('id', cityId)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Không tìm thấy thành phố với id: ${cityId}`);
    }
    return (data as any).name as string;
  }

  /**
   * Gọi RPC recommend_places_by_slot — filter slot_type TRƯỚC, ANN search TRONG pool đó.
   * travelType chỉ truyền cho attraction (filter theo trip_intent của user).
   */
  private async fetchBySlot(
    embedding: number[],
    cityId: string,
    slotType: string,
    limit: number,
    travelType?: string,
  ): Promise<PlaceCandidate[]> {
    const { data, error } = await supabase.rpc('recommend_places_by_slot', {
      query_embedding: `[${embedding.join(',')}]`,
      target_city_id: cityId,
      p_slot_type: slotType,
      p_limit: limit,
      p_travel_type: travelType ?? null,
    });

    if (error) {
      this.logger.error(`fetchBySlot [${slotType}] error: ${error.message}`);
      return [];
    }

    return (data ?? []) as PlaceCandidate[];
  }

  private async fetchPlannerPlaceDetails(
    candidates: CandidatePlaceDto[],
  ): Promise<ItineraryPlanPayload['places']> {
    const candidateById = new Map(
      candidates.map((candidate) => [candidate.place_id, candidate]),
    );
    const ids = candidates.map((candidate) => candidate.place_id);
    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .select(
        'id,name,longitude,latitude,open_hour_compressed,source,type_id,visit_duration,average_rating,types(name,categories(id,name))',
      )
      .in('id', ids);

    if (error) {
      this.logger.error(`fetchPlannerPlaceDetails error: ${error.message}`);
      return [];
    }

    return (data ?? [])
      .filter((row: any) => row.longitude != null && row.latitude != null)
      .map((row: any) => {
        const candidate = candidateById.get(row.id);
        const typeData = Array.isArray(row.types) ? row.types[0] : row.types;
        const categoryData = Array.isArray(typeData?.categories)
          ? typeData.categories[0]
          : typeData?.categories;
        const categoryId = categoryData?.id ?? null;
        const categoryName = categoryData?.name ?? null;
        const candidateCategory = candidate?.category ?? null;
        const placeType = this.resolvePlannerPlaceType(
          candidateCategory,
          categoryId,
          categoryName,
        );
        return {
          id: row.id,
          name: row.name,
          longitude: Number(row.longitude),
          latitude: Number(row.latitude),
          place_type: placeType,
          slot_type: candidateCategory ?? undefined,
          category: candidateCategory ?? undefined,
          source: row.source ?? '',
          type_id: row.type_id ?? '',
          type_name: typeData?.name ?? '',
          category_id: categoryId,
          category_name: categoryName,
          open_hour: null,
          open_hour_compressed: row.open_hour_compressed ?? null,
          visit_duration: row.visit_duration ?? null,
          average_rating:
            row.average_rating != null ? Number(row.average_rating) : null,
        };
      });
  }

  private resolvePlannerPlaceType(
    candidateCategory?: string | null,
    categoryId?: string | null,
    categoryName?: string | null,
  ): 'hotel' | 'restaurant' | 'attraction' {
    const category = (candidateCategory ?? '').toLowerCase();
    const name = (categoryName ?? '').toLowerCase();
    if (category === 'accommodation' || category === 'hotel') {
      return 'hotel';
    }
    if (
      category === 'restaurant' ||
      category === 'cafe' ||
      categoryId === this.foodCategoryId ||
      name.includes('ẩm thực') ||
      name.includes('am thuc')
    ) {
      return 'restaurant';
    }
    return 'attraction';
  }

  private resolveGoongVehicle(transportMode?: string): 'car' | 'bike' {
    const mode = (transportMode ?? '').toUpperCase();
    if (mode === 'MOTORBIKE') {
      return 'bike';
    }
    return 'car';
  }

  private formatPlaceTypeCounts(
    places: ItineraryPlanPayload['places'],
  ): string {
    const counts = places.reduce<Record<string, number>>((acc, place) => {
      const key = place.place_type ?? 'unknown';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    return Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
  }

  private formatCandidateCounts(candidates: CandidatePlaceDto[]): string {
    const counts = candidates.reduce<Record<string, number>>((acc, candidate) => {
      const key = candidate.category ?? 'unknown';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    return Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
  }
}
