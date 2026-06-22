import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { supabase } from '../../config/supabase';
import { ItineraryPlanPayload, MlClientService } from './ml-client.service';
import { CreateItineraryDto } from '../itinerary/dto/create-itinerary.dto';
import {
  TwoTowerRetrievalResponseDto,
  CandidatePlaceDto,
} from '../itinerary/dto/retrieval-response.dto';
import {
  diversifyTopK,
  getPlannerTargets,
  getStratifiedFetchPlan,
  normalizeCategory,
  PlaceCandidate,
  SlotFetchPlan,
  parseTripIntents,
  dedupeByPlaceIdKeepBestScore,
} from './utils/mmr-rerank';
import { resolveIntentVibe } from './utils/intent-vibe';
import {
  DEFAULT_TWO_TOWER_RUNTIME_CONFIG,
  TwoTowerRuntimeConfig,
} from './two-tower-config.types';

type PriceBasis =
  | 'per_person'
  | 'per_room_per_night'
  | 'per_group'
  | 'unknown';

interface PriceInfo {
  estimatedCost: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  basis: PriceBasis;
  inferred: boolean | null;
  itemCount: number;
  rawItems: Array<{ name?: string; price: number }>;
}

@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);
  private readonly foodCategoryId = '97029cfb-069b-4dba-a152-dfb3d36634d3';
  private priceIndex: Map<string, PriceInfo> | null = null;

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
    config: TwoTowerRuntimeConfig = DEFAULT_TWO_TOWER_RUNTIME_CONFIG,
  ): Promise<TwoTowerRetrievalResponseDto> {
    const runtimeConfig = config.isActive
      ? config
      : DEFAULT_TWO_TOWER_RUNTIME_CONFIG;
    if (!config.isActive) {
      this.logger.warn(
        'Two Tower config is inactive; using default runtime config for safety',
      );
    }
    const safeTopK = Math.min(
      Math.max(Math.trunc(topK) || runtimeConfig.defaultTopK, 1),
      runtimeConfig.maxTopK,
    );

    // ── 1. City name ──────────────────────────────────────────────────────────
    const cityName = await this.getCityName(dto.destinationLocationId);
    const earlyNumDays = this.calcNumDays(dto.startDate, dto.endDate);
    const selectedIntents = parseTripIntents(dto.tripIntent);
    const specificIntents = selectedIntents.filter(
      (intent) => intent !== 'Khám phá tổng hợp',
    );
    const rawIntents =
      specificIntents.length > 0 ? specificIntents : selectedIntents;
    const intents =
      rawIntents.length > 0
        ? rawIntents.slice(0, runtimeConfig.maxIntents)
        : ['Khám phá tổng hợp'];
    const intentVibe = resolveIntentVibe(dto.adultCount, dto.childCount);

    this.logger.debug(
      {
        selectedIntents: intents,
        intentVibe,
        numDays: earlyNumDays,
        topK: safeTopK,
      },
      'multi-intent late fusion retrieval',
    );

    const allPools = await Promise.all(
      intents.map((intent) =>
        this.retrieveCandidatesForSingleIntent({
          dto,
          cityId: dto.destinationLocationId,
          cityName,
          intent,
          intentVibe,
          numDays: earlyNumDays,
          config: runtimeConfig,
        }),
      ),
    );

    const merged = dedupeByPlaceIdKeepBestScore(allPools.flat());
    this.logger.debug(`merged=${merged.length} final before diversify`);

    const earlyDiversePool = diversifyTopK(
      merged,
      earlyNumDays,
      intents.join(', '),
      safeTopK,
      {
        intentQuota: runtimeConfig.intentQuota,
        enableDiversityBudget: runtimeConfig.enableDiversityBudget,
      },
    );
    this.logger.debug(`final=${earlyDiversePool.length}`);

    return {
      destination_name: cityName,
      city_id: dto.destinationLocationId,
      total_candidates: earlyDiversePool.length,
      candidates: earlyDiversePool.map((candidate) => ({
        place_id: candidate.place_id,
        place_name: candidate.place_name,
        address: candidate.address,
        image_url: candidate.image_url,
        category: candidate.category,
        cosine_score: candidate.score,
        predict_ranking: null,
      })),
    };

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
    const fetchPlan = getStratifiedFetchPlan(
      dto.tripIntent,
      numDays,
      dto.dailyStartTime,
      dto.dailyEndTime,
    );
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
      `Pool: ${pool.length} places (${fetchPlan.map(p => `${p.slotType}:${p.limit}`).join(', ')})`,
    );

    // ── 6. Diversity-aware top-K (phase 2 fill nếu 1 slot thiếu) ─────────────
    const diversePool = diversifyTopK(pool, numDays, dto.tripIntent, topK, fetchPlan);

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

  private async retrieveCandidatesForSingleIntent(args: {
    dto: CreateItineraryDto;
    cityId: string;
    cityName: string;
    intent: string;
    intentVibe: string;
    numDays: number;
    config: TwoTowerRuntimeConfig;
  }): Promise<PlaceCandidate[]> {
    const { dto, cityId, cityName, intent, intentVibe, numDays, config } = args;

    let embedding: number[];
    try {
      embedding = await this.mlClient.encodeQuery({
        user_id: dto.userId,
        city: cityName,
        trip_intent: intent,
        intent_vibe: intentVibe,
        history_types: [],
        history_vibes: [],
        history_biz: [],
      });
    } catch (err: any) {
      const detail = err?.message ?? String(err);
      throw new ServiceUnavailableException(`AI Service lỗi: ${detail}`);
    }

    const fetchPlan = getStratifiedFetchPlan(intent, numDays, {
      intentQuota: config.intentQuota,
      fetchBufferMultiplier: config.fetchBufferMultiplier,
      enableAttractionTravelTypeFilter: config.enableAttractionTravelTypeFilter,
    });
    const poolChunks = await Promise.all(
      fetchPlan.map(({ slotType, limit, travelType }) =>
        this.fetchBySlot(embedding, cityId, slotType, limit, travelType),
      ),
    );

    const seenIds = new Set<string>();
    const pool: PlaceCandidate[] = [];
    for (const chunk of poolChunks) {
      for (const candidate of chunk) {
        if (!seenIds.has(candidate.place_id)) {
          seenIds.add(candidate.place_id);
          pool.push(candidate);
        }
      }
    }

    this.logger.debug(`intent=${intent} pool=${pool.length}`);
    return pool;
  }

  async planItinerary(dto: CreateItineraryDto, topK = 60): Promise<unknown> {
    const numDays = this.calcNumDays(dto.startDate, dto.endDate);
    const runStartedAt = Date.now();
    const fetchPlan = getStratifiedFetchPlan(
      dto.tripIntent,
      numDays,
      dto.dailyStartTime,
      dto.dailyEndTime,
    );
    const plannerTargets = getPlannerTargets(
      dto.tripIntent,
      dto.dailyStartTime,
      dto.dailyEndTime,
    );
    const retrievalStartedAt = Date.now();
    const retrieval = await this.retrieveCandidates(dto, topK);
    const retrievalMs = Date.now() - retrievalStartedAt;
    const plannerCandidates = retrieval.candidates;
    const detailsStartedAt = Date.now();
    const details = await this.fetchPlannerPlaceDetails(plannerCandidates);
    const detailsMs = Date.now() - detailsStartedAt;
    if (!details.length) {
      throw new NotFoundException('No place details found for itinerary planning');
    }
    if (!details.some((place) => place.place_type === 'hotel')) {
      throw new NotFoundException(
        'No real hotel/accommodation candidate found for itinerary planning',
      );
    }

    const attractionCount = details.filter((p) => p.place_type === 'attraction').length;
    if (attractionCount === 0) {
      this.logger.error(
        `Zero attractions retrieved for ${retrieval.destination_name} ` +
          `(mix: ${this.formatPlaceTypeCounts(details)}). ` +
          'Check slot_type data in Supabase travel.places for this city.',
      );
      throw new NotFoundException(
        `Không tìm thấy địa điểm tham quan (attraction) cho ${retrieval.destination_name}. ` +
          'Thành phố này chưa có đủ dữ liệu địa điểm. Vui lòng thử thành phố khác hoặc liên hệ hỗ trợ.',
      );
    }
    if (attractionCount < numDays) {
      this.logger.warn(
        `Low attraction count: ${attractionCount} for ${numDays}-day trip in ${retrieval.destination_name}. ` +
          'Some days may have few places to visit.',
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
      trip_start_date: dto.startDate,
      adult_count: dto.adultCount,
      child_count: dto.childCount ?? 0,
      budget_per_person: dto.budget ?? 0,
      // GOONG: Bật use_goong=true khi đã có GOONG_API_KEY trong ai-service/.env.
      // QUAN TRọNG: require_goong phải =false nếu không có key.
      // require_goong=true + không có key → GA skip toàn bộ địa điểm → visited_count=0!
      use_goong: false,
      require_goong: false,
      travel_vehicle: this.resolveGoongVehicle(dto.transportMode),
      population_size: 50,
      generations: 120,
      mutation_rate: 0.3,
      seed: 42,
    };

    try {
      const aiStartedAt = Date.now();
      const plan = await this.mlClient.planItinerary(payload);
      const aiPlannerMs = Date.now() - aiStartedAt;
      this.logItineraryRunJson({
        dto,
        topK,
        numDays,
        retrieval,
        details,
        plan,
        candidateBuilder: {
          availableMinutes: plannerTargets.availableMinutes,
          dailyQuota: plannerTargets.dailyQuota,
          fetchPlan,
          notes: plannerTargets.notes,
        },
        timings: {
          twoTowerMs: retrievalMs,
          detailsMs,
          aiPlannerMs,
          backendTotalMs: Date.now() - runStartedAt,
        },
      });
      return plan;
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
   *
   * Retry tối đa 2 lần với backoff 500ms để xử lý timeout ngắn ngủi từ Supabase.
   * Attraction slot có limit lớn nhất (72+) nên dễ timeout hơn các slot khác.
   */
  private async fetchBySlot(
    embedding: number[],
    cityId: string,
    slotType: string,
    limit: number,
    travelType?: string,
    maxRetries = 2,
  ): Promise<PlaceCandidate[]> {
    const effectiveLimit = Math.min(limit, 60);
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const { data, error } = await supabase.rpc('recommend_places_by_slot', {
        query_embedding: `[${embedding.join(',')}]`,
        target_city_id: cityId,
        p_slot_type: slotType,
        p_limit: effectiveLimit,
        p_travel_type: travelType ?? null,
      });

      if (!error) {
        if (attempt > 1) {
          this.logger.warn(`fetchBySlot [${slotType}] succeeded on attempt ${attempt}`);
        }
        const candidates = (data ?? []) as PlaceCandidate[];
        if (slotType === 'attraction' && travelType && candidates.length === 0) {
          this.logger.warn(
            `fetchBySlot [${slotType}] returned 0 with travelType="${travelType}", retrying without travelType`,
          );
          const { data: fallbackData, error: fallbackError } = await supabase.rpc(
            'recommend_places_by_slot',
            {
              query_embedding: `[${embedding.join(',')}]`,
              target_city_id: cityId,
              p_slot_type: slotType,
              p_limit: effectiveLimit,
              p_travel_type: null,
            },
          );

          if (!fallbackError) {
            return (fallbackData ?? []) as PlaceCandidate[];
          }
          this.logger.error(
            `fetchBySlot [${slotType}] fallback without travelType failed: ${fallbackError.message}`,
          );
        }
        return candidates;
      }

      this.logger.error(
        `fetchBySlot [${slotType}] attempt ${attempt}/${maxRetries + 1} failed: ${error.message}`,
      );
      if (attempt <= maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
    return [];
  }

  private async fetchPlannerPlaceDetails(
    candidates: CandidatePlaceDto[],
  ): Promise<ItineraryPlanPayload['places']> {
    const candidateById = new Map(
      candidates.map((candidate, index) => [
        candidate.place_id,
        { candidate, index },
      ]),
    );
    const ids = candidates.map((candidate) => candidate.place_id);
    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .select(
        'id,name,longitude,latitude,open_hour_compressed,source,type_id,slot_type,visit_duration,average_rating,types(name,categories(id,name))',
      )
      .in('id', ids);

    if (error) {
      this.logger.error(`fetchPlannerPlaceDetails error: ${error.message}`);
      return [];
    }

    return (data ?? [])
      .filter((row: any) => row.longitude != null && row.latitude != null)
      .map((row: any) => {
        const candidateMeta = candidateById.get(row.id);
        const candidate = candidateMeta?.candidate;
        const typeData = Array.isArray(row.types) ? row.types[0] : row.types;
        const categoryData = Array.isArray(typeData?.categories)
          ? typeData.categories[0]
          : typeData?.categories;
        const categoryId = categoryData?.id ?? null;
        const categoryName = categoryData?.name ?? null;
        const candidateCategory = normalizeCategory(
          row.slot_type ?? candidate?.category ?? '',
          typeData?.name ?? '',
        );
        const placeType = this.resolvePlannerPlaceType(
          candidateCategory,
          categoryId,
          categoryName,
          typeData?.name ?? '',
        );
        const price = this.getPriceInfo(row.id, placeType);
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
          open_hour_compressed: this.compactOpenHourCompressed(
            row.open_hour_compressed,
          ),
          visit_duration: row.visit_duration ?? null,
          average_rating:
            row.average_rating != null ? Number(row.average_rating) : null,
          retrieval_score: candidate?.cosine_score ?? null,
          candidate_rank: candidateMeta?.index ?? null,
          candidate_total: candidates.length,
          estimated_cost: price.estimatedCost,
          price_min: price.min,
          price_max: price.max,
          price_basis: price.basis,
          price_inferred: price.inferred,
          planner_source: 'two_tower',
        };
      })
      .sort((a: any, b: any) => (a.candidate_rank ?? 999_999) - (b.candidate_rank ?? 999_999));
  }

  private resolvePlannerPlaceType(
    candidateCategory?: string | null,
    categoryId?: string | null,
    categoryName?: string | null,
    typeName?: string | null,
  ): 'hotel' | 'restaurant' | 'cafe' | 'entertainment' | 'attraction' {
    const category = (candidateCategory ?? '').toLowerCase();
    const name = (categoryName ?? '').toLowerCase();
    const type = (typeName ?? '').toLowerCase();
    if (category === 'accommodation' || category === 'hotel') {
      return 'hotel';
    }
    if (category === 'cafe' || type.includes('cafe') || type.includes('coffee')) {
      return 'cafe';
    }
    if (category === 'entertainment') {
      return 'entertainment';
    }
    if (
      category === 'restaurant' ||
      categoryId === this.foodCategoryId ||
      name.includes('ẩm thực') ||
      name.includes('am thuc')
    ) {
      return 'restaurant';
    }
    return 'attraction';
  }

  private compactOpenHourCompressed(value?: string | null): string | null {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw.startsWith('{')) return raw;

    const dayMap: Array<[string, string]> = [
      ['Monday', 'Mon'],
      ['Tuesday', 'Tue'],
      ['Wednesday', 'Wed'],
      ['Thursday', 'Thu'],
      ['Friday', 'Fri'],
      ['Saturday', 'Sat'],
      ['Sunday', 'Sun'],
    ];

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const byWindow = new Map<string, string[]>();
      for (const [fullDay, shortDay] of dayMap) {
        const windows = parsed[fullDay];
        if (!Array.isArray(windows) || !windows.length) continue;
        const firstWindow = windows[0];
        if (!Array.isArray(firstWindow) || firstWindow.length < 2) continue;
        const start = this.compactClock(firstWindow[0]);
        const end = this.compactClock(firstWindow[1]);
        if (!start || !end) continue;
        const key = `${start}-${end}`;
        byWindow.set(key, [...(byWindow.get(key) ?? []), shortDay]);
      }

      if (!byWindow.size) return raw;
      return Array.from(byWindow.entries())
        .map(([window, days]) => `[${this.compactDaySpec(days)}]:[${window}]`)
        .join(' | ');
    } catch {
      return raw;
    }
  }

  private compactClock(value: unknown): string | null {
    const text = String(value ?? '').trim();
    const match = text.match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    return `${match[1].padStart(2, '0')}:${match[2]}`;
  }

  private compactDaySpec(days: string[]): string {
    const week = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    if (days.length === 7 && week.every((day, idx) => days[idx] === day)) {
      return 'Mon-Sun';
    }
    if (
      days.length === 5 &&
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].every((day, idx) => days[idx] === day)
    ) {
      return 'Mon-Fri';
    }
    if (
      days.length === 2 &&
      days[0] === 'Sat' &&
      days[1] === 'Sun'
    ) {
      return 'Sat,Sun';
    }
    return days.join(',');
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

  private countCandidates(candidates: CandidatePlaceDto[]): Record<string, number> {
    return candidates.reduce<Record<string, number>>((acc, candidate) => {
      const key = candidate.category ?? 'unknown';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
  }

  private countPlannerPlaces(
    places: ItineraryPlanPayload['places'],
  ): Record<string, number> {
    return places.reduce<Record<string, number>>((acc, place) => {
      const key = place.place_type ?? 'unknown';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
  }

  private aggregateScheduleByType(schedule: any[]): Record<string, any> {
    return schedule.reduce<Record<string, any>>((acc, entry) => {
      const key = entry.is_return_to_hotel
        ? 'return_to_hotel'
        : entry.is_restaurant
          ? 'restaurant'
          : entry.place_type ?? 'attraction';
      const bucket = acc[key] ?? {
        count: 0,
        travelMinutes: 0,
        rawTravelMinutes: 0,
        waitMinutes: 0,
        activeDurationMinutes: 0,
        distanceKm: 0,
      };
      bucket.count += 1;
      bucket.travelMinutes += Number(entry.travel_minutes ?? 0);
      bucket.rawTravelMinutes += Number(entry.raw_travel_minutes ?? 0);
      bucket.waitMinutes += Number(entry.wait_minutes ?? 0);
      bucket.activeDurationMinutes += Number(entry.active_duration_minutes ?? 0);
      bucket.distanceKm = Number((bucket.distanceKm + Number(entry.distance_km ?? 0)).toFixed(2));
      acc[key] = bucket;
      return acc;
    }, {});
  }

  private aggregateDaysByType(days: any[]): Record<string, any> {
    return days.reduce<Record<string, any>>((acc, day) => {
      const dayTotals = this.aggregateScheduleByType(Array.isArray(day.schedule) ? day.schedule : []);
      for (const [key, value] of Object.entries(dayTotals) as Array<[string, any]>) {
        const bucket = acc[key] ?? {
          count: 0,
          travelMinutes: 0,
          rawTravelMinutes: 0,
          waitMinutes: 0,
          activeDurationMinutes: 0,
          distanceKm: 0,
        };
        bucket.count += value.count;
        bucket.travelMinutes += value.travelMinutes;
        bucket.rawTravelMinutes += value.rawTravelMinutes;
        bucket.waitMinutes += value.waitMinutes;
        bucket.activeDurationMinutes += value.activeDurationMinutes;
        bucket.distanceKm = Number((bucket.distanceKm + value.distanceKm).toFixed(2));
        acc[key] = bucket;
      }
      return acc;
    }, {});
  }

  private getPriceInfo(placeId: string, placeType?: string | null): PriceInfo {
    const indexed = this.getPriceIndex().get(placeId);
    if (indexed) return indexed;
    return {
      estimatedCost: null,
      min: null,
      max: null,
      avg: null,
      basis: this.inferPriceBasis(placeType ?? 'unknown'),
      inferred: null,
      itemCount: 0,
      rawItems: [],
    };
  }

  private getPriceIndex(): Map<string, PriceInfo> {
    if (this.priceIndex) return this.priceIndex;
    const index = new Map<string, PriceInfo>();
    const csvPath = join(process.cwd(), '..', 'docs', 'places_rows_after_fill.csv');
    if (!existsSync(csvPath)) {
      this.logger.warn(`Price CSV not found: ${csvPath}`);
      this.priceIndex = index;
      return index;
    }

    try {
      const workbook = XLSX.readFile(csvPath, { raw: false });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: null });
      for (const row of rows) {
        const id = String(row.id ?? '').trim();
        if (!id) continue;
        const slotType = normalizeCategory(String(row.slot_type ?? ''), '');
        const placeType = slotType === 'accommodation' ? 'hotel' : slotType;
        index.set(
          id,
          this.normalizePriceInfo(
            row.price,
            row.price_inferred,
            placeType,
          ),
        );
      }
      this.logger.warn(`Loaded ${index.size} place prices from ${csvPath}`);
    } catch (err: any) {
      this.logger.warn(`Failed to load price CSV: ${err?.message ?? String(err)}`);
    }

    this.priceIndex = index;
    return index;
  }

  private normalizePriceInfo(
    rawPrice: unknown,
    rawInferred: unknown,
    placeType: string,
  ): PriceInfo {
    const rawItems = this.parsePriceItems(rawPrice);
    const parsedPrices = rawItems
      .map((item) => Number(item.price))
      .filter((price) => Number.isFinite(price) && price >= 0);
    const prices = parsedPrices
      .filter((price) => price === 0 || price >= 1000)
      .sort((a, b) => a - b);
    const inferred = this.parseBoolean(rawInferred);
    if (!prices.length) {
      return {
        estimatedCost: null,
        min: null,
        max: null,
        avg: null,
        basis: this.inferPriceBasis(placeType),
        inferred,
        itemCount: 0,
        rawItems: [],
      };
    }
    if (prices.every((price) => price === 0)) {
      return {
        estimatedCost: 0,
        min: 0,
        max: 0,
        avg: 0,
        basis: this.inferPriceBasis(placeType),
        inferred,
        itemCount: prices.length,
        rawItems,
      };
    }

    const billablePrices = prices.filter((price) => price > 0);
    const avg = Math.round(
      billablePrices.reduce((sum, price) => sum + price, 0) / billablePrices.length,
    );
    return {
      estimatedCost: this.percentile(billablePrices, 0.5),
      min: billablePrices[0],
      max: billablePrices[billablePrices.length - 1],
      avg,
      basis: this.inferPriceBasis(placeType),
      inferred,
      itemCount: billablePrices.length,
      rawItems,
    };
  }

  private parsePriceItems(rawPrice: unknown): Array<{ name?: string; price: number }> {
    if (rawPrice == null || rawPrice === '') return [];
    if (Array.isArray(rawPrice)) {
      return rawPrice
        .map((item: any) => ({ name: item?.name, price: Number(item?.price) }))
        .filter((item) => Number.isFinite(item.price));
    }
    const text = String(rawPrice).trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item: any) => ({ name: item?.name, price: Number(item?.price) }))
          .filter((item) => Number.isFinite(item.price));
      }
      if (parsed && typeof parsed === 'object' && 'price' in parsed) {
        return [{ name: (parsed as any).name, price: Number((parsed as any).price) }];
      }
    } catch {
      const matches = text.match(/\d[\d.,]*/g) ?? [];
      return matches
        .map((value) => ({ price: Number(value.replace(/[.,]/g, '')) }))
        .filter((item) => Number.isFinite(item.price));
    }
    return [];
  }

  private parseBoolean(value: unknown): boolean | null {
    if (value == null || value === '') return null;
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (text === 'true' || text === '1') return true;
    if (text === 'false' || text === '0') return false;
    return null;
  }

  private inferPriceBasis(placeType: string): PriceBasis {
    if (placeType === 'hotel' || placeType === 'accommodation') return 'per_room_per_night';
    if (['restaurant', 'cafe', 'attraction', 'entertainment'].includes(placeType)) {
      return 'per_person';
    }
    return 'unknown';
  }

  private percentile(values: number[], p: number): number {
    if (!values.length) return 0;
    const idx = Math.min(values.length - 1, Math.max(0, Math.round((values.length - 1) * p)));
    return values[idx];
  }

  private estimateTripCostFromPrices(
    dto: CreateItineraryDto,
    numDays: number,
    days: any[],
    hotelId?: string | null,
  ): Record<string, any> {
    const adults = Number(dto.adultCount ?? 0);
    const children = Number(dto.childCount ?? 0);
    const payingPeople = adults + children * 0.5;
    const fullPeople = adults + children;
    const rooms = Math.max(1, Math.ceil(fullPeople / 2));
    const nights = Math.max(1, numDays - 1);
    const scheduleEntries = days.flatMap((day: any) =>
      Array.isArray(day.schedule) ? day.schedule : [],
    );
    const byType: Record<string, number> = {};
    const confidence = { observed: 0, inferred: 0, missing: 0 };
    let variableCost = 0;

    for (const entry of scheduleEntries) {
      const type = entry.is_return_to_hotel
        ? 'return_to_hotel'
        : entry.is_restaurant
          ? 'restaurant'
          : entry.place_type ?? 'attraction';
      if (type === 'return_to_hotel') continue;
      const price = this.getPriceInfo(entry.location_id, type);
      if (price.estimatedCost == null) {
        confidence.missing += 1;
        continue;
      }
      if (price.inferred === false) confidence.observed += 1;
      else if (price.inferred === true) confidence.inferred += 1;
      else confidence.missing += 1;
      const multiplier = price.basis === 'per_person' ? payingPeople : 1;
      const cost = Math.round(price.estimatedCost * multiplier);
      byType[type] = (byType[type] ?? 0) + cost;
      variableCost += cost;
    }

    const hotelPrice = this.getPriceInfo(hotelId ?? '', 'hotel');
    const hotelPerNight = hotelPrice.estimatedCost ?? 400_000;
    const hotel = Math.round(hotelPerNight * nights * rooms);
    if (hotelPrice.estimatedCost == null) {
      confidence.missing += 1;
    } else if (hotelPrice.inferred === false) {
      confidence.observed += 1;
    } else if (hotelPrice.inferred === true) {
      confidence.inferred += 1;
    }
    const totalsByType = this.aggregateDaysByType(days);
    const transport = Math.round(
      Object.values(totalsByType).reduce(
        (sum, value: any) => sum + Number(value?.distanceKm ?? 0),
        0,
      ) * 5_000,
    );
    const total = Math.round(hotel + variableCost + transport);
    const budget = Number(dto.budget ?? 0);
    const totalBudget = budget * Math.max(1, adults + children);
    return {
      mode: 'csv_price_preview',
      note: 'Prices are read from docs/places_rows_after_fill.csv until price columns are uploaded to DB.',
      assumptionsVnd: {
        fallbackHotelPerRoomNight: 400_000,
        transportPerKm: 5_000,
        childFactor: 0.5,
        roomCapacity: 2,
      },
      confidence,
      travelers: { adults, children, adultEquivalent: payingPeople, rooms },
      nights,
      breakdownVnd: {
        hotel,
        restaurant: Math.round(byType.restaurant ?? 0),
        cafe: Math.round(byType.cafe ?? 0),
        attraction: Math.round(byType.attraction ?? 0),
        entertainment: Math.round(byType.entertainment ?? 0),
        transport,
      },
      totalVnd: total,
      userBudgetPerPersonVnd: budget,
      userBudgetVnd: totalBudget,
      overBudgetVnd: totalBudget > 0 ? Math.max(0, total - totalBudget) : null,
    };
  }

  private logItineraryRunJson(args: {
    dto: CreateItineraryDto;
    topK: number;
    numDays: number;
    retrieval: TwoTowerRetrievalResponseDto;
    details: ItineraryPlanPayload['places'];
    plan: unknown;
    candidateBuilder?: {
      availableMinutes: number;
      dailyQuota: Record<string, number>;
      fetchPlan: SlotFetchPlan[];
      notes: string[];
    };
    timings: {
      twoTowerMs: number;
      detailsMs: number;
      aiPlannerMs: number;
      backendTotalMs: number;
    };
  }) {
    const plan = (args.plan ?? {}) as any;
    const days = Array.isArray(plan.days) ? plan.days : [];
    const report = {
      event: 'itinerary_plan_debug',
      generatedAt: new Date().toISOString(),
      request: {
        userId: args.dto.userId,
        destinationLocationId: args.dto.destinationLocationId,
        destinationName: args.retrieval.destination_name,
        tripIntent: args.dto.tripIntent,
        startDate: args.dto.startDate,
        endDate: args.dto.endDate,
        dailyStartTime: args.dto.dailyStartTime,
        dailyEndTime: args.dto.dailyEndTime,
        transportMode: args.dto.transportMode,
        topK: args.topK,
        numDays: args.numDays,
      },
      counts: {
        twoTowerCandidates: args.retrieval.total_candidates,
        twoTowerByCategory: this.countCandidates(args.retrieval.candidates),
        plannerInputPlaces: args.details.length,
        plannerByPlaceType: this.countPlannerPlaces(args.details),
        plannerBySource: args.details.reduce<Record<string, number>>((acc, place) => {
          const key = place.planner_source ?? 'two_tower';
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
        aiInputPlaces: plan.input_places ?? null,
        aiTotalVisited: plan.total_visited ?? null,
      },
      candidateBuilder: args.candidateBuilder ?? null,
      twoTowerCandidates: args.retrieval.candidates.map((candidate, index) => ({
        rank: index + 1,
        placeId: candidate.place_id,
        placeName: candidate.place_name,
        category: candidate.category,
        cosineScore: candidate.cosine_score,
      })),
      plannerInputPlaces: args.details.map((place, index) => ({
        rank: place.candidate_rank != null ? Number(place.candidate_rank) + 1 : index + 1,
        placeId: place.id,
        placeName: place.name,
        plannerRole: place.place_type ?? null,
        sourceSlotType: place.slot_type ?? null,
        typeName: place.type_name ?? null,
        categoryId: place.category_id ?? null,
        categoryName: place.category_name ?? null,
        openHourCompressed: place.open_hour_compressed ?? null,
        visitDuration: place.visit_duration ?? null,
        averageRating: place.average_rating ?? null,
        retrievalScore: place.retrieval_score ?? null,
        estimatedCost: place.estimated_cost ?? null,
        priceMin: place.price_min ?? null,
        priceMax: place.price_max ?? null,
        priceBasis: place.price_basis ?? null,
        priceInferred: place.price_inferred ?? null,
        plannerSource: place.planner_source ?? 'two_tower',
      })),
      timingsMs: {
        twoTower: args.timings.twoTowerMs,
        fetchPlannerDetails: args.timings.detailsMs,
        aiPlannerHttp: args.timings.aiPlannerMs,
        aiTotal: plan.total_ms ?? null,
        goongMatrix: plan.matrix_ms ?? null,
        ga: plan.ga_ms ?? null,
        backendTotal: args.timings.backendTotalMs,
      },
      hotel: {
        id: plan.hotel_id ?? null,
        name: plan.hotel_name ?? null,
      },
      assignment: {
        dayLoads: plan.assignment_day_loads ?? [],
        warnings: plan.assignment_warnings ?? [],
      },
      validation: {
        isFeasible: plan.validation_is_feasible ?? true,
        violations: plan.validation_violations ?? [],
        warnings: plan.validation_warnings ?? [],
      },
      totalsByPlaceType: this.aggregateDaysByType(days),
      priceEstimate: this.estimateTripCostFromPrices(
        args.dto,
        args.numDays,
        days,
        plan.hotel_id ?? null,
      ),
      days: days.map((day: any) => ({
        day: day.day,
        visitedCount: day.visited_count,
        targetVisitedCount: day.target_visited_count ?? null,
        restaurantCount: day.restaurant_count,
        fitness: day.fitness,
        totalTravelMinutes: day.total_travel_minutes,
        totalDistanceKm: day.total_distance_km,
        totalVisitMinutes: day.total_visit_minutes,
        totalWaitMinutes: day.total_wait_minutes,
        totalActivityCost: day.total_activity_cost ?? null,
        totalTransportCost: day.total_transport_cost ?? null,
        totalDayCost: day.total_day_cost ?? null,
        budgetLimit: day.budget_limit ?? null,
        budgetOverage: day.budget_overage ?? null,
        budgetPenalty: day.budget_penalty ?? null,
        skippedCount: day.skipped_count ?? null,
        totalHardViolations: day.total_hard_violations ?? null,
        mealViolations: day.meal_violations ?? null,
        totalsByPlaceType: this.aggregateScheduleByType(
          Array.isArray(day.schedule) ? day.schedule : [],
        ),
        stoppedReason: day.stopped_reason,
        schedule: Array.isArray(day.schedule)
          ? day.schedule.map((entry: any, index: number) => {
              const type = entry.is_return_to_hotel
                ? 'return_to_hotel'
                : entry.is_restaurant
                  ? 'restaurant'
                  : entry.place_type ?? 'attraction';
              const price = this.getPriceInfo(entry.location_id, type);
              return {
                sequence: index + 1,
                locationId: entry.location_id,
                locationName: entry.location_name,
                fromId: entry.travel_from_id,
                fromName: entry.travel_from_name,
                type,
                arrivalTime: entry.arrival_time,
                serviceStartTime: entry.service_start_time,
                departureTime: entry.departure_time,
                travelMinutes: entry.travel_minutes,
                rawTravelMinutes: entry.raw_travel_minutes,
                travelBufferMinutes: entry.travel_buffer_minutes,
                travelBufferSource: entry.travel_buffer_source,
                distanceKm: entry.distance_km,
                travelSource: entry.travel_source,
                waitMinutes: entry.wait_minutes,
                baseDurationMinutes: entry.base_duration_minutes,
                activeDurationMinutes: entry.active_duration_minutes,
                unknownHours: entry.unknown_hours,
                estimatedCost: entry.estimated_cost ?? price.estimatedCost,
                priceMin: price.min,
                priceMax: price.max,
                priceBasis: entry.price_basis ?? price.basis,
                priceInferred: entry.price_inferred ?? price.inferred,
              };
            })
          : [],
      })),
    };

    this.logger.warn(
      `ITINERARY_PLAN_DEBUG_JSON ${JSON.stringify(report, null, 2)}`,
    );
    this.writeItineraryRunJson(report);
  }

  private writeItineraryRunJson(report: Record<string, any>): void {
    try {
      const dir = join(process.cwd(), 'logs', 'itinerary-plan-debug');
      const jsonDir = join(dir, 'json');
      const scheduleDir = join(dir, 'schedule-csv');
      const plannerInputDir = join(dir, 'planner-input-csv');
      mkdirSync(jsonDir, { recursive: true });
      mkdirSync(scheduleDir, { recursive: true });
      mkdirSync(plannerInputDir, { recursive: true });

      const request = report.request ?? {};
      const generatedAt = String(report.generatedAt ?? new Date().toISOString());
      const timestamp = generatedAt.replace(/[:.]/g, '-');
      const intent = this.slugifyFilePart(request.tripIntent ?? 'unknown');
      const destination = this.slugifyFilePart(request.destinationName ?? 'unknown');
      const days = request.numDays ?? 'x';
      const topK = request.topK ?? 'x';
      const filename = `${timestamp}_${destination}_${intent}_${days}days_top${topK}.json`;
      const baseName = filename.replace(/\.json$/, '');
      const content = JSON.stringify(report, null, 2);

      writeFileSync(join(jsonDir, filename), content, 'utf8');
      writeFileSync(join(jsonDir, 'latest.json'), content, 'utf8');
      writeFileSync(
        join(scheduleDir, `${baseName}_schedule.csv`),
        this.toCsv(this.flattenScheduleReport(report)),
        'utf8',
      );
      writeFileSync(
        join(plannerInputDir, `${baseName}_planner-input.csv`),
        this.toCsv((report.plannerInputPlaces ?? []) as Array<Record<string, any>>),
        'utf8',
      );
      this.logger.warn(`ITINERARY_PLAN_DEBUG_FILE ${join(jsonDir, filename)}`);
    } catch (err: any) {
      this.logger.warn(
        `Failed to write itinerary debug JSON: ${err?.message ?? String(err)}`,
      );
    }
  }

  private slugifyFilePart(value: unknown): string {
    return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 48) || 'unknown';
  }

  private flattenScheduleReport(report: Record<string, any>): Array<Record<string, any>> {
    const days = Array.isArray(report.days) ? report.days : [];
    return days.flatMap((day: any) =>
      (Array.isArray(day.schedule) ? day.schedule : []).map((entry: any) => ({
        day: day.day,
        sequence: entry.sequence,
        dayBudgetLimit: day.budgetLimit,
        dayCost: day.totalDayCost,
        dayBudgetOverage: day.budgetOverage,
        dayBudgetPenalty: day.budgetPenalty,
        type: entry.type,
        placeId: entry.locationId,
        placeName: entry.locationName,
        fromName: entry.fromName,
        arrivalTime: entry.arrivalTime,
        serviceStartTime: entry.serviceStartTime,
        departureTime: entry.departureTime,
        travelMinutes: entry.travelMinutes,
        rawTravelMinutes: entry.rawTravelMinutes,
        travelBufferMinutes: entry.travelBufferMinutes,
        travelBufferSource: entry.travelBufferSource,
        distanceKm: entry.distanceKm,
        travelSource: entry.travelSource,
        waitMinutes: entry.waitMinutes,
        baseDurationMinutes: entry.baseDurationMinutes,
        activeDurationMinutes: entry.activeDurationMinutes,
        estimatedCost: entry.estimatedCost,
        priceMin: entry.priceMin,
        priceMax: entry.priceMax,
        priceBasis: entry.priceBasis,
        priceInferred: entry.priceInferred,
      })),
    );
  }

  private toCsv(rows: Array<Record<string, any>>): string {
    if (!rows.length) return '';
    const headers = Array.from(
      rows.reduce<Set<string>>((set, row) => {
        for (const key of Object.keys(row)) set.add(key);
        return set;
      }, new Set<string>()),
    );
    return [
      headers.join(','),
      ...rows.map((row) =>
        headers.map((header) => this.csvCell(row[header])).join(','),
      ),
    ].join('\r\n');
  }

  private csvCell(value: unknown): string {
    if (value == null) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }
}
