import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { supabase } from '../../config/supabase';
import {
  ItineraryPlanPayload,
  MlClientService,
  RegionDetectionResult,
} from './ml-client.service';
import {
  CreateItineraryDto,
  RegionAllocationDto,
} from '../itinerary/dto/create-itinerary.dto';
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
import { resolvePlannerPlaceType } from './utils/place-type.util';
import { resolveIntentVibe } from './utils/intent-vibe';
import {
  DEFAULT_TWO_TOWER_RUNTIME_CONFIG,
  TwoTowerRuntimeConfig,
} from './two-tower-config.types';
import { PlannerEngine } from '../../config/planner-engine';
interface HotelSelection {
  hotelId: string;
  hotelTotalCost: number;
  pricePerPersonPerNight: number;
  groupNightlyCost: number;
  fullPeople: number;
  nights: number;
  /** Average distance (km) to the densest confirmed region's POIs — lower is better. */
  score: number;
  /** Two-tower retrieval rank — only used to break ties on `score`. */
  candidateRank: number;
  budgetRelaxed: boolean;
}

export interface UserHistory {
  types: string[];
  vibes: string[];
  bizIds: string[];
}

const MAX_HISTORY_LEN = 30; // phải khớp ModelConfig.MAX_HISTORY_LEN bên FastAPI
const HISTORY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 phút — history đổi chậm hơn nhiều so với 1 request

