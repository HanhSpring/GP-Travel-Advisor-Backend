import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { supabase } from '../../config/supabase';
import { ItineraryPlanPayload, MlClientService } from './ml-client.service';
import { CreateItineraryDto } from '../itinerary/dto/create-itinerary.dto';
import {
  TwoTowerRetrievalResponseDto,
  CandidatePlaceDto,
} from '../itinerary/dto/retrieval-response.dto';
import {
  diversifyTopK,
  getStratifiedFetchPlan,
  PlaceCandidate,
  parseTripIntents,
  dedupeByPlaceIdKeepBestScore,
} from './utils/mmr-rerank';
import { resolveIntentVibe } from './utils/intent-vibe';
import {
  DEFAULT_TWO_TOWER_RUNTIME_CONFIG,
  TwoTowerRuntimeConfig,
} from './two-tower-config.types';

@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);
  private readonly foodCategoryId = '97029cfb-069b-4dba-a152-dfb3d36634d3';

  constructor(private readonly mlClient: MlClientService) {}

  /**
   * Two-Tower retrieval pipeline với late fusion cho multi-intent:
   *   1. Parse intents từ dto.tripIntent, resolve intent_vibe
   *   2. Với mỗi intent: encode query riêng + stratified slot fetch
   *   3. Gộp tất cả pools → dedupe giữ score cao nhất → diversifyTopK
   *
   * Đảm bảo mỗi lần gọi AI-service chỉ nhận 1 scalar trip_intent hợp lệ,
   * nhất quán với cách model v15 được train.
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

    // ── 1. City name + số ngày ────────────────────────────────────────────────
    const cityName = await this.getCityName(dto.destinationLocationId);
    const numDays = this.calcNumDays(dto.startDate, dto.endDate);

    // ── 2. Parse intents + resolve vibe ──────────────────────────────────────
    const selectedIntents = parseTripIntents(dto.tripIntent);
    // Nếu "Khám phá tổng hợp" đi cùng intent cụ thể → bỏ intent tổng hợp
    const specificIntents = selectedIntents.filter(
      (i) => i !== 'Khám phá tổng hợp',
    );
    const rawIntents =
      specificIntents.length > 0 ? specificIntents : selectedIntents;
    // Fallback khi không parse được intent nào hợp lệ
    const intents =
      rawIntents.length > 0
        ? rawIntents.slice(0, runtimeConfig.maxIntents)
        : ['Khám phá tổng hợp'];
    const intentVibe = resolveIntentVibe(dto.adultCount, dto.childCount);

    this.logger.debug(
      { selectedIntents: intents, intentVibe, numDays, topK: safeTopK },
      'multi-intent late fusion retrieval',
    );

    // ── 3. Late fusion: retrieval riêng cho từng intent (song song) ──────────
    const allPools = await Promise.all(
      intents.map((intent) =>
        this.retrieveCandidatesForSingleIntent({
          dto,
          cityId: dto.destinationLocationId,
          cityName,
          intent,
          intentVibe,
          numDays,
          config: runtimeConfig,
        }),
      ),
    );

    // ── 4. Merge + dedupe giữ score cao nhất ─────────────────────────────────
    const merged = dedupeByPlaceIdKeepBestScore(allPools.flat());
    this.logger.debug(`merged=${merged.length} final before diversify`);

    // ── 5. Diversity-aware top-K ──────────────────────────────────────────────
    const diversePool = diversifyTopK(
      merged,
      numDays,
      intents.join(', '),
      safeTopK,
      {
        intentQuota: runtimeConfig.intentQuota,
        enableDiversityBudget: runtimeConfig.enableDiversityBudget,
      },
    );
    this.logger.debug(`final=${diversePool.length}`);

    // ── 6. Map → response DTO ─────────────────────────────────────────────────
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

  /**
   * Retrieval cho một intent đơn lẻ: encode query → stratified slot fetch.
   * Chỉ truyền scalar trip_intent vào AI-service, không truyền chuỗi ghép.
   */
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

    // Dedupe trong pool của 1 intent (các slot khác nhau có thể trả về cùng place)
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

  async planItinerary(dto: CreateItineraryDto, topK = 60): Promise<unknown> {
    const numDays = this.calcNumDays(dto.startDate, dto.endDate);
    const runStartedAt = Date.now();
    const retrievalStartedAt = Date.now();
    const retrieval = await this.retrieveCandidates(dto, topK);
    const retrievalMs = Date.now() - retrievalStartedAt;
    const plannerCandidates = retrieval.candidates;
    const detailsStartedAt = Date.now();
    const details = await this.fetchPlannerPlaceDetails(plannerCandidates);
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
          typeData?.name ?? '',
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
    typeName?: string | null,
  ): 'hotel' | 'restaurant' | 'cafe' | 'entertainment' | 'attraction' {
    const category = (candidateCategory ?? '').toLowerCase();
    const name = (categoryName ?? '').toLowerCase();
    const type = (typeName ?? '').toLowerCase();
    if (category === 'accommodation' || category === 'hotel') {
      return 'hotel';
    }
    if (
      category === 'cafe' ||
      type.includes('cafe') ||
      type.includes('coffee')
    ) {
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

  private logItineraryRunJson(args: {
    dto: CreateItineraryDto;
    topK: number;
    numDays: number;
    retrieval: TwoTowerRetrievalResponseDto;
    details: ItineraryPlanPayload['places'];
    plan: unknown;
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
        aiInputPlaces: plan.input_places ?? null,
        aiTotalVisited: plan.total_visited ?? null,
      },
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
      days: days.map((day: any) => ({
        day: day.day,
        visitedCount: day.visited_count,
        restaurantCount: day.restaurant_count,
        fitness: day.fitness,
        totalTravelMinutes: day.total_travel_minutes,
        totalDistanceKm: day.total_distance_km,
        totalVisitMinutes: day.total_visit_minutes,
        totalWaitMinutes: day.total_wait_minutes,
        stoppedReason: day.stopped_reason,
        schedule: Array.isArray(day.schedule)
          ? day.schedule.map((entry: any, index: number) => ({
              sequence: index + 1,
              locationId: entry.location_id,
              locationName: entry.location_name,
              fromId: entry.travel_from_id,
              fromName: entry.travel_from_name,
              type: entry.is_return_to_hotel
                ? 'return_to_hotel'
                : entry.is_restaurant
                  ? 'restaurant'
                  : (entry.place_type ?? 'attraction'),
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
              activeDurationMinutes: entry.active_duration_minutes,
              unknownHours: entry.unknown_hours,
            }))
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
      mkdirSync(dir, { recursive: true });

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
      const content = JSON.stringify(report, null, 2);

      writeFileSync(join(dir, filename), content, 'utf8');
      writeFileSync(join(dir, 'latest.json'), content, 'utf8');
      this.logger.warn(`ITINERARY_PLAN_DEBUG_FILE ${join(dir, filename)}`);
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
}