type PriceBasis = 'per_person' | 'per_room_per_night' | 'per_group' | 'unknown';

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

  constructor(
    private readonly mlClient: MlClientService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /**
   * Lấy lịch sử tương tác gần nhất của user (activity_logs) để đưa vào Two-Tower
   * query embedding (history_types/history_vibes/history_biz). Cache 5 phút/user
   * vì history đổi chậm hơn nhiều so với vòng đời 1 request.
   */
  async getUserHistory(userId: string): Promise<UserHistory> {
    const cacheKey = `user_history:${userId}`;
    const cached = await this.cache.get<UserHistory>(cacheKey);
    if (cached) return cached;

    const { data, error } = await supabase
      .schema('travel')
      .from('activity_logs')
      .select('place_id, action_type, created_at, places(type_id, vibes, types(name))')
      .eq('tourist_id', userId)
      .not('place_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(MAX_HISTORY_LEN);

    if (error || !data || data.length === 0) {
      // Cold-start thật (không có lịch sử) — history rỗng là input HỢP LỆ cho QueryTower
      const empty: UserHistory = { types: [], vibes: [], bizIds: [] };
      await this.cache.set(cacheKey, empty, HISTORY_CACHE_TTL_MS);
      return empty;
    }

    const history = this.mapActivityLogsToHistory(data);
    await this.cache.set(cacheKey, history, HISTORY_CACHE_TTL_MS);
    return history;
  }

  /**
   * "Cold-start ở tầng nghiệp vụ": user chưa từng tạo lịch trình nào.
   * Dùng count(itineraries) thay vì count(activity_logs) vì đây là hành động
   * có chủ đích cao nhất (đã thật sự lên kế hoạch), ít nhiễu hơn "đã từng click/view".
   */
  async isNewUser(userId: string): Promise<boolean> {
    const cacheKey = `is_new_user:${userId}`;
    const cached = await this.cache.get<boolean>(cacheKey);
    if (cached !== undefined) return cached;

    const { count } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('id', { count: 'exact', head: true })
      .eq('creator_id', userId);

    const isNew = (count ?? 0) === 0;
    await this.cache.set(cacheKey, isNew, HISTORY_CACHE_TTL_MS);
    return isNew;
  }

  private mapActivityLogsToHistory(rows: any[]): UserHistory {
    const bizIds: string[] = [];
    const types = new Set<string>();
    const vibes = new Set<string>();

    for (const row of rows) {
      if (row.place_id) bizIds.push(row.place_id);

      const place = Array.isArray(row.places) ? row.places[0] : row.places;
      if (!place) continue;

      const typeRel = Array.isArray(place.types) ? place.types[0] : place.types;
      if (typeRel?.name) types.add(typeRel.name);

      if (Array.isArray(place.vibes)) {
        for (const vibe of place.vibes) {
          if (vibe) vibes.add(vibe);
        }
      }
    }

    return {
      types: Array.from(types).slice(0, MAX_HISTORY_LEN),
      vibes: Array.from(vibes).slice(0, MAX_HISTORY_LEN),
      bizIds: bizIds.slice(0, MAX_HISTORY_LEN),
    };
  }

  private static readonly TOP20_CACHE_PREFIX = 'place_popularity:top20:';
  private static readonly TOP20_CACHE_TTL_MS = 20 * 60 * 1000; // 20 phút

  /**
   * Top-20 THẬT theo đúng category (place_id) — dùng lại ĐÚNG RPC
   * `get_place_popularity_stats` mà dashboard admin gọi cho chart "Top 20 địa điểm
   * được ghé thăm nhiều nhất theo danh mục" (admin-dashboard.service.ts), với
   * p_limit=20 giống hệt dashboard — KHÔNG quét toàn bộ địa điểm, chỉ lấy đúng 20
   * cái admin đang thấy cho từng category. 1 candidate chỉ được coi là "phổ biến"
   * nếu nằm trong đúng 20 địa điểm này của category của nó (boost rời rạc, không
   * còn tính liên tục theo số lượt ghé nữa).
   */
  private async getTop20PlaceIdsByCategory(categoryName: string): Promise<Set<string>> {
    const cacheKey = `${RecommendationService.TOP20_CACHE_PREFIX}${categoryName}`;
    const cached = await this.cache.get<Set<string>>(cacheKey);
    if (cached) return cached;

    const { data, error } = await supabase.rpc('get_place_popularity_stats', {
      p_limit: 20,
      p_mode: 'top',
      p_category_name: categoryName,
    });

    if (error || !data) {
      this.logger.warn(
        `getTop20PlaceIdsByCategory("${categoryName}") lỗi, dùng set rỗng: ${error?.message}`,
      );
      return new Set();
    }

    const ids = new Set<string>((data as any[]).map((row) => String(row.place_id)));
    await this.cache.set(cacheKey, ids, RecommendationService.TOP20_CACHE_TTL_MS);
    return ids;
  }

  /**
   * average_rating (chất lượng, phụ) + is_top20_visited (độ phổ biến thật theo
   * ĐÚNG category, chính) cho _popularity_score() của SessionCfReranker. Category
   * dùng để tra Top-20 là `travel.categories.name` THẬT (qua places.type_id ->
   * types.category_id -> categories.name) — KHÔNG phải nhãn nội bộ attraction/
   * restaurant/cafe/... của Two-Tower, nên phải join riêng, không tái dùng
   * candidate.category có sẵn.
   */
  private async fetchPopularityMeta(
    placeIds: string[],
  ): Promise<Map<string, { average_rating: number | null; is_top20_visited: boolean }>> {
    const meta = new Map<
      string,
      { average_rating: number | null; is_top20_visited: boolean }
    >();
    if (placeIds.length === 0) return meta;

    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .select('id, average_rating, types(categories(name))')
      .in('id', placeIds);

    if (error || !data) {
      this.logger.warn(`fetchPopularityMeta lỗi, dùng null cho toàn bộ: ${error?.message}`);
      return meta;
    }

    const rows = data as any[];
    const categoryByPlaceId = new Map<string, string | null>();
    for (const row of rows) {
      const typeData = Array.isArray(row.types) ? row.types[0] : row.types;
      const categoryData = Array.isArray(typeData?.categories)
        ? typeData.categories[0]
        : typeData?.categories;
      categoryByPlaceId.set(row.id, categoryData?.name ?? null);
    }

    const distinctCategories = Array.from(
      new Set(
        Array.from(categoryByPlaceId.values()).filter(
          (name): name is string => !!name,
        ),
      ),
    );
    const top20Sets = await Promise.all(
      distinctCategories.map((name) => this.getTop20PlaceIdsByCategory(name)),
    );
    const top20ByCategory = new Map(
      distinctCategories.map((name, i) => [name, top20Sets[i]]),
    );

    for (const row of rows) {
      const categoryName = categoryByPlaceId.get(row.id) ?? null;
      const top20Set = categoryName ? top20ByCategory.get(categoryName) : undefined;
      meta.set(row.id, {
        average_rating: row.average_rating != null ? Number(row.average_rating) : null,
        is_top20_visited: top20Set ? top20Set.has(row.id) : false,
      });
    }
    return meta;
  }

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

    // History không đổi giữa các intent trong cùng 1 request — fetch MỘT LẦN,
    // tránh N query trùng lặp (N = số intent, tối đa runtimeConfig.maxIntents).
    const userHistory = await this.getUserHistory(dto.userId);

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
          userHistory,
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

    const popularityMeta = await this.fetchPopularityMeta(
      earlyDiversePool.map((candidate) => candidate.place_id),
    );

    const rerankedPool = await this.mlClient.sessionRerank(
      dto.userId,
      earlyDiversePool.map((candidate) => ({
        place_id: candidate.place_id,
        place_name: candidate.place_name,
        address: candidate.address,
        image_url: candidate.image_url,
        category: candidate.category,
        cosine_score: candidate.score,
        average_rating: popularityMeta.get(candidate.place_id)?.average_rating ?? null,
        is_top20_visited: popularityMeta.get(candidate.place_id)?.is_top20_visited ?? false,
      })),
    );

    return {
      destination_name: cityName,
      city_id: dto.destinationLocationId,
      total_candidates: rerankedPool.length,
      candidates: rerankedPool.map((candidate) => ({
        place_id: candidate.place_id,
        place_name: candidate.place_name,
        address: candidate.address,
        image_url: candidate.image_url,
        category: candidate.category,
        cosine_score: candidate.cosine_score,
        predict_ranking: candidate.predict_ranking ?? null,
        // Field chẩn đoán từ SessionCfReranker — trước đây bị cắt khỏi response khiến không
        // thể verify/demo cold-start vs loyal-user qua API (chỉ suy đoán được qua chênh lệch
        // số predict_ranking). Thêm lại để phục vụ demo hội đồng + debug (docs/create-data).
        is_cold_start: candidate.is_cold_start ?? null,
        historical_cf_score: candidate.historical_cf_score ?? null,
        session_score: candidate.session_score ?? null,
        popularity_score: candidate.popularity_score ?? null,
      })),
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
    userHistory: UserHistory;
  }): Promise<PlaceCandidate[]> {
    const {
      dto,
      cityId,
      cityName,
      intent,
      intentVibe,
      numDays,
      config,
      userHistory,
    } = args;

    let embedding: number[];
    try {
      embedding = await this.mlClient.encodeQuery({
        user_id: dto.userId,
        city: cityName,
        trip_intent: intent,
        intent_vibe: intentVibe,
        history_types: userHistory.types,
        history_vibes: userHistory.vibes,
        history_biz: userHistory.bizIds,
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

  /**
   * Region-allocation wizard, step 1: retrieves the same candidate pool
   * `planItinerary` would, but skips hotel selection entirely (no hotel
   * exists yet) and asks ai-service for cheap macro-cluster detection only.
   */
  async detectRegions(
    dto: CreateItineraryDto,
    topK = 60,
    config: TwoTowerRuntimeConfig = DEFAULT_TWO_TOWER_RUNTIME_CONFIG,
  ): Promise<RegionDetectionResult> {
    const numDays = this.calcNumDays(dto.startDate, dto.endDate);
    const retrieval = await this.retrieveCandidates(dto, topK, config);
    const details = await this.fetchPlannerPlaceDetails(retrieval.candidates);
    if (!details.length) {
      throw new NotFoundException(
        'No place details found for itinerary planning',
      );
    }
    return this.mlClient.detectRegions({
      places: details,
      num_days: numDays,
      daily_start_time: dto.dailyStartTime,
      daily_end_time: dto.dailyEndTime,
    });
  }

  async planItinerary(
    dto: CreateItineraryDto,
    topK = 60,
    plannerEngine: PlannerEngine = 'scheduler_v2',
    config: TwoTowerRuntimeConfig = DEFAULT_TWO_TOWER_RUNTIME_CONFIG,
  ): Promise<unknown> {
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
    const retrieval = await this.retrieveCandidates(dto, topK, config);
    const retrievalMs = Date.now() - retrievalStartedAt;
    const plannerCandidates = retrieval.candidates;
    const detailsStartedAt = Date.now();
    let details = await this.fetchPlannerPlaceDetails(plannerCandidates);
    if (dto.regionAllocations?.length) {
      // User has confirmed the region-allocation wizard (see
      // REGION_ALLOCATION_REQUIRED) — drop attraction/entertainment
      // candidates from regions the user assigned 0 days to. Hotels,
      // restaurants, AND cafes are never part of the region wizard (ai-service's
      // detect_regions()/assign() only cluster attraction/entertainment places —
      // see geo_clustering.py), so leave them untouched here. Cafes used to be
      // listed as region-scoped too, which silently filtered out every cafe
      // candidate (their id could never be in keptPlaceIds since no region's
      // place_ids ever contains a cafe) — that starved every itinerary of cafes
      // once the region wizard became mandatory.
      const keptPlaceIds = new Set(
        dto.regionAllocations
          .filter((allocation) => allocation.days > 0)
          .flatMap((allocation) => allocation.placeIds),
      );
      const regionScopedTypes = new Set(['attraction', 'entertainment']);
      details = details.filter(
        (place) =>
          !regionScopedTypes.has(place.place_type ?? '') ||
          keptPlaceIds.has(place.id),
      );
    }
    const detailsMs = Date.now() - detailsStartedAt;
    if (!details.length) {
      throw new NotFoundException(
        'No place details found for itinerary planning',
      );
    }
    if (!details.some((place) => place.place_type === 'hotel')) {
      throw new NotFoundException(
        'No real hotel/accommodation candidate found for itinerary planning',
      );
    }

    const attractionCount = details.filter(
      (p) => p.place_type === 'attraction',
    ).length;
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

    const hotelSelection = this.selectHotelByEstimatedPrice(
      details,
      dto.adultCount,
      dto.childCount ?? 0,
      Math.max(1, numDays - 1),
      Number(dto.budget ?? 0),
      dto.regionAllocations ?? [],
    );
    const selectedHotel = details.find(
      (place) => place.id === hotelSelection.hotelId,
    );
    if (selectedHotel) {
      selectedHotel.price_basis = 'per_person_per_night';
    }
    this.logger.warn(
      `Selected hotel ${hotelSelection.hotelId}: ` +
        `price/person/night=${hotelSelection.pricePerPersonPerNight}, ` +
        `people=${hotelSelection.fullPeople}, nights=${hotelSelection.nights}, ` +
        `cost=${hotelSelection.hotelTotalCost}, relaxed=${hotelSelection.budgetRelaxed}, ` +
        `avgDistanceKmToDenseCluster=${hotelSelection.score.toFixed(2)}, ` +
        `candidateRank=${hotelSelection.candidateRank}`,
    );

    const fallbackRestaurants = await this.fetchFallbackRestaurants(
      dto.destinationLocationId,
      new Set(details.map((place) => place.id)),
    );
    if (fallbackRestaurants.length > 0) {
      this.logger.warn(
        `Fallback restaurant pool: ${fallbackRestaurants.length} candidates`,
      );
    }

    const payload: ItineraryPlanPayload = {
      places: details,
      fallback_restaurants: fallbackRestaurants,
      num_days: numDays,
      daily_start_time: dto.dailyStartTime,
      daily_end_time: dto.dailyEndTime,
      trip_start_date: dto.startDate,
      adult_count: dto.adultCount,
      child_count: dto.childCount ?? 0,
      trip_budget_total: dto.budget ?? 0,
      selected_hotel_id: hotelSelection.hotelId,
      hotel_total_cost: hotelSelection.hotelTotalCost,
      // Prefer real road travel times. The AI service still reads its cache
      // first and falls back to Haversine when Goong is unavailable.
      use_goong: true,
      require_goong: false,
      travel_vehicle: this.resolveGoongVehicle(dto.transportMode),
      population_size: 50,
      generations: 120,
      mutation_rate: 0.3,
      seed: 42,
      planner_engine: plannerEngine,
      region_day_allocations: dto.regionAllocations?.length
        ? dto.regionAllocations
            .filter((allocation) => allocation.days > 0)
            .map((allocation) => ({
              place_ids: allocation.placeIds,
              days: allocation.days,
            }))
        : undefined,
    };

    try {
      const aiStartedAt = Date.now();
      const plan = await this.mlClient.planItinerary(payload);
      const aiPlannerMs = Date.now() - aiStartedAt;
      const enrichedPlan =
        plan != null && typeof plan === 'object'
          ? {
              ...plan,
              hotel_selection: {
                hotel_id: hotelSelection.hotelId,
                hotel_total_cost: hotelSelection.hotelTotalCost,
                price_per_person_per_night:
                  hotelSelection.pricePerPersonPerNight,
                group_nightly_cost: hotelSelection.groupNightlyCost,
                full_people: hotelSelection.fullPeople,
                nights: hotelSelection.nights,
                budget_relaxed: hotelSelection.budgetRelaxed,
                avg_distance_km_to_dense_cluster: Number(
                  hotelSelection.score.toFixed(3),
                ),
                candidate_rank: hotelSelection.candidateRank,
              },
              // Used by ItineraryService.getAddPlaceSuggestions later.
              leftover_candidate_ids: this.computeLeftoverCandidateIds(
                details,
                plan,
                hotelSelection.hotelId,
              ),
            }
          : plan;
      this.logItineraryRunJson({
        dto,
        topK,
        numDays,
        retrieval,
        details,
        plan: enrichedPlan,
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
      return enrichedPlan;
    } catch (err: any) {
      const detail = err?.message ?? String(err);
      throw new ServiceUnavailableException(`AI Service error: ${detail}`);
    }
  }

  /**
   * Hydrated candidates minus what the planner actually scheduled (all days
   * + hotel), minus 'hotel'/'restaurant'/'cafe' — add-place suggestions are
   * attractions/entertainment only.
   */
  private computeLeftoverCandidateIds(
    details: ItineraryPlanPayload['places'],
    plan: any,
    hotelId?: string | null,
  ): string[] {
    const chosenIds = new Set<string>();
    if (hotelId) chosenIds.add(hotelId);
    const days = Array.isArray(plan?.days) ? plan.days : [];
    for (const day of days) {
      const schedule = Array.isArray(day?.schedule) ? day.schedule : [];
      for (const entry of schedule) {
        if (entry?.location_id) chosenIds.add(entry.location_id);
      }
    }
    const excludedTypes = new Set(['hotel', 'restaurant', 'cafe']);
    return details
      .filter(
        (place) =>
          !excludedTypes.has(place.place_type ?? '') &&
          !chosenIds.has(place.id),
      )
      .map((place) => place.id);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private calcNumDays(startDate: string, endDate: string): number {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
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
          this.logger.warn(
            `fetchBySlot [${slotType}] succeeded on attempt ${attempt}`,
          );
        }
        const candidates = (data ?? []) as PlaceCandidate[];
        if (
          slotType === 'attraction' &&
          travelType &&
          candidates.length === 0
        ) {
          this.logger.warn(
            `fetchBySlot [${slotType}] returned 0 with travelType="${travelType}", retrying without travelType`,
          );
          const { data: fallbackData, error: fallbackError } =
            await supabase.rpc('recommend_places_by_slot', {
              query_embedding: `[${embedding.join(',')}]`,
              target_city_id: cityId,
              p_slot_type: slotType,
              p_limit: effectiveLimit,
              p_travel_type: null,
            });

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
        'id,name,longitude,latitude,district_old,open_hour_compressed,source,type_id,slot_type,visit_duration,average_rating,review_count,price,price_inferred,best_time,types(name,categories(id,name))',
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
        // slot_type lấy trực tiếp từ travel.places.slot_type
        const candidateCategory = normalizeCategory(
          row.slot_type ?? candidate?.category ?? '',
          typeData?.name ?? '',
        );
        const placeType = resolvePlannerPlaceType(
          candidateCategory,
          categoryId,
          categoryName,
          typeData?.name ?? '',
        );
        const rawPrice =
          row.price == null || row.price === '' ? null : Number(row.price);
        const normalizedPrice =
          rawPrice != null && Number.isFinite(rawPrice) && rawPrice > 0
            ? Math.round(rawPrice)
            : 0;
        const estimatedCost = normalizedPrice;
        const rawBestTime = String(row.best_time ?? '')
          .trim()
          .toUpperCase();
        const bestTime = [
          'MORNING',
          'AFTERNOON',
          'NIGHT',
          'ALL_DAY',
        ].includes(rawBestTime)
          ? (rawBestTime as 'MORNING' | 'AFTERNOON' | 'NIGHT' | 'ALL_DAY')
          : null;
        return {
          id: row.id,
          name: row.name,
          longitude: Number(row.longitude),
          latitude: Number(row.latitude),
          district_old: row.district_old ?? null,
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
          review_count:
            row.review_count != null ? Number(row.review_count) : null,
          retrieval_score: candidate?.cosine_score ?? null,
          candidate_rank: candidateMeta?.index ?? null,
          candidate_total: candidates.length,
          estimated_cost: estimatedCost,
          price_min: rawPrice != null && rawPrice > 0 ? normalizedPrice : null,
          price_max: rawPrice != null && rawPrice > 0 ? normalizedPrice : null,
          price_basis:
            placeType === 'hotel' ? 'per_person_per_night' : 'per_person',
          price_inferred:
            typeof row.price_inferred === 'boolean' ? row.price_inferred : null,
          best_time: bestTime,
          best_time_source: bestTime ? 'database' : null,
          planner_source: 'two_tower',
        };
      })
      .sort(
        (a: any, b: any) =>
          (a.candidate_rank ?? 999_999) - (b.candidate_rank ?? 999_999),
      );
  }

  // Đủ để SchedulerV2Planner._ensure_restaurant_coverage() (ai-service) có
  // dư lựa chọn bổ sung cho các ngày thiếu quán ăn — không cần nhiều vì chỉ
  // dùng khi candidate theo sở thích không phủ hết địa lý của chuyến.
  private static readonly FALLBACK_RESTAURANT_LIMIT = 60;

  /**
   * Pool nhà hàng dự phòng cho cả điểm đến — KHÔNG lọc theo sở thích/two-tower
   * (khác hẳn fetchPlannerPlaceDetails/retrieveCandidates), chỉ để ai-service
   * bổ sung vào ngày nào bị thiếu ứng viên nhà hàng sau khi cluster theo địa
   * lý (xem geo_clustering.py + SchedulerV2Planner._ensure_restaurant_coverage
   * ở ai-service). Dùng đúng resolvePlannerPlaceType() đã có sẵn để phân loại
   * "restaurant" — KHÔNG viết lại logic đó ở phía ai-service (Python), tránh
   * 2 định nghĩa "thế nào là nhà hàng" lệch nhau theo thời gian.
   */
  private async fetchFallbackRestaurants(
    cityId: string,
    excludeIds: Set<string>,
  ): Promise<ItineraryPlanPayload['places']> {
    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .select(
        'id,name,longitude,latitude,district_old,open_hour_compressed,source,type_id,slot_type,visit_duration,average_rating,review_count,price,price_inferred,best_time,types(name,categories(id,name))',
      )
      .eq('city_id', cityId)
      .eq('is_approved', true)
      .eq('is_active', true)
      // Lấy dư ra rồi lọc type ở Node — resolvePlannerPlaceType() cần JOIN
      // types/categories mới phân loại chính xác, không lọc được thẳng qua
      // 1 cột duy nhất ở tầng PostgREST.
      .order('average_rating', { ascending: false, nullsFirst: false })
      .limit(RecommendationService.FALLBACK_RESTAURANT_LIMIT * 4);

    if (error) {
      this.logger.warn(`fetchFallbackRestaurants error: ${error.message}`);
      return [];
    }

    return (data ?? [])
      .filter(
        (row: any) =>
          row.longitude != null &&
          row.latitude != null &&
          !excludeIds.has(row.id),
      )
      .map((row: any) => {
        const typeData = Array.isArray(row.types) ? row.types[0] : row.types;
        const categoryData = Array.isArray(typeData?.categories)
          ? typeData.categories[0]
          : typeData?.categories;
        const categoryId = categoryData?.id ?? null;
        const categoryName = categoryData?.name ?? null;
        const candidateCategory = normalizeCategory(
          row.slot_type ?? '',
          typeData?.name ?? '',
        );
        const placeType = resolvePlannerPlaceType(
          candidateCategory,
          categoryId,
          categoryName,
          typeData?.name ?? '',
        );
        if (placeType !== 'restaurant') return null;

        const rawPrice =
          row.price == null || row.price === '' ? null : Number(row.price);
        const normalizedPrice =
          rawPrice != null && Number.isFinite(rawPrice) && rawPrice > 0
            ? Math.round(rawPrice)
            : 0;
        const rawBestTime = String(row.best_time ?? '')
          .trim()
          .toUpperCase();
        const bestTime = [
          'MORNING',
          'AFTERNOON',
          'NIGHT',
          'ALL_DAY',
        ].includes(rawBestTime)
          ? (rawBestTime as 'MORNING' | 'AFTERNOON' | 'NIGHT' | 'ALL_DAY')
          : null;

        return {
          id: row.id,
          name: row.name,
          longitude: Number(row.longitude),
          latitude: Number(row.latitude),
          district_old: row.district_old ?? null,
          place_type: 'restaurant' as const,
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
          review_count:
            row.review_count != null ? Number(row.review_count) : null,
          retrieval_score: null,
          candidate_rank: null,
          candidate_total: null,
          estimated_cost: normalizedPrice,
          price_min: rawPrice != null && rawPrice > 0 ? normalizedPrice : null,
          price_max: rawPrice != null && rawPrice > 0 ? normalizedPrice : null,
          price_basis: 'per_person',
          price_inferred:
            typeof row.price_inferred === 'boolean' ? row.price_inferred : null,
          best_time: bestTime,
          best_time_source: bestTime ? 'database' : null,
          planner_source: 'fallback_restaurant_pool',
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .slice(0, RecommendationService.FALLBACK_RESTAURANT_LIMIT);
  }

  private selectHotelByEstimatedPrice(
    places: ItineraryPlanPayload['places'],
    adultCount: number,
    childCount: number,
    nights: number,
    tripBudgetTotal: number,
    regionAllocations: RegionAllocationDto[] = [],
  ): HotelSelection {
    const hotels = places.filter((place) => place.place_type === 'hotel');
    const safeAdults = Math.max(0, Math.trunc(adultCount));
    const safeChildren = Math.max(0, Math.trunc(childCount));
    // fullPeople is the real guest headcount, kept for display/logging only —
    // hotel cost below is per-adult, never multiplied by headcount.
    const fullPeople = Math.max(1, safeAdults + safeChildren);
    const stayNights = Math.max(1, Math.trunc(nights));

    // (a) Geographic centrality: minimize average distance to the POIs in
    // the densest tourist-attraction cluster. detect_regions() (HDBSCAN)
    // already labeled the largest cluster "Vùng Trung Tâm" before the
    // region-allocation wizard ran, and each wizard allocation preserves its
    // region's original placeIds grouping — so the confirmed allocation with
    // the most placeIds IS that same densest cluster. No need to re-derive
    // density here.
    const activeAllocations = regionAllocations.filter(
      (allocation) => allocation.days > 0,
    );
    const densePlaceIds = activeAllocations.length
      ? new Set(
          activeAllocations.reduce((largest, current) =>
            current.placeIds.length > largest.placeIds.length
              ? current
              : largest,
          ).placeIds,
        )
      : null;
    const denseClusterPlaces = densePlaceIds
      ? places.filter((place) => densePlaceIds.has(place.id))
      : places.filter((place) =>
          ['attraction', 'cafe', 'entertainment'].includes(
            place.place_type ?? '',
          ),
        );

    const avgDistanceToDenseCluster = (
      hotel: ItineraryPlanPayload['places'][number],
    ): number => {
      if (!denseClusterPlaces.length) return 0;
      const total = denseClusterPlaces.reduce(
        (sum, place) =>
          sum +
          this.haversineKm(
            Number(hotel.latitude),
            Number(hotel.longitude),
            Number(place.latitude),
            Number(place.longitude),
          ),
        0,
      );
      return total / denseClusterPlaces.length;
    };

    const candidates: HotelSelection[] = [];
    for (const hotel of hotels) {
      const pricePerPersonPerNight = Math.max(
        0,
        Math.round(Number(hotel.estimated_cost ?? 0)),
      );
      if (pricePerPersonPerNight <= 0) continue;
      const groupNightlyCost = pricePerPersonPerNight;
      const hotelTotalCost = groupNightlyCost * stayNights;

      // (b) Budget safety: room price must not exceed 40% of the total trip
      // budget. Prefer hotels within that cap; only fall back to an
      // over-cap hotel below if literally none qualify (budget too small
      // for any real option), rather than failing the whole itinerary.
      const hotelBudgetCap = tripBudgetTotal * 0.4;

      candidates.push({
        hotelId: hotel.id,
        pricePerPersonPerNight,
        groupNightlyCost,
        hotelTotalCost,
        fullPeople,
        nights: stayNights,
        score: avgDistanceToDenseCluster(hotel),
        candidateRank: Number(hotel.candidate_rank ?? Number.MAX_SAFE_INTEGER),
        budgetRelaxed: hotelBudgetCap > 0 && hotelTotalCost > hotelBudgetCap,
      });
    }

    if (!candidates.length) {
      throw new NotFoundException(
        'Không tìm thấy khách sạn có giá ước tính/người/đêm hợp lệ',
      );
    }

    const withinBudget = candidates.filter(
      (candidate) => !candidate.budgetRelaxed,
    );
    const pool = withinBudget.length ? withinBudget : candidates;

    // (c) Suggestion score (candidate_rank / two-tower retrieval rank) only
    // breaks ties when two hotels are essentially equidistant (<50m apart)
    // from the dense cluster.
    return [...pool].sort((left, right) => {
      const distanceDiff = left.score - right.score;
      if (Math.abs(distanceDiff) >= 0.05) return distanceDiff;
      return left.candidateRank - right.candidateRank;
    })[0];
  }

  private haversineKm(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const radians = (value: number) => (value * Math.PI) / 180;
    const deltaLat = radians(lat2 - lat1);
    const deltaLng = radians(lng2 - lng1);
    const value =
      Math.sin(deltaLat / 2) ** 2 +
      Math.cos(radians(lat1)) *
        Math.cos(radians(lat2)) *
        Math.sin(deltaLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
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
    if (days.length === 2 && days[0] === 'Sat' && days[1] === 'Sun') {
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
    const counts = candidates.reduce<Record<string, number>>(
      (acc, candidate) => {
        const key = candidate.category ?? 'unknown';
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      },
      {},
    );
    return Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
  }

  private countCandidates(
    candidates: CandidatePlaceDto[],
  ): Record<string, number> {
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
          : (entry.place_type ?? 'attraction');
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
      bucket.activeDurationMinutes += Number(
        entry.active_duration_minutes ?? 0,
      );
      bucket.distanceKm = Number(
        (bucket.distanceKm + Number(entry.distance_km ?? 0)).toFixed(2),
      );
      acc[key] = bucket;
      return acc;
    }, {});
  }

  private aggregateDaysByType(days: any[]): Record<string, any> {
    return days.reduce<Record<string, any>>((acc, day) => {
      const dayTotals = this.aggregateScheduleByType(
        Array.isArray(day.schedule) ? day.schedule : [],
      );
      for (const [key, value] of Object.entries(dayTotals)) {
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
        bucket.distanceKm = Number(
          (bucket.distanceKm + value.distanceKm).toFixed(2),
        );
        acc[key] = bucket;
      }
      return acc;
    }, {});
  }

  private estimateTripCostFromPrices(
    dto: CreateItineraryDto,
    numDays: number,
    days: any[],
    details: ItineraryPlanPayload['places'],
    hotelId: string | null | undefined,
  ): Record<string, any> {
    const adults = Number(dto.adultCount ?? 0);
    const children = Number(dto.childCount ?? 0);
    const fullPeople = adults + children;
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
          : (entry.place_type ?? 'attraction');
      if (type === 'return_to_hotel') continue;
      const cost = Math.max(0, Math.round(Number(entry.estimated_cost ?? 0)));
      if (entry.estimated_cost == null) {
        confidence.missing += 1;
      } else if (entry.price_inferred === false) confidence.observed += 1;
      else if (entry.price_inferred === true) confidence.inferred += 1;
      else confidence.missing += 1;
      byType[type] = (byType[type] ?? 0) + cost;
      variableCost += cost;
    }

    const hotelDetail = details.find((place) => place.id === hotelId);
    const hotelPerPersonPerNight = Math.max(
      0,
      Math.round(Number(hotelDetail?.estimated_cost ?? 0)),
    );
    const hotel = Math.round(hotelPerPersonPerNight * nights);
    if (hotelDetail?.estimated_cost == null) {
      confidence.missing += 1;
    } else if (hotelDetail.price_inferred === false) {
      confidence.observed += 1;
    } else if (hotelDetail.price_inferred === true) {
      confidence.inferred += 1;
    }
    const transport = Math.round(
      days.reduce(
        (sum: number, day: any) => sum + Number(day.total_transport_cost ?? 0),
        0,
      ),
    );
    const total = Math.round(hotel + variableCost + transport);
    const totalBudget = Number(dto.budget ?? 0);
    return {
      mode: 'database_place_price',
      note: 'All places.price values are per adult. Hotel price is per adult per night; nothing here is multiplied by headcount.',
      assumptionsVnd: {},
      confidence,
      travelers: { adults, children, fullPeople },
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
        plannerBySource: args.details.reduce<Record<string, number>>(
          (acc, place) => {
            const key = place.planner_source ?? 'two_tower';
            acc[key] = (acc[key] ?? 0) + 1;
            return acc;
          },
          {},
        ),
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
        rank:
          place.candidate_rank != null
            ? Number(place.candidate_rank) + 1
            : index + 1,
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
        bestTime: place.best_time ?? null,
        bestTimeSource: place.best_time_source ?? null,
        plannerSource: place.planner_source ?? 'two_tower',
        latitude: place.latitude ?? null,
        longitude: place.longitude ?? null,
      })),
      timingsMs: {
        twoTower: args.timings.twoTowerMs,
        fetchPlannerDetails: args.timings.detailsMs,
        aiPlannerHttp: args.timings.aiPlannerMs,
        aiTotal: plan.total_ms ?? null,
        goongMatrix: plan.matrix_ms ?? null,
        ga: plan.ga_ms ?? null,
        solver: plan.solver_ms ?? null,
        backendTotal: args.timings.backendTotalMs,
      },
      plannerEngine: plan.planner_engine ?? 'scheduler_v2',
      travelSourceCounts: plan.travel_source_counts ?? {},
      hotel: {
        id: plan.hotel_id ?? null,
        name: plan.hotel_name ?? null,
      },
      assignment: {
        dayLoads: plan.assignment_day_loads ?? [],
        warnings: plan.assignment_warnings ?? [],
        dayPools: plan.assignment_debug ?? [],
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
        args.details,
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
                  : (entry.place_type ?? 'attraction');
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
                estimatedCost: entry.estimated_cost ?? 0,
                priceMin: null,
                priceMax: null,
                priceBasis: entry.price_basis ?? 'group_total',
                priceInferred: entry.price_inferred ?? null,
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
      const generatedAt = String(
        report.generatedAt ?? new Date().toISOString(),
      );
      const timestamp = generatedAt.replace(/[:.]/g, '-');
      const intent = this.slugifyFilePart(request.tripIntent ?? 'unknown');
      const destination = this.slugifyFilePart(
        request.destinationName ?? 'unknown',
      );
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
        this.toCsv(
          (report.plannerInputPlaces ?? []) as Array<Record<string, any>>,
        ),
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
    return (
      String(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
        .slice(0, 48) || 'unknown'
    );
  }

  private flattenScheduleReport(
    report: Record<string, any>,
  ): Array<Record<string, any>> {
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
    const text =
      typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }
}
