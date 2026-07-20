import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { supabase } from '../../config/supabase';
import { EditActivityDto } from './dto/edit-activity.dto';
import { AddActivityDto } from './dto/add-activity.dto';
import { ReplaceActivityDto } from './dto/replace-activity.dto';
import { ShareItineraryDto } from './dto/share-itinerary.dto';
import { RespondItineraryShareDto } from './dto/respond-itinerary-share.dto';
import { CreateItineraryShareLinkDto } from './dto/create-itinerary-share-link.dto';
import { RespondItineraryShareLinkDto } from './dto/respond-itinerary-share-link.dto';
import { LUNCH_START_MIN, LUNCH_END_MIN } from '../../common/constants/lunch-window.constant';

import { CreateItineraryDto, TransportMode } from './dto/create-itinerary.dto';
import { HotelRoomResponseDto } from './dto/hotel-room-response.dto';
import { getRoomsByPlaceId } from './room-catalog';
import {
  TripCostConfig,
  TripCostConfigService,
} from '../recommendation/trip-cost-config.service';
import { RecommendationsService } from '../tourist/places/recommendations.service';
import { CostType } from './dto/cost-type.enum';
import { normalizeCategory } from '../recommendation/utils/mmr-rerank';
import { resolvePlannerPlaceType } from '../recommendation/utils/place-type.util';

// ─── Địa chỉ FastAPI optimizer (đọc từ env hoặc dùng mặc định) ───
const AI_SERVICE_URL = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';
const APP_DEEP_LINK_SCHEME =
  process.env.APP_DEEP_LINK_SCHEME ?? 'gptraveladvisor';
const APP_PLAY_STORE_URL = process.env.APP_PLAY_STORE_URL ?? null;
const APP_PUBLIC_SHARE_BASE_URL =
  process.env.APP_PUBLIC_SHARE_BASE_URL ??
  process.env.API_PUBLIC_URL ??
  process.env.BASE_URL ??
  null;

interface ScheduleEntry {
  location_id: string;
  location_name: string;
  arrival_time: string;
  service_start_time: string;
  departure_time: string;
  active_duration_minutes: number;
  estimated_cost?: number;
  travel_minutes: number;
  distance_km: number;
  transport_cost?: number;
  is_return_to_hotel: boolean;
  is_restaurant?: boolean;
}

interface PlanDay {
  day: number;
  visited_count: number;
  schedule: ScheduleEntry[];
  stopped_reason?: string;
  meal_violations?: number | null;
}

export interface AIPlanResult {
  hotel_id?: string;
  hotel_name?: string;
  hotel_selection?: {
    hotel_total_cost?: number;
    price_per_person_per_night?: number;
    group_nightly_cost?: number;
    full_people?: number;
    nights?: number;
  };
  num_days: number;
  total_visited: number;
  days: PlanDay[];
}

@Injectable()
export class ItineraryService {
  private readonly logger = new Logger(ItineraryService.name);

  // Chống cache-stampede: nhiều lời gọi hydrateMissingTravelSnapshots đồng thời
  // (nhiều itinerary trong 1 list, nhiều candidate khi generate plan) có thể
  // cùng phát hiện 1 cặp (origin, destination, mode) chưa có trong
  // distance_matrix TẠI CÙNG THỜI ĐIỂM — nếu không dedupe, tất cả sẽ tự gọi
  // Goong riêng cho cùng 1 cặp, dội rate limit (429) dù distance_matrix đã có
  // sẵn hàng chục nghìn dòng. Map này đảm bảo chỉ 1 request thật sự đi gọi
  // Goong cho mỗi cặp, các request khác chờ dùng chung kết quả.
  private readonly pendingGoongLegRequests = new Map<string, Promise<any | null>>();

  constructor(
    private readonly tripCostConfig: TripCostConfigService,
    private readonly recommendationsService: RecommendationsService,
  ) {}

  private async mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  async getHotelRooms(placeId: string): Promise<HotelRoomResponseDto[]> {
    const normalizedPlaceId = placeId?.trim();
    if (!normalizedPlaceId) {
      throw new BadRequestException('placeId is required');
    }

    let rows;
    try {
      rows = await getRoomsByPlaceId(normalizedPlaceId);
    } catch (error) {
      this.logger.error(`getHotelRooms failed: ${String(error)}`);
      throw new InternalServerErrorException(
        'Không thể tải danh sách phòng khách sạn',
      );
    }

    return rows
      .map((row) => ({
        id: row.id,
        placeId: row.place_id,
        roomName: row.room_name,
        roomType: row.room_type,
        quantity: row.quantity,
        price: row.price,
      }))
      .filter(
        (room) =>
          room.roomName.length > 0 &&
          Number.isFinite(room.price) &&
          room.price > 0 &&
          Number.isFinite(room.quantity) &&
          room.quantity > 0,
      );
  }

  // ════════════════════════════════════════════════════════════════
  // ITINERARY CRUD + LIST QUERIES
  // ════════════════════════════════════════════════════════════════

  /**
   * Returns the current user's itinerary list through the Supabase RPC.
   *
   * `query` comes from GET /itinerary/my-itineraries?q=...
   * The RPC currently searches the trip name stored in `itineraries.description`.
   * Keep this in sync with travel.get_my_itineraries(p_user_id, p_query).
   */
  async getMyItineraries(userId: string, query?: string) {
    const trimmedQuery = query?.trim() || null;
    const t0 = Date.now();
    const { data, error } = await supabase
      .schema('travel')
      .rpc('get_my_itineraries', {
        p_user_id: userId,
        p_query: trimmedQuery,
      });
    const tRpc = Date.now();

    if (error) {
      console.error('[ItineraryService] getMyItineraries error:', error);
      throw error;
    }
    const sharedItineraries = await this.getSharedItineraryListItems(
      userId,
      trimmedQuery,
      data?.itineraries ?? [],
    );
    const tShared = Date.now();
    const merged = await this.enrichListTrackingFlags({
      ...(data ?? {}),
      itineraries: [
        ...((data?.itineraries as any[]) ?? []),
        ...sharedItineraries,
      ],
    });
    const tTracking = Date.now();
    const result = await this.withEstimatedListCosts(this.withListStats(merged));
    const tCosts = Date.now();
    const total = tCosts - t0;
    const itineraryCount = Array.isArray((merged as any)?.itineraries)
      ? (merged as any).itineraries.length
      : 0;
    this.logger.warn(
      `getMyItineraries timing user=${userId} count=${itineraryCount} total=${total}ms ` +
        `rpc=${tRpc - t0}ms shared=${tShared - tRpc}ms tracking=${tTracking - tShared}ms costs=${tCosts - tTracking}ms`,
    );
    return result;
  }

  private async enrichListTrackingFlags(payload: any) {
    const itineraries = Array.isArray(payload?.itineraries)
      ? payload.itineraries
      : [];
    const ids = itineraries
      .map((item: any) => item?.id)
      .filter(
        (id: any): id is string => typeof id === 'string' && id.length > 0,
      );
    if (ids.length === 0) return payload;

    const { data, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('id, status, tracking_active')
      .in('id', ids);

    if (error) {
      this.logger.warn(`Cannot enrich tracking flags: ${error.message}`);
      return payload;
    }

    const byId = new Map((data ?? []).map((item: any) => [item.id, item]));
    return {
      ...payload,
      itineraries: itineraries.map((item: any) => {
        const fresh = byId.get(item.id);
        if (!fresh) return item;
        return {
          ...item,
          status: fresh.status ?? item.status,
          tracking_active: fresh.tracking_active === true,
        };
      }),
    };
  }

  private async getSharedItineraryListItems(
    userId: string,
    query: string | null,
    existingItems: any[],
  ) {
    const { data: memberships, error: membershipError } = await supabase
      .schema('travel')
      .from('itinerary_members')
      .select('itinerary_id')
      .eq('tourist_id', userId);

    if (membershipError) {
      this.logger.warn(
        `Cannot load shared itinerary memberships: ${membershipError.message}`,
      );
      return [];
    }

    const existingIds = new Set(
      existingItems
        .map((item) => item?.id)
        .filter((id): id is string => typeof id === 'string'),
    );
    const sharedIds = Array.from(
      new Set(
        (memberships ?? [])
          .map((item: any) => item.itinerary_id)
          .filter(
            (id: any): id is string =>
              typeof id === 'string' && !existingIds.has(id),
          ),
      ),
    );

    if (sharedIds.length === 0) {
      return [];
    }

    let itineraryQuery = supabase
      .schema('travel')
      .from('itineraries')
      .select(
        'id, description, destination, start_date, end_date, status, tracking_active, estimated_cost',
      )
      .in('id', sharedIds)
      .eq('is_deleted', false);

    if (query) {
      itineraryQuery = itineraryQuery.ilike('description', `%${query}%`);
    }

    const { data: itineraries, error: itineraryError } = await itineraryQuery;
    if (itineraryError) {
      this.logger.warn(
        `Cannot load shared itineraries: ${itineraryError.message}`,
      );
      return [];
    }

    const itineraryIds = (itineraries ?? []).map((item: any) => item.id);
    const statsById = await this.getItineraryListStats(itineraryIds);

    return (itineraries ?? []).map((item: any) => {
      const stats = statsById.get(item.id) ?? {
        totalLocations: 0,
        visitedLocations: 0,
        placeImages: [] as string[],
      };
      return {
        id: item.id,
        description: item.description ?? item.destination ?? 'Lịch trình',
        destination: item.destination ?? '',
        start_date: item.start_date,
        end_date: item.end_date,
        status: item.status ?? 'pending',
        tracking_active: item.tracking_active === true,
        days: this.calcListDays(item.start_date, item.end_date),
        progress:
          stats.totalLocations > 0
            ? Math.round((stats.visitedLocations / stats.totalLocations) * 100)
            : 0,
        estimated_cost: item.estimated_cost ?? 0,
        total_locations: stats.totalLocations,
        visited_locations: stats.visitedLocations,
        place_images: stats.placeImages,
        rating: null,
        shared: true,
      };
    });
  }

  private async getItineraryListStats(itineraryIds: string[]) {
    const stats = new Map<
      string,
      {
        totalLocations: number;
        visitedLocations: number;
        placeImages: string[];
      }
    >();
    for (const id of itineraryIds) {
      stats.set(id, {
        totalLocations: 0,
        visitedLocations: 0,
        placeImages: [],
      });
    }
    if (itineraryIds.length === 0) {
      return stats;
    }

    // itinerary_details KHÔNG có cột status — trạng thái "đã ghé" nằm ở
    // tracking.geofence_visits (giống getItineraryDetail). Ở đây chỉ lấy
    // tổng số điểm + ảnh, còn visited đếm qua query thứ hai bên dưới.
    const { data, error } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('id, itinerary_id, detail_type, places(image_url)')
      .in('itinerary_id', itineraryIds);

    if (error) {
      this.logger.warn(`Cannot load shared itinerary stats: ${error.message}`);
      return stats;
    }

    // Dòng khách sạn không phải "địa điểm tham quan" — loại khỏi
    // totalLocations VÀ visitedLocations, khớp với cách các màn khác đếm
    // địa điểm (bỏ qua khách sạn, xem DayCostCalculator.visitActivities()).
    const hotelDetailIds = new Set(
      (data ?? [])
        .filter((row: any) => row.detail_type === 'HOTEL')
        .map((row: any) => row.id),
    );

    for (const row of data ?? []) {
      const itineraryId = (row as any).itinerary_id;
      const current = stats.get(itineraryId);
      if (!current) continue;
      if ((row as any).detail_type === 'HOTEL') continue;
      current.totalLocations += 1;
      const place = Array.isArray((row as any).places)
        ? (row as any).places[0]
        : (row as any).places;
      const imageUrl = place?.image_url;
      if (
        typeof imageUrl === 'string' &&
        imageUrl.length > 0 &&
        current.placeImages.length < 5
      ) {
        current.placeImages.push(imageUrl);
      }
    }

    const { data: visits, error: visitsError } = await supabase
      .schema('tracking')
      .from('geofence_visits')
      .select('itinerary_id, itinerary_detail_id, status')
      .in('itinerary_id', itineraryIds)
      .eq('status', 'visited');

    if (visitsError) {
      this.logger.warn(
        `Cannot load shared itinerary visit stats: ${visitsError.message}`,
      );
      return stats;
    }

    // Một điểm có thể có nhiều bản ghi visit (PK geofence_id + detail_id,
    // nhiều ngày) → đếm theo detail_id duy nhất.
    const visitedDetailIds = new Map<string, Set<string>>();
    for (const v of visits ?? []) {
      const itineraryId = (v as any).itinerary_id;
      if (!stats.has(itineraryId)) continue;
      const detailId = (v as any).itinerary_detail_id;
      if (hotelDetailIds.has(detailId)) continue;
      const set = visitedDetailIds.get(itineraryId) ?? new Set<string>();
      set.add(detailId);
      visitedDetailIds.set(itineraryId, set);
    }
    for (const [itineraryId, detailIds] of visitedDetailIds) {
      const current = stats.get(itineraryId);
      if (current) current.visitedLocations = detailIds.size;
    }

    return stats;
  }

  private calcListDays(startDate?: string | null, endDate?: string | null) {
    if (!startDate || !endDate) return 1;
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T00:00:00.000Z`);
    const diff = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
    return Number.isFinite(diff) ? Math.max(1, diff) : 1;
  }

  private withListStats(payload: any) {
    const itineraries = Array.isArray(payload?.itineraries)
      ? payload.itineraries
      : [];
    const stats = {
      total: itineraries.length,
      completed: itineraries.filter((item: any) => item.status === 'completed')
        .length,
      ongoing: itineraries.filter((item: any) => item.status === 'ongoing')
        .length,
      upcoming: itineraries.filter((item: any) =>
        ['pending', 'upcoming'].includes(item.status),
      ).length,
      draft: itineraries.filter((item: any) => item.status === 'draft').length,
    };

    return { ...payload, stats };
  }

  private async withEstimatedListCosts(payload: any) {
    const itineraries = Array.isArray(payload?.itineraries)
      ? payload.itineraries
      : [];
    const itineraryIds = itineraries
      .map((item: any) => item?.id)
      .filter(
        (id: any): id is string => typeof id === 'string' && id.length > 0,
      );

    if (itineraryIds.length === 0) {
      return payload;
    }

    const { data: itineraryRows, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('id, estimated_cost, adult_count, children_count')
      .in('id', itineraryIds);

    if (error) {
      this.logger.warn(
        `Cannot enrich itinerary list budget metadata: ${error.message}`,
      );
      return payload;
    }

    const metadataByItinerary = new Map(
      (itineraryRows ?? []).map((row: any) => [row.id, row]),
    );

    // 1 query duy nhất cho CẢ danh sách (không còn N query/lịch trình như
    // trước) + childPriceRatio đọc 1 lần (đã cache in-memory 60s ở
    // TripCostConfigService, nhưng đọc trước cho rõ ràng, không phải đọc lại
    // trong vòng lặp).
    const costEstimatesById = await this.getCachedCostBreakdownBatch(itineraryIds);
    const { childPriceRatio } = await this.tripCostConfig.getConfig();

    const enriched = itineraries.map((item: any) => {
      const metadata: any = metadataByItinerary.get(item.id);
      // itineraries.estimated_cost là NGÂN SÁCH người dùng tự nhập (mức có
      // thể chi trả) — KHÔNG phải chi phí ước tính thật của kế hoạch, dù
      // tên cột dễ gây nhầm. Giữ lại field này riêng cho UI nào cần hiện
      // ngân sách, không dùng để suy ra estimatedCostForGroup nữa.
      const estimatedCost = Math.max(
        0,
        Math.round(
          Number(metadata?.estimated_cost ?? item.estimated_cost ?? 0),
        ),
      );
      const adultCount = Math.max(
        0,
        Math.round(Number(metadata?.adult_count ?? item.adult_count ?? 0)),
      );
      const childCount = Math.max(
        0,
        Math.round(
          Number(metadata?.children_count ?? item.children_count ?? 0),
        ),
      );
      const participantCount = Math.max(1, adultCount + childCount);

      // Chi phí hiển thị ở danh sách là TỔNG CẢ CHUYẾN (đã gồm khách sạn +
      // 10% dự trù) — cùng con số với Sổ chi tiêu (roundedGroupTotal).
      // Chỉ riêng "số địa điểm" bên cạnh mới không tính khách sạn (khách
      // sạn không phải "địa điểm tham quan"), 2 con số này khác phạm vi
      // nhau là có chủ đích, không phải cần khớp nhau.
      let estimatedCostForGroup = 0;
      const breakdown = costEstimatesById.get(item.id);
      if (breakdown) {
        estimatedCostForGroup = this.deriveGroupEstimatedCost(
          breakdown,
          adultCount,
          childCount,
          childPriceRatio,
        ).roundedGroupTotal;
      } else {
        this.logger.warn(
          `Missing itinerary_cost_estimates for itinerary ${item.id} after batch backfill`,
        );
      }

      return {
        ...item,
        estimated_cost: estimatedCost,
        estimatedCost,
        estimatedCostForGroup,
        estimated_cost_for_group: estimatedCostForGroup,
        adult_count: adultCount,
        children_count: childCount,
        participant_count: participantCount,
        participantCount,
      };
    });

    return {
      ...payload,
      itineraries: enriched,
    };
  }

  async createGeneratedItinerary(
    dto: CreateItineraryDto,
    plan: AIPlanResult,
  ): Promise<{ id: string; totalDetails: number; status: string }> {
    this.assertPlanIsUsable(plan);

    const [departureName, destinationName] = await Promise.all([
      this.getCityNameOrNull(dto.departureLocationId),
      this.getCityNameOrNull(dto.destinationLocationId),
    ]);

    // Nếu user không nhập ngân sách, KHÔNG được lưu null — nếu không thì
    // userBudget/payableLimit = 0 và mọi cảnh báo 90/95/100% ở "Quản lý chi
    // phí" trở nên vô nghĩa (không có gì để so sánh). Fallback = mức ngân
    // sách đề xuất (calculateRecommendedBudget: chi phí ước tính / 0.9, làm
    // tròn lên hàng triệu) để luôn có 1 "mức có thể chi trả" hợp lý.
    const inputBudget = Number(dto.budget ?? 0);
    const estimatedCostFallback =
      inputBudget > 0
        ? inputBudget
        : this.calculateRecommendedBudget(
            plan,
            dto.adultCount,
            dto.childCount ?? 0,
          ) || null;

    const itineraryInsert: Record<string, any> = {
      creator_id: dto.userId,
      // [TRIP_NAME_INPUT] Lưu tên chuyến đi user đặt vào cột description
      description: dto.description ?? null,
      start_date: dto.startDate,
      end_date: dto.endDate,
      // `estimated_cost` holds the user's payable-limit ceiling (repurposed
      // column, not a computed cost). The actual calculated cost ("Chi phí
      // ước tính") is derived fresh in getItineraryDetail() by summing
      // itinerary_details.estimated_cost (per-adult per row, see
      // recommendation.service.ts) — never stored here, so it stays accurate
      // after the user edits the itinerary (add/remove/replace activity)
      // instead of going stale.
      estimated_cost: estimatedCostFallback,
      status: 'pending',
      departure_point: departureName ?? dto.departureLocationId,
      destination: destinationName ?? dto.destinationLocationId,
      is_public: false,
      adult_count: dto.adultCount,
      children_count: dto.childCount ?? 0,
      trip_intent: dto.tripIntent,
      daily_start_time: dto.dailyStartTime ?? '07:00',
      daily_end_time: dto.dailyEndTime ?? '22:00',
      travel_mode: this.normalizeMatrixTravelMode(dto.transportMode),
      proceeded_over_budget: dto.proceedWithOverBudget === true,
    };

    let insertResult = await supabase
      .schema('travel')
      .from('itineraries')
      .insert(itineraryInsert)
      .select('id')
      .single();

    let retries = 3;
    while (
      insertResult.error &&
      (insertResult.error.message.includes('Could not find the') ||
        insertResult.error.message.includes('column')) &&
      retries > 0
    ) {
      const errorMsg = insertResult.error.message;
      if (errorMsg.includes('daily_start_time'))
        delete itineraryInsert.daily_start_time;
      if (errorMsg.includes('daily_end_time'))
        delete itineraryInsert.daily_end_time;
      if (errorMsg.includes('trip_intent')) delete itineraryInsert.trip_intent;
      if (errorMsg.includes('proceeded_over_budget'))
        delete itineraryInsert.proceeded_over_budget;

      insertResult = await supabase
        .schema('travel')
        .from('itineraries')
        .insert(itineraryInsert)
        .select('id')
        .single();

      retries--;
    }

    const { data: itinerary, error: itineraryError } = insertResult;

    if (itineraryError || !itinerary) {
      throw new InternalServerErrorException(
        'Lỗi khi tạo lịch trình: ' + itineraryError?.message,
      );
    }

    // Fire-and-forget: this is secondary data for getAddPlaceSuggestions,
    // must not slow down or fail itinerary creation.
    const leftoverIds: string[] = (plan as any).leftover_candidate_ids ?? [];
    if (leftoverIds.length > 0) {
      supabase
        .schema('travel')
        .from('itinerary_candidate_places')
        .insert(
          leftoverIds.map((placeId) => ({
            itinerary_id: (itinerary as any).id,
            place_id: placeId,
          })),
        )
        .then(({ error }) => {
          if (error) {
            console.warn(
              '[ItineraryService] Không thể lưu candidates thừa:',
              error.message,
            );
          }
        });
    }

    const placeCostById = await this.getPlaceEstimatedCostMap(plan);
    const hotelTotalCost = Math.max(
      0,
      Math.round(Number(plan.hotel_selection?.hotel_total_cost ?? 0)),
    );
    const hotelRow = this.buildHotelDetailRow(
      (itinerary as any).id,
      plan,
      dto.startDate,
      dto.dailyStartTime,
      hotelTotalCost,
    );
    // ai-service đã resolve xong travel_minutes/distance_km cho từng chặng
    // (cache distance_matrix → Goong → Haversine, xem planner.py) và trả về
    // ngay trong schedule entry — đọc thẳng ra đây thay vì để NULL rồi để
    // recomputeCostEstimate() bên dưới tưởng chặng nào cũng "thiếu dữ liệu"
    // và gọi lại Goong theo từng chặng một lúc persist (chính là nguồn gây
    // chậm persist đã đo được, ~36s cho 1 lịch trình 8 ngày/51 chặng).
    // transport_cost thì AI không tính (không có trong ScheduleEntryResponse
    // Python) nên vẫn phải tính ở đây — nhưng chỉ cần await getConfig() một
    // lần cho toàn bộ chuyến, không phải mỗi chặng một lần.
    const tripCostConfig = await this.tripCostConfig.getConfig();
    const headcount = Math.max(1, Number(dto.adultCount ?? 0) + Number(dto.childCount ?? 0));
    const travelMode = this.normalizeMatrixTravelMode(dto.transportMode);
    const activityRows = plan.days.flatMap((day) => {
      const schedule = Array.isArray(day.schedule) ? day.schedule : [];
      const visitDate = this.addDays(dto.startDate, day.day - 1);
      return schedule
        .filter((entry) => this.shouldPersistScheduleEntry(entry))
        .map((entry, index) => {
          const travelDistanceKm =
            Number.isFinite(entry.distance_km) && entry.distance_km > 0
              ? entry.distance_km
              : null;
          const travelMinutes =
            Number.isFinite(entry.travel_minutes) && entry.travel_minutes > 0
              ? entry.travel_minutes
              : null;
          return {
            itinerary_id: (itinerary as any).id,
            place_id: entry.location_id,
            visit_date: visitDate,
            // itinerary_details.arrival_time is the time shown as the activity
            // start on mobile. A traveller may physically arrive earlier and
            // wait for opening/meal windows, so persist service_start_time.
            arrival_time: entry.service_start_time || entry.arrival_time,
            duration_minutes: entry.active_duration_minutes,
            estimated_cost:
              entry.estimated_cost ?? placeCostById.get(entry.location_id) ?? 0,
            sequence_order: index + 1,
            detail_type: 'ACTIVITY',
            is_locked: false,
            travel_distance_km: travelDistanceKm,
            travel_minutes: travelMinutes,
            transport_cost: travelDistanceKm
              ? this.computeSelfDriveTransportCostSync(
                  travelDistanceKm,
                  travelMode,
                  headcount,
                  tripCostConfig,
                )
              : null,
          };
        });
    });
    const detailRows = [hotelRow, ...activityRows];

    if (detailRows.length === 0) {
      await supabase
        .schema('travel')
        .from('itineraries')
        .delete()
        .eq('id', (itinerary as any).id);
      throw new BadRequestException(
        'AI planner did not return any valid places to persist',
      );
    }

    if (detailRows.length > 0) {
      const { error: detailsError } = await supabase
        .schema('travel')
        .from('itinerary_details')
        .insert(detailRows);

      if (detailsError) {
        // Rollback: xóa itinerary nếu insert detail thất bại
        await supabase
          .schema('travel')
          .from('itineraries')
          .delete()
          .eq('id', (itinerary as any).id);
        throw new InternalServerErrorException(
          'Lỗi khi lưu chi tiết lịch trình: ' + detailsError.message,
        );
      }
    }

    // Tính + lưu chi phí ước tính đóng băng lần đầu tiên. Không được phép
    // fail cả request tạo lịch trình nếu bước này lỗi.
    try {
      await this.recomputeCostEstimate((itinerary as any).id as string);
    } catch (err: any) {
      this.logger.warn(
        `Cannot compute initial itinerary_cost_estimates for ${(itinerary as any).id}: ${err?.message ?? err}`,
      );
    }

    // Đối chiếu lại DỮ LIỆU THẬT vừa lưu (không tin lunch_unavailable_reason
    // ai-service trả về — chỉ dùng nội bộ để tắt ràng buộc CP-SAT, có thể
    // không khớp 100% với những gì thực sự được persist, và chỉ áp dụng cho
    // scheduler_v2, không có ở ga_v1): đếm số nhà hàng thật theo từng ngày,
    // ngày nào 0 nhà hàng thì ghi chú thẳng vào notes của hoạt động đầu
    // ngày đó — không cần đổi schema, không phụ thuộc engine nào tạo ra plan.
    try {
      await this.annotateDaysMissingRestaurant((itinerary as any).id as string);
    } catch (err: any) {
      this.logger.warn(
        `Cannot annotate days missing restaurant for ${(itinerary as any).id}: ${err?.message ?? err}`,
      );
    }

    return {
      id: (itinerary as any).id as string,
      totalDetails: detailRows.length,
      status: 'pending',
    };
  }

  private static readonly NO_LUNCH_NOTE =
    'Khu vực này không có quán ăn phù hợp gần lịch trình vì thời gian và ' +
    'tuyến đường không đủ thuận tiện — bạn có thể ăn nhẹ trên xe.';

  /**
   * Đếm số nhà hàng THẬT đã lưu cho từng ngày (không tin dữ liệu ai-service
   * trả về lúc lập kế hoạch — đối chiếu lại đúng những gì vừa persist).
   * Ngày nào 0 nhà hàng thì gắn NO_LUNCH_NOTE vào cột `notes` sẵn có của
   * hoạt động đầu tiên trong ngày đó — không đè lên note đã có sẵn (VD user
   * tự thêm ghi chú riêng cho hoạt động đó).
   */
  private async annotateDaysMissingRestaurant(
    itineraryId: string,
  ): Promise<void> {
    const { data, error } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        'id, visit_date, sequence_order, notes, place_id, places(slot_type, types(name, categories(id,name)))',
      )
      .eq('itinerary_id', itineraryId)
      .eq('detail_type', 'ACTIVITY')
      .order('visit_date', { ascending: true })
      .order('sequence_order', { ascending: true });

    if (error) {
      this.logger.warn(`annotateDaysMissingRestaurant read error: ${error.message}`);
      return;
    }
    if (!data || data.length === 0) return;

    const rowsByDate = new Map<string, any[]>();
    for (const row of data) {
      const rows = rowsByDate.get(row.visit_date) ?? [];
      rows.push(row);
      rowsByDate.set(row.visit_date, rows);
    }

    const updates: Array<{ id: string; notes: string }> = [];
    for (const rows of rowsByDate.values()) {
      const hasRestaurant = rows.some((row: any) => {
        const place = row.places;
        const typeData = Array.isArray(place?.types) ? place.types[0] : place?.types;
        const categoryData = Array.isArray(typeData?.categories)
          ? typeData.categories[0]
          : typeData?.categories;
        const candidateCategory = normalizeCategory(
          place?.slot_type ?? '',
          typeData?.name ?? '',
        );
        return (
          resolvePlannerPlaceType(
            candidateCategory,
            categoryData?.id ?? null,
            categoryData?.name ?? null,
            typeData?.name ?? '',
          ) === 'restaurant'
        );
      });
      if (hasRestaurant) continue;

      const first = rows[0];
      if (!first || first.notes) continue;
      updates.push({ id: first.id, notes: ItineraryService.NO_LUNCH_NOTE });
    }

    if (updates.length === 0) return;
    await Promise.all(
      updates.map(({ id, notes }) =>
        supabase
          .schema('travel')
          .from('itinerary_details')
          .update({ notes })
          .eq('id', id)
          .then(({ error: updateError }) => {
            if (updateError) {
              this.logger.warn(
                `Cannot write no-lunch note for detail ${id}: ${updateError.message}`,
              );
            }
          }),
      ),
    );
  }

  /** Tạo lịch trình mới */
  async createItinerary(body: any) {
    const { data, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .insert([body])
      .select();

    if (error) throw error;
    return data;
  }

  /** Lấy lịch trình của user theo creator_id */
  async getMyItinerary(userId: string) {
    const { data, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('*')
      .eq('creator_id', userId);

    if (error) throw error;
    return data;
  }

  /** Bật/Tắt trạng thái công khai của lịch trình */
  async toggleVisibility(id: string, isPublic: boolean) {
    const { data, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .update({ is_public: isPublic })
      .eq('id', id)
      .select('id')
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(
        'Lỗi khi cập nhật trạng thái: ' + error.message,
      );
    }
    if (!data) {
      throw new NotFoundException(`Itinerary not found: ${id}`);
    }
    return true;
  }

  /**
   * Xóa lịch trình: 'pending' (chưa từng bắt đầu) → xóa cứng; các status còn lại
   * (đã từng bắt đầu: ongoing/completed/uncompleted) → chỉ ẩn (soft-delete) để giữ
   * lịch sử tracking/review. Logic hard/soft nằm trong RPC travel.delete_itinerary
   * để đọc status + ghi trong cùng 1 transaction (tránh race condition, 1 round-trip).
   */
  async deleteItinerary(id: string) {
    const { data, error } = await supabase
      .schema('travel')
      .rpc('delete_itinerary', { p_id: id });

    if (error) {
      throw new InternalServerErrorException(
        'Lỗi khi xóa lịch trình: ' + error.message,
      );
    }
    if (!(data as any)?.found) {
      throw new NotFoundException(`Itinerary not found: ${id}`);
    }
    return true;
  }

  async updateItinerary(id: string, dto: { description?: string }) {
    const updates: Record<string, any> = {};
    if (dto.description !== undefined) updates.description = dto.description;
    if (!Object.keys(updates).length) return { id };

    const { data, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .update(updates)
      .eq('id', id)
      .select('id, description')
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        'Lỗi khi cập nhật lịch trình: ' + error.message,
      );
    }
    if (!data) {
      throw new NotFoundException(`Itinerary not found: ${id}`);
    }
    return { success: true, ...data };
  }

  async shareItinerary(itineraryId: string, dto: ShareItineraryDto) {
    const recipientInput = dto.recipient.trim();
    if (!recipientInput) {
      throw new BadRequestException('Vui lòng nhập email hoặc số điện thoại');
    }

    const itinerary = await this.getShareableItineraryForOwner(
      itineraryId,
      dto.senderUserId,
    );
    await this.assertShareSlotAvailable(
      itineraryId,
      Number((itinerary as any).adult_count ?? 1),
    );

    const recipient = await this.findUserByEmailOrPhone(recipientInput);
    if (!recipient) {
      throw new NotFoundException(
        'Người dùng không tồn tại, vui lòng kiểm tra và nhập lại',
      );
    }
    if (recipient.id === dto.senderUserId) {
      throw new BadRequestException(
        'Bạn không thể chia sẻ lịch trình cho chính mình',
      );
    }

    const alreadyMember = await this.isItineraryMember(
      itineraryId,
      recipient.id,
    );
    if (alreadyMember) {
      throw new ConflictException('Người dùng này đã là thành viên lịch trình');
    }

    const notificationId = randomUUID();
    const nowIso = new Date().toISOString();
    const title = 'Lời mời chia sẻ lịch trình';
    const itineraryTitle =
      (itinerary as any).description ||
      (itinerary as any).destination ||
      'một lịch trình';
    const content = `Bạn được mời tham gia lịch trình "${itineraryTitle}". Vui lòng xác nhận hoặc từ chối lời mời.`;

    const { error: notificationError } = await supabase
      .schema('public')
      .from('notifications')
      .insert({
        id: notificationId,
        title,
        content,
        type: 'itinerary_share',
        is_global: false,
        action_type: 'respond_itinerary_share',
        target_type: 'itinerary_share_invitation',
        metadata: {
          action_label: 'Phản hồi lời mời',
          itinerary_id: itineraryId,
          sender_user_id: dto.senderUserId,
          recipient_user_id: recipient.id,
          share_status: 'pending',
        },
        created_at: nowIso,
      });

    if (notificationError) {
      throw new InternalServerErrorException(notificationError.message);
    }

    const { error: linkError } = await supabase
      .schema('public')
      .from('users_notifications')
      .insert({
        id: randomUUID(),
        user_id: recipient.id,
        notification_id: notificationId,
        is_read: false,
        sent_at: nowIso,
      });

    if (linkError) {
      throw new InternalServerErrorException(linkError.message);
    }

    return {
      success: true,
      notificationId,
      recipientUserId: recipient.id,
      message: 'Đã gửi lời mời chia sẻ lịch trình',
    };
  }

  async searchShareRecipients(q: string, senderUserId?: string) {
    const term = (q ?? '').trim();
    if (term.length < 2) {
      return { users: [] };
    }

    const sanitized = term.replace(/[%,]/g, '');
    if (sanitized.length < 2) {
      return { users: [] };
    }
    const normalizedPhone = sanitized.replace(/[\s.-]/g, '');
    const conditions = [
      `full_name.ilike.%${sanitized}%`,
      `email.ilike.%${sanitized}%`,
      `phone_number.ilike.%${sanitized}%`,
      normalizedPhone && normalizedPhone !== sanitized
        ? `phone_number.ilike.%${normalizedPhone}%`
        : null,
    ].filter(Boolean) as string[];

    let query = supabase
      .schema('public')
      .from('users')
      .select('id, full_name, email, phone_number, role')
      .eq('role', 'TOURIST')
      .or(conditions.join(','))
      .order('full_name', { ascending: true })
      .limit(8);

    if (senderUserId?.trim()) {
      query = query.neq('id', senderUserId.trim());
    }

    const { data, error } = await query;
    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return {
      users: (data ?? []).map((user: any) => ({
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        phoneNumber: user.phone_number,
      })),
    };
  }

  async createShareLink(itineraryId: string, dto: CreateItineraryShareLinkDto) {
    // Lời mời qua link không tính vào trần adult_count (chỉ lời mời trực
    // tiếp trong app mới bị giới hạn — xem assertShareSlotAvailable).
    const itinerary = await this.getShareableItineraryForOwner(
      itineraryId,
      dto.senderUserId,
    );
    const owner = await this.getUserDisplayInfo(dto.senderUserId);
    const token = randomUUID();
    const notificationId = randomUUID();
    const nowIso = new Date().toISOString();
    const itineraryTitle =
      (itinerary as any).description ||
      (itinerary as any).destination ||
      'lịch trình';

    const { error } = await supabase
      .schema('public')
      .from('notifications')
      .insert({
        id: notificationId,
        title: 'Link mời tham gia lịch trình',
        content: `${owner.displayName} đã tạo link mời tham gia lịch trình "${itineraryTitle}".`,
        type: 'itinerary_share',
        is_global: false,
        action_type: 'respond_itinerary_share_link',
        target_type: 'itinerary_share_link',
        metadata: {
          action_label: 'Phản hồi lời mời',
          share_token: token,
          share_status: 'active',
          itinerary_id: itineraryId,
          itinerary_title: itineraryTitle,
          sender_user_id: dto.senderUserId,
          sender_name: owner.displayName,
        },
        created_at: nowIso,
      });

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const deepLink = this.buildShareDeepLink(token);
    const shareUrl = this.buildPublicShareUrl(token) ?? deepLink;
    return {
      success: true,
      token,
      itineraryId,
      itineraryTitle,
      ownerName: owner.displayName,
      deepLink,
      shareUrl,
      playStoreUrl: APP_PLAY_STORE_URL,
      message:
        `${owner.displayName} mời bạn tham gia lịch trình "${itineraryTitle}". ` +
        `Mở link để xác nhận: ${shareUrl}`,
    };
  }

  async getShareLinkPreview(token: string, userId?: string) {
    const invitation = await this.findShareLinkInvitation(token);
    const metadata = invitation.metadata;
    const itineraryId = String(metadata.itinerary_id ?? '');
    const senderUserId = String(metadata.sender_user_id ?? '');

    // Cho mobile biết người bấm link là chủ lịch trình hay đã là thành viên
    // để hiển thị đúng trạng thái thay vì hiện lại dialog mời.
    const viewerId = userId?.trim() ?? '';
    const isOwner = Boolean(
      viewerId && senderUserId && viewerId === senderUserId,
    );
    let alreadyMember = false;
    if (viewerId && itineraryId && !isOwner) {
      try {
        alreadyMember = await this.isItineraryMember(itineraryId, viewerId);
      } catch (err) {
        this.logger.warn(
          `getShareLinkPreview member check failed itinerary=${itineraryId} user=${viewerId}: ${String(err)}`,
        );
      }
    }

    return {
      success: true,
      token,
      itineraryId: metadata.itinerary_id,
      itineraryTitle: metadata.itinerary_title ?? 'lịch trình',
      ownerName: metadata.sender_name ?? 'Chủ lịch trình',
      status: metadata.share_status ?? 'active',
      isOwner,
      alreadyMember,
    };
  }

  async respondToShareLink(dto: RespondItineraryShareLinkDto) {
    const invitation = await this.findShareLinkInvitation(dto.token);
    const metadata = invitation.metadata;
    const itineraryId = String(metadata.itinerary_id ?? '');
    const senderUserId = String(metadata.sender_user_id ?? '');

    if (!itineraryId || !senderUserId) {
      throw new BadRequestException('Link chia sẻ không hợp lệ');
    }
    if (dto.userId === senderUserId) {
      throw new BadRequestException(
        'Bạn là chủ lịch trình nên không cần tham gia bằng link mời',
      );
    }

    if (dto.action === 'accept') {
      const wasMember = await this.isItineraryMember(itineraryId, dto.userId);
      await this.addItineraryMember(itineraryId, dto.userId);
      // Đồng bộ trạng thái: nếu user cũng nhận lời mời trực tiếp đang chờ
      // cho lịch trình này thì đánh dấu đã chấp nhận để thông báo không
      // hiện lại nút xác nhận/từ chối.
      await this.markDirectShareInvitationsAccepted(itineraryId, dto.userId);

      return {
        success: true,
        status: 'accepted',
        itineraryId,
        alreadyMember: wasMember,
        message: wasMember
          ? 'Bạn đã tham gia lịch trình này trước đó'
          : 'Đã xác nhận tham gia lịch trình',
      };
    }

    return {
      success: true,
      status: 'rejected',
      itineraryId,
      alreadyMember: false,
      message: 'Đã từ chối lời mời tham gia lịch trình',
    };
  }

  /**
   * Khi user tham gia lịch trình qua link social, các notification mời
   * trực tiếp (action_type = respond_itinerary_share) đang chờ của chính
   * user đó cho lịch trình đó được chuyển sang accepted để màn thông báo
   * load đúng trạng thái. Lỗi ở đây không được làm hỏng flow tham gia.
   */
  private async markDirectShareInvitationsAccepted(
    itineraryId: string,
    userId: string,
  ) {
    try {
      const { data: invitations, error } = await supabase
        .schema('public')
        .from('notifications')
        .select('id, metadata')
        .eq('action_type', 'respond_itinerary_share')
        .filter('metadata->>itinerary_id', 'eq', itineraryId)
        .filter('metadata->>recipient_user_id', 'eq', userId);

      if (error) {
        this.logger.warn(
          `markDirectShareInvitationsAccepted query failed itinerary=${itineraryId} user=${userId}: ${error.message}`,
        );
        return;
      }
      if (!invitations || invitations.length === 0) {
        return;
      }

      const respondedAt = new Date().toISOString();
      for (const invitation of invitations) {
        const metadata = ((invitation as any).metadata ?? {}) as Record<
          string,
          unknown
        >;
        const [notificationUpdate, linkUpdate] = await Promise.all([
          supabase
            .schema('public')
            .from('notifications')
            .update({
              action_type: 'itinerary_share_accepted',
              metadata: {
                ...metadata,
                share_status: 'accepted',
                responded_at: respondedAt,
                responded_via: 'share_link',
              },
            })
            .eq('id', (invitation as any).id),
          supabase
            .schema('public')
            .from('users_notifications')
            .update({ is_read: true, read_at: respondedAt })
            .eq('user_id', userId)
            .eq('notification_id', (invitation as any).id),
        ]);

        if (notificationUpdate.error) {
          this.logger.warn(
            `markDirectShareInvitationsAccepted notification update failed id=${(invitation as any).id}: ${notificationUpdate.error.message}`,
          );
        }
        if (linkUpdate.error) {
          this.logger.warn(
            `markDirectShareInvitationsAccepted link update failed id=${(invitation as any).id}: ${linkUpdate.error.message}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `markDirectShareInvitationsAccepted failed itinerary=${itineraryId} user=${userId}: ${String(err)}`,
      );
    }
  }

  async respondToShareInvitation(
    itineraryId: string,
    dto: RespondItineraryShareDto,
  ) {
    const { data: link, error: linkError } = await supabase
      .schema('public')
      .from('users_notifications')
      .select('id, notification_id, user_id')
      .eq('user_id', dto.userId)
      .eq('notification_id', dto.notificationId)
      .maybeSingle();

    if (linkError) {
      throw new InternalServerErrorException(linkError.message);
    }
    if (!link) {
      throw new NotFoundException('Không tìm thấy lời mời chia sẻ');
    }

    const { data: notification, error: notificationError } = await supabase
      .schema('public')
      .from('notifications')
      .select('id, action_type, target_type, metadata')
      .eq('id', dto.notificationId)
      .maybeSingle();

    if (notificationError) {
      throw new InternalServerErrorException(notificationError.message);
    }
    if (!notification) {
      throw new NotFoundException('Không tìm thấy thông báo chia sẻ');
    }

    const metadata = ((notification as any).metadata ?? {}) as Record<
      string,
      unknown
    >;
    const currentActionType = (notification as any).action_type;
    const currentShareStatus =
      typeof metadata.share_status === 'string' ? metadata.share_status : null;
    if (
      (currentShareStatus === 'accepted' ||
        currentShareStatus === 'rejected' ||
        currentActionType === 'itinerary_share_accepted' ||
        currentActionType === 'itinerary_share_rejected') &&
      metadata.itinerary_id === itineraryId &&
      metadata.recipient_user_id === dto.userId
    ) {
      const finalStatus =
        currentShareStatus === 'accepted' ||
        currentActionType === 'itinerary_share_accepted'
          ? 'accepted'
          : 'rejected';
      return {
        success: true,
        status: finalStatus,
        message:
          finalStatus === 'accepted'
            ? 'Lời mời chia sẻ lịch trình đã được chấp nhận trước đó'
            : 'Lời mời chia sẻ lịch trình đã bị từ chối trước đó',
      };
    }
    if (
      currentActionType !== 'respond_itinerary_share' ||
      metadata.itinerary_id !== itineraryId ||
      metadata.recipient_user_id !== dto.userId
    ) {
      throw new BadRequestException('Lời mời chia sẻ không hợp lệ');
    }

    // User đã là thành viên (ví dụ đã tham gia qua link social trước đó):
    // đồng bộ notification sang accepted bất kể action để trạng thái luôn đúng.
    const alreadyMember = await this.isItineraryMember(itineraryId, dto.userId);
    if (alreadyMember) {
      await this.markDirectShareInvitationsAccepted(itineraryId, dto.userId);
      return {
        success: true,
        status: 'accepted',
        message: 'Bạn đã tham gia lịch trình này trước đó',
      };
    }

    if (dto.action === 'accept') {
      await this.addItineraryMember(itineraryId, dto.userId);
    }

    const shareStatus = dto.action === 'accept' ? 'accepted' : 'rejected';
    const readAt = new Date().toISOString();
    const [notificationUpdate, linkUpdate] = await Promise.all([
      supabase
        .schema('public')
        .from('notifications')
        .update({
          action_type:
            dto.action === 'accept'
              ? 'itinerary_share_accepted'
              : 'itinerary_share_rejected',
          metadata: {
            ...metadata,
            share_status: shareStatus,
            responded_at: readAt,
          },
        })
        .eq('id', dto.notificationId),
      supabase
        .schema('public')
        .from('users_notifications')
        .update({ is_read: true, read_at: readAt })
        .eq('user_id', dto.userId)
        .eq('notification_id', dto.notificationId),
    ]);

    if (notificationUpdate.error) {
      throw new InternalServerErrorException(notificationUpdate.error.message);
    }
    if (linkUpdate.error) {
      throw new InternalServerErrorException(linkUpdate.error.message);
    }

    return {
      success: true,
      status: shareStatus,
      message:
        dto.action === 'accept'
          ? 'Đã xác nhận lời mời chia sẻ lịch trình'
          : 'Đã từ chối lời mời chia sẻ lịch trình',
    };
  }

  private async findUserByEmailOrPhone(value: string) {
    const normalized = value.trim();
    const normalizedPhone = normalized.replace(/[\s.-]/g, '');
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
    const query = supabase
      .schema('public')
      .from('users')
      .select('id, full_name, email, phone_number, role')
      .eq('role', 'TOURIST')
      .limit(1);

    const phoneCandidates = Array.from(
      new Set([normalized, normalizedPhone].filter(Boolean)),
    );
    const { data, error } = isEmail
      ? await query.ilike('email', normalized).maybeSingle()
      : await query.in('phone_number', phoneCandidates).maybeSingle();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return data as { id: string; full_name?: string; email?: string } | null;
  }

  private async getShareableItineraryForOwner(
    itineraryId: string,
    senderUserId: string,
  ) {
    const { data, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .select(
        'id, creator_id, description, destination, start_date, end_date, adult_count',
      )
      .eq('id', itineraryId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    if (!data) {
      throw new NotFoundException(`Itinerary not found: ${itineraryId}`);
    }
    if ((data as any).creator_id !== senderUserId) {
      throw new BadRequestException(
        'Bạn không có quyền chia sẻ lịch trình này',
      );
    }
    return data;
  }

  /**
   * Trần chia sẻ = adult_count - 1 (chủ lịch trình đã tính là 1 người lớn
   * sẵn trong adult_count, không cần mời). Chỉ đếm lời mời trực tiếp trong
   * app (action_type respond_itinerary_share/itinerary_share_accepted) —
   * KHÔNG tính link mời (respond_itinerary_share_link và các biến thể của
   * nó có action_type khác nên tự động bị loại khỏi filter này).
   * `addItineraryMember` chỉ chạy khi user bấm accept (xem
   * respondToShareInvitation/respondToShareLink), nên lời mời bị từ chối
   * (itinerary_share_rejected) không tính vào đây — bị từ chối thì trả lại
   * slot cho chủ lịch trình mời người khác. Trẻ em không tính vào trần này.
   */
  private async assertShareSlotAvailable(
    itineraryId: string,
    adultCount: number,
  ) {
    const maxInvites = Math.max(0, Math.trunc(adultCount) - 1);
    const { count, error } = await supabase
      .schema('public')
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .in('action_type', ['respond_itinerary_share', 'itinerary_share_accepted'])
      .filter('metadata->>itinerary_id', 'eq', itineraryId);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    if ((count ?? 0) >= maxInvites) {
      throw new ConflictException(
        `Lịch trình này đã đủ số người lớn (${adultCount} người) đã đặt ` +
          'lúc tạo, không thể chia sẻ thêm. Vui lòng tăng số người lớn khi ' +
          'tạo/chỉnh sửa lịch trình nếu muốn mời thêm thành viên.',
      );
    }
  }

  private async getUserDisplayInfo(userId: string) {
    const { data, error } = await supabase
      .schema('public')
      .from('users')
      .select('id, full_name, email')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return {
      id: userId,
      displayName:
        ((data as any)?.full_name || (data as any)?.email || 'Chủ lịch trình')
          .toString()
          .trim() || 'Chủ lịch trình',
    };
  }

  buildShareDeepLink(token: string) {
    return `${APP_DEEP_LINK_SCHEME}://itinerary-share?token=${encodeURIComponent(
      token,
    )}`;
  }

  buildPublicShareUrl(token: string) {
    const baseUrl = APP_PUBLIC_SHARE_BASE_URL?.trim();
    if (!baseUrl) return null;
    return `${baseUrl.replace(/\/+$/, '')}/itinerary/share/${encodeURIComponent(
      token,
    )}`;
  }

  private async findShareLinkInvitation(token: string): Promise<{
    id: string;
    metadata: Record<string, any>;
  }> {
    if (!token?.trim()) {
      throw new BadRequestException('Token chia sẻ không hợp lệ');
    }

    const { data, error } = await supabase
      .schema('public')
      .from('notifications')
      .select('id, action_type, target_type, metadata')
      .eq('action_type', 'respond_itinerary_share_link')
      .eq('target_type', 'itinerary_share_link')
      .filter('metadata->>share_token', 'eq', token.trim())
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    if (!data) {
      throw new NotFoundException('Không tìm thấy link chia sẻ lịch trình');
    }

    return {
      id: (data as any).id,
      metadata: ((data as any).metadata ?? {}) as Record<string, any>,
    };
  }

  async isItineraryMember(itineraryId: string, userId: string) {
    const { data, error } = await supabase
      .schema('travel')
      .from('itinerary_members')
      .select('itinerary_id')
      .eq('itinerary_id', itineraryId)
      .eq('tourist_id', userId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return Boolean(data);
  }

  private async addItineraryMember(itineraryId: string, userId: string) {
    if (await this.isItineraryMember(itineraryId, userId)) {
      return;
    }

    const { error } = await supabase
      .schema('travel')
      .from('itinerary_members')
      .insert({
        itinerary_id: itineraryId,
        tourist_id: userId,
      });

    if (error && error.code !== '23505') {
      throw new InternalServerErrorException(error.message);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // TÍNH NĂNG TÙY CHỈNH LỊCH TRÌNH
  // ════════════════════════════════════════════════════════════════

  /**
   * CHỈNH SỬA một hoạt động: thay đổi giờ đến, thời gian tham quan, ghi chú.
   *
   * Logic ghim giờ:
   * - Nếu user truyền `arriveTime` → is_locked = true, locked_arrive_time = arriveTime
   * - Nếu user truyền `isLocked = false` → gỡ ghim
   * - Sau khi lưu, gọi FastAPI để tối ưu lại ngày đó
   *
   * @param itineraryId - ID của lịch trình cha
   * @param activityId  - ID bản ghi itinerary_details cần chỉnh sửa
   * @param dto         - Dữ liệu chỉnh sửa
   * @returns Danh sách hoạt động đã sắp xếp lại trong ngày bị ảnh hưởng
   */
  async editActivity(
    itineraryId: string,
    activityId: string,
    dto: EditActivityDto,
  ) {
    // ─── Bước 1: Kiểm tra bản ghi có tồn tại không ───────────────
    const { data: existing, error: fetchErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        'id, itinerary_id, visit_date, arrival_time, duration_minutes, is_locked, locked_arrive_time',
      )
      .eq('id', activityId)
      .eq('itinerary_id', itineraryId)
      .single();

    if (fetchErr || !existing) {
      throw new NotFoundException(
        `Không tìm thấy hoạt động với id: ${activityId}`,
      );
    }

    // ─── Bước 2: Xây dựng object cập nhật ────────────────────────
    const updates: Record<string, any> = {};

    if (dto.arriveTime !== undefined) {
      // User set giờ mới → tự động ghim
      updates.arrival_time = dto.arriveTime;
      updates.locked_arrive_time = dto.arriveTime;
      updates.is_locked = true;
    }

    if (dto.isLocked === false) {
      // User chủ động bỏ ghim
      updates.is_locked = false;
      updates.locked_arrive_time = null;
    }

    if (dto.durationMinutes !== undefined) {
      updates.duration_minutes = dto.durationMinutes;
    }

    if (dto.userNotes !== undefined) {
      updates.user_notes = dto.userNotes;
    }

    // Không có gì để cập nhật
    if (Object.keys(updates).length === 0) {
      throw new BadRequestException('Không có dữ liệu nào để cập nhật');
    }

    // ─── Bước 3: Lưu vào DB ──────────────────────────────────────
    const { error: updateErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .update(updates)
      .eq('id', activityId);

    if (updateErr) {
      console.error('[ItineraryService] editActivity update error:', updateErr);
      throw new InternalServerErrorException(
        'Lỗi khi cập nhật hoạt động: ' + updateErr.message,
      );
    }

    // ─── Bước 4: Quyết định có cần re-optimize không ─────────────
    // Chỉ gọi FastAPI khi thay đổi ảnh hưởng đến lịch thời gian.
    // Nếu chỉ sửa userNotes → lưu DB rồi trả về ngay, không gọi FastAPI.
    const needsReOptimize =
      dto.arriveTime !== undefined || // Đổi giờ đến → các điểm xung quanh phải dịch chuyển
      dto.durationMinutes !== undefined || // Đổi thời gian tham quan → giờ rời đi thay đổi
      dto.isLocked === false; // Bỏ ghim → optimizer có thể sắp xếp lại

    const visitDate: string = existing.visit_date;

    if (!needsReOptimize) {
      return this._buildDayResponse(itineraryId, visitDate, []);
    }
    try {
      return await this._reOptimizeDay(
        itineraryId,
        visitDate,
        undefined,
        dto.allowReduceTime || false,
        dto.extendTime || false,
      );
    } catch (e: any) {
      if (e instanceof ConflictException && e.message === 'SCHEDULE_FULL') {
        // Rollback
        await supabase
          .schema('travel')
          .from('itinerary_details')
          .update({
            arrival_time: existing.arrival_time,
            duration_minutes: existing.duration_minutes,
            is_locked: existing.is_locked,
            locked_arrive_time: existing.locked_arrive_time,
          })
          .eq('id', activityId);

        // Calculate canExtend
        const { data: itin } = await supabase
          .schema('travel')
          .from('itineraries')
          .select('daily_end_time')
          .eq('id', itineraryId)
          .single();
        const dailyEndTimeStr = itin?.daily_end_time || '22:00';
        const canExtend = dailyEndTimeStr < '23:50:00';

        // Calculate canReduce (dry-run)
        let canReduce = false;
        try {
          const { data: siblingActivities } = await supabase
            .schema('travel')
            .from('itinerary_details')
            .select('duration_minutes, is_locked')
            .eq('itinerary_id', itineraryId)
            .eq('visit_date', visitDate);
          canReduce =
            siblingActivities?.some(
              (a: any) => !a.is_locked && (a.duration_minutes || 60) > 30,
            ) ?? false;
        } catch (_) {}

        throw new ConflictException({
          message:
            'Thời gian tham quan đã bị quá tải hoặc vượt quá khung giờ hoạt động.',
          canExtend,
          canReduce,
          canAddDay: false,
        });
      }
      throw e;
    }
  }

  /**
   * XÓA một hoạt động khỏi lịch trình.
   * Sau khi xóa, gọi FastAPI tối ưu lại ngày để lấp khoảng trống thời gian.
   *
   * @param itineraryId - ID lịch trình cha
   * @param activityId  - ID bản ghi itinerary_details cần xóa
   */
  async deleteActivity(itineraryId: string, activityId: string) {
    // ─── Bước 1: Lấy thông tin trước khi xóa (cần visit_date để re-optimize) ─
    const { data: existing, error: fetchErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('id, visit_date')
      .eq('id', activityId)
      .eq('itinerary_id', itineraryId)
      .single();

    if (fetchErr || !existing) {
      throw new NotFoundException(
        `Không tìm thấy hoạt động với id: ${activityId}`,
      );
    }

    // ─── Bước 2: Xóa khỏi DB ─────────────────────────────────────
    const { error: deleteErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .delete()
      .eq('id', activityId);

    if (deleteErr) {
      console.error('[ItineraryService] deleteActivity error:', deleteErr);
      throw new InternalServerErrorException(
        'Lỗi khi xóa hoạt động: ' + deleteErr.message,
      );
    }

    // ─── Bước 3: Tối ưu lại ngày bị ảnh hưởng ───────────────────
    const visitDate: string = existing.visit_date;
    const result = await this._reOptimizeDay(itineraryId, visitDate);
    try {
      await this.recomputeCostEstimateAfterEdit(itineraryId);
    } catch (err: any) {
      this.logger.warn(
        `Cannot recompute itinerary_cost_estimates after deleteActivity for ${itineraryId}: ${err?.message ?? err}`,
      );
    }
    return result;
  }

  /**
   * THÊM một địa điểm mới vào lịch trình.
   * Hệ thống tự tìm khe thời gian trống phù hợp trong ngày.
   *
   * @param itineraryId - ID lịch trình cha
   * @param dto         - Thông tin địa điểm muốn thêm
   */
  async addActivity(itineraryId: string, dto: AddActivityDto) {
    // ─── Bước 1: Lấy thông tin lịch trình (cần start_date) ───────
    const { data: itinerary, error: itnErr } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('id, start_date, end_date')
      .eq('id', itineraryId)
      .single();

    if (itnErr || !itinerary) {
      throw new NotFoundException(
        `Không tìm thấy lịch trình với id: ${itineraryId}`,
      );
    }

    // ─── Bước 2: Tính toán visit_date từ dayNumber ────────────────
    const startDate = new Date(itinerary.start_date);
    let visitDate = '';

    if (dto.addExtraDay) {
      const endDate = new Date(itinerary.end_date);
      endDate.setDate(endDate.getDate() + 1);
      visitDate = endDate.toISOString().split('T')[0];

      const { data: itin2 } = await supabase
        .schema('travel')
        .from('itineraries')
        .select('duration_days')
        .eq('id', itineraryId)
        .single();
      const newDuration = (itin2?.duration_days || 1) + 1;

      await supabase
        .schema('travel')
        .from('itineraries')
        .update({
          end_date: visitDate,
          duration_days: newDuration,
        })
        .eq('id', itineraryId);
    } else {
      startDate.setDate(startDate.getDate() + (dto.dayNumber - 1));
      visitDate = startDate.toISOString().split('T')[0]; // 'YYYY-MM-DD'
    }

    // ─── Bước 3: Lấy thông tin địa điểm từ travel.places ─────────
    const { data: place, error: placeErr } = await supabase
      .schema('travel')
      .from('places')
      .select(
        'id, name, address, image_url, average_rating, estimated_cost, category_id, categories(name)',
      )
      .eq('id', dto.placeId)
      .single();

    if (placeErr || !place) {
      throw new NotFoundException(
        `Không tìm thấy địa điểm với id: ${dto.placeId}`,
      );
    }

    // ─── Bước 4: Lấy sequence_order lớn nhất trong ngày đó ───────
    const { data: maxSeqData } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('sequence_order')
      .eq('itinerary_id', itineraryId)
      .eq('visit_date', visitDate)
      .order('sequence_order', { ascending: false })
      .limit(1)
      .single();

    const nextSequence = maxSeqData ? (maxSeqData.sequence_order ?? 0) + 1 : 1;

    // ─── Bước 5: Xác định thời gian và ghim giờ (chỉ khi user tự chọn giờ) ─
    const durationMinutes = dto.durationMinutes ?? 60; // Mặc định 60 phút
    const preferredTime = dto.preferredTime;
    const isLocked = !!dto.preferredTime;
    // Không còn tự động ghim cứng giờ theo category (bãi biển/chợ đêm/chùa/
    // khu sinh thái...) — các category này giờ được ràng buộc bằng KHUNG
    // giờ (buổi sáng/trưa/chiều/tối) ngay trong CP-SAT optimizer
    // (ai-service/itinerary_optimizer.py), linh hoạt hơn thay vì khoá cứng
    // một phút cụ thể.

    // ─── Bước 6: Chèn bản ghi mới vào itinerary_details ─────────
    const { data: inserted, error: insertErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .insert({
        itinerary_id: itineraryId,
        place_id: dto.placeId,
        visit_date: visitDate,
        duration_minutes: durationMinutes,
        sequence_order: nextSequence,
        estimated_cost: place.estimated_cost ?? 0,
        is_locked: isLocked,
        locked_arrive_time: preferredTime ?? null,
        arrival_time: preferredTime ?? null, // Sẽ được optimizer ghi đè nếu không ghim
        added_by: 'user', // Đánh dấu user tự thêm (khác với 'ai' do hệ thống tạo)
      })
      .select()
      .single();

    if (insertErr) {
      console.error('[ItineraryService] addActivity insert error:', insertErr);
      throw new InternalServerErrorException(
        'Lỗi khi thêm hoạt động: ' + insertErr.message,
      );
    }

    // ─── Bước 7: Tối ưu lại ngày để sắp xếp địa điểm mới vào đúng chỗ ─
    try {
      const result = await this._reOptimizeDay(
        itineraryId,
        visitDate,
        inserted.id,
        dto.allowReduceTime || false,
        dto.extendTime || false,
      );
      try {
        await this.recomputeCostEstimateAfterEdit(itineraryId);
      } catch (err: any) {
        this.logger.warn(
          `Cannot recompute itinerary_cost_estimates after addActivity for ${itineraryId}: ${err?.message ?? err}`,
        );
      }
      return result;
    } catch (e: any) {
      if (e instanceof ConflictException && e.message === 'SCHEDULE_FULL') {
        // Rollback
        await supabase
          .schema('travel')
          .from('itinerary_details')
          .delete()
          .eq('id', inserted.id);

        if (dto.addExtraDay) {
          // If we added an extra day and it STILL failed, just rollback the itinerary too?
          // Too complex. Usually an empty day won't fail.
        }

        const { data: itin } = await supabase
          .schema('travel')
          .from('itineraries')
          .select('daily_end_time')
          .eq('id', itineraryId)
          .single();
        const dailyEndTimeStr = itin?.daily_end_time || '22:00';
        const canExtend = dailyEndTimeStr < '23:50:00';

        let canReduce = false;
        try {
          const { data: siblingActivities } = await supabase
            .schema('travel')
            .from('itinerary_details')
            .select('duration_minutes, is_locked')
            .eq('itinerary_id', itineraryId)
            .eq('visit_date', visitDate);
          canReduce =
            siblingActivities?.some(
              (a: any) => !a.is_locked && (a.duration_minutes || 60) > 30,
            ) ?? false;
        } catch (_) {}

        throw new ConflictException({
          message: 'Thời gian tham quan trong ngày đã kín.',
          canExtend,
          canReduce,
          canAddDay: true, // Always true for Add Activity
        });
      }
      throw e;
    }
  }

  /**
   * THAY THẾ một địa điểm bằng địa điểm khác.
   * Giữ nguyên thứ tự trong ngày và thời gian ghim (nếu có).
   *
   * @param itineraryId   - ID lịch trình cha
   * @param activityId    - ID bản ghi cần thay thế
   * @param newPlaceId    - ID địa điểm mới từ travel.places
   */
  async replaceActivity(
    itineraryId: string,
    activityId: string,
    dto: ReplaceActivityDto,
  ) {
    // ─── Bước 1: Lấy thông tin bản ghi cần thay thế ──────────────
    const { data: existing, error: fetchErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        'id, visit_date, sequence_order, is_locked, locked_arrive_time, duration_minutes, place_id, estimated_cost',
      )
      .eq('id', activityId)
      .eq('itinerary_id', itineraryId)
      .single();

    if (fetchErr || !existing) {
      throw new NotFoundException(
        `Không tìm thấy hoạt động với id: ${activityId}`,
      );
    }

    // ─── Bước 2: Kiểm tra địa điểm mới có tồn tại không ─────────
    const { data: newPlace, error: placeErr } = await supabase
      .schema('travel')
      .from('places')
      .select('id, estimated_cost')
      .eq('id', dto.newPlaceId)
      .single();

    if (placeErr || !newPlace) {
      throw new NotFoundException(
        `Không tìm thấy địa điểm với id: ${dto.newPlaceId}`,
      );
    }

    // ─── Bước 3: Cập nhật place_id và chi phí mới, giữ nguyên thứ tự & ghim giờ ─
    const { error: updateErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .update({
        place_id: dto.newPlaceId,
        estimated_cost: newPlace.estimated_cost ?? 0,
        // Giữ nguyên: sequence_order, is_locked, locked_arrive_time, duration_minutes
      })
      .eq('id', activityId);

    if (updateErr) {
      console.error(
        '[ItineraryService] replaceActivity update error:',
        updateErr,
      );
      throw new InternalServerErrorException(
        'Lỗi khi thay thế địa điểm: ' + updateErr.message,
      );
    }

    // ─── Bước 4: Tối ưu lại ngày ─────────────────────────────────
    try {
      const result = await this._reOptimizeDay(
        itineraryId,
        existing.visit_date,
        undefined,
        dto.allowReduceTime || false,
        dto.extendTime || false,
      );
      try {
        await this.recomputeCostEstimateAfterEdit(itineraryId);
      } catch (err: any) {
        this.logger.warn(
          `Cannot recompute itinerary_cost_estimates after replaceActivity for ${itineraryId}: ${err?.message ?? err}`,
        );
      }
      return result;
    } catch (e: any) {
      if (e instanceof ConflictException && e.message === 'SCHEDULE_FULL') {
        // Rollback
        await supabase
          .schema('travel')
          .from('itinerary_details')
          .update({
            place_id: existing.place_id,
            estimated_cost: existing.estimated_cost,
          })
          .eq('id', activityId);

        const { data: itin } = await supabase
          .schema('travel')
          .from('itineraries')
          .select('daily_end_time')
          .eq('id', itineraryId)
          .single();
        const dailyEndTimeStr = itin?.daily_end_time || '22:00';
        const canExtend = dailyEndTimeStr < '23:50:00';

        let canReduce = false;
        try {
          const { data: siblingActivities } = await supabase
            .schema('travel')
            .from('itinerary_details')
            .select('duration_minutes, is_locked')
            .eq('itinerary_id', itineraryId)
            .eq('visit_date', existing.visit_date);
          canReduce =
            siblingActivities?.some(
              (a: any) => !a.is_locked && (a.duration_minutes || 60) > 30,
            ) ?? false;
        } catch (_) {}

        throw new ConflictException({
          message: 'Thời gian tham quan trong ngày đã kín.',
          canExtend,
          canReduce,
          canAddDay: false,
        });
      }
      throw e;
    }
  }

  /**
   * LẤY GỢI Ý địa điểm thay thế cho một hoạt động.
   * Tìm các địa điểm cùng danh mục, cùng thành phố, chưa có trong lịch trình.
   *
   * @param itineraryId - ID lịch trình
   * @param activityId  - ID hoạt động cần tìm gợi ý thay thế
   */
  /**
   * Same ranking source as the "you might like" section on the place detail
   * page (RecommendationsService.getRecommendedPlaceIds — no category filter,
   * preserves the AI model's order), minus hotels and places already in this
   * itinerary. Falls back to same-city places sorted by rating.
   */
  async getSuggestions(itineraryId: string, activityId: string) {
    const { data: current, error: fetchErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        `
        id,
        place_id,
        places:place_id (
          id,
          city_id,
          latitude,
          longitude,
          types (category_id)
        )
      `,
      )
      .eq('id', activityId)
      .eq('itinerary_id', itineraryId)
      .single();

    if (fetchErr || !current) {
      throw new NotFoundException(
        `Không tìm thấy hoạt động với id: ${activityId}`,
      );
    }

    const currentPlace = (current as any).places;
    const currentTypeData = Array.isArray(currentPlace?.types)
      ? currentPlace.types[0]
      : currentPlace?.types;
    const currentCategoryId: string | null =
      currentTypeData?.category_id ?? null;

    const { data: itineraryInfo } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('creator_id')
      .eq('id', itineraryId)
      .single();

    const userId = itineraryInfo?.creator_id;

    const { data: existingDetails } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('place_id')
      .eq('itinerary_id', itineraryId);

    const excludedPlaceIds = (existingDetails ?? [])
      .map((d: any) => d.place_id)
      .filter(Boolean);

    const selectQuery = `
      id,
      name,
      address,
      image_url,
      average_rating,
      review_count,
      latitude,
      longitude,
      open_hour_compressed,
      types (id, name, category_id, categories (id, name))
    `;
    // Fallback query cần inner-join để `.eq('types.category_id', ...)` lọc
    // được ở top-level row (PostgREST bỏ qua filter embed nếu không !inner).
    const selectQueryInnerType = selectQuery.replace(
      'types (',
      'types!inner(',
    );

    const format = (rows: any[]) =>
      rows.map((p: any) => {
        const typeData = Array.isArray(p.types) ? p.types[0] : p.types;
        const dist =
          currentPlace.latitude &&
          currentPlace.longitude &&
          p.latitude &&
          p.longitude
            ? this._haversineKm(
                currentPlace.latitude,
                currentPlace.longitude,
                p.latitude,
                p.longitude,
              )
            : null;
        let imageUrl =
          'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=600&q=80';
        if (Array.isArray(p.image_url) && p.image_url.length > 0) {
          imageUrl = p.image_url[0];
        } else if (
          typeof p.image_url === 'string' &&
          p.image_url.trim().length > 0
        ) {
          imageUrl = p.image_url;
        }
        return {
          id: p.id,
          name: p.name,
          address: p.address || '',
          category: this.extractCategoryName(p) ?? 'Khác',
          rating: p.average_rating ?? 0,
          reviewCount: p.review_count ?? 0,
          imageUrl,
          distanceKm: dist != null ? Number(dist.toFixed(1)) : null,
          latitude: p.latitude,
          longitude: p.longitude,
          isSameCategory:
            currentCategoryId != null &&
            typeData?.category_id === currentCategoryId,
          openHourCompressed: p.open_hour_compressed || null,
        };
      });

    const recommended = await this.recommendationsService.getRecommendedPlaceIds(
      currentPlace.id,
      { userId },
    );
    const recommendedIds = recommended
      .map((item) => item.id)
      .filter((id) => !excludedPlaceIds.includes(id));

    let suggestions: any[] = [];
    if (recommendedIds.length > 0) {
      const { data: aiPlaces, error: aiErr } = await supabase
        .schema('travel')
        .from('places')
        .select(selectQuery)
        .in('id', recommendedIds)
        .neq('slot_type', 'accommodation');

      if (!aiErr && aiPlaces) {
        const byId = new Map(aiPlaces.map((p: any) => [p.id, p]));
        suggestions = recommendedIds
          .map((id) => byId.get(id))
          .filter(Boolean)
          .slice(0, 10);
      }
    }

    if (suggestions.length === 0) {
      const buildFallbackQuery = (withCategoryFilter: boolean) => {
        let query = supabase
          .schema('travel')
          .from('places')
          .select(withCategoryFilter ? selectQueryInnerType : selectQuery)
          .eq('city_id', currentPlace.city_id)
          .neq('slot_type', 'accommodation');

        if (excludedPlaceIds.length > 0) {
          query = query.not('id', 'in', `(${excludedPlaceIds.join(',')})`);
        }
        if (withCategoryFilter && currentCategoryId) {
          query = query.eq('types.category_id', currentCategoryId);
        }
        return query.order('average_rating', { ascending: false }).limit(10);
      };

      const { data: sameCategoryData, error: suggestErr } =
        await buildFallbackQuery(currentCategoryId != null);

      if (suggestErr) {
        console.error(
          '[ItineraryService] getSuggestions fallback error:',
          suggestErr,
        );
        return { suggestions: [] };
      }

      if (sameCategoryData && sameCategoryData.length > 0) {
        suggestions = sameCategoryData;
      } else if (currentCategoryId != null) {
        // Không còn địa điểm nào cùng danh mục trong thành phố — nới lỏng
        // để vẫn có gợi ý thay vì trả rỗng.
        const { data: anyCategoryData, error: anyErr } =
          await buildFallbackQuery(false);
        if (anyErr) {
          console.error(
            '[ItineraryService] getSuggestions fallback (any category) error:',
            anyErr,
          );
          return { suggestions: [] };
        }
        suggestions = anyCategoryData ?? [];
      } else {
        suggestions = [];
      }
    }

    return { suggestions: format(suggestions) };
  }

  /**
   * "Add place" suggestions: Two-Tower candidates fetched at itinerary
   * creation but not chosen by the planner, ranked by rating/review_count.
   * Returns fewer than `limit` (or empty) for itineraries created before this
   * table existed, or once candidates run out — mobile falls back to
   * /search/nearby in that case.
   */
  async getAddPlaceSuggestions(itineraryId: string, limit = 10) {
    const { data: usedRows } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('place_id')
      .eq('itinerary_id', itineraryId);
    const usedIds = new Set(
      (usedRows || []).map((r: any) => r.place_id).filter(Boolean),
    );

    const { data: candidateRows, error } = await supabase
      .schema('travel')
      .from('itinerary_candidate_places')
      .select(
        `
        place_id,
        places:place_id (
          id, name, address, average_rating, review_count, image_url,
          latitude, longitude, open_hour_compressed, slot_type,
          types (id, category_id, categories (id, name))
        )
      `,
      )
      .eq('itinerary_id', itineraryId);

    if (error || !candidateRows) return [];

    // Filter by slot_type here regardless of what was persisted, to stay
    // correct even for rows saved before restaurant/cafe were excluded.
    const allowedSlotTypes = new Set(['attraction', 'entertainment']);
    return candidateRows
      .map((row: any) => row.places)
      .filter(
        (p: any) =>
          p && allowedSlotTypes.has(p.slot_type) && !usedIds.has(p.id),
      )
      .sort((a: any, b: any) => {
        const ratingDiff = (b.average_rating ?? 0) - (a.average_rating ?? 0);
        if (ratingDiff !== 0) return ratingDiff;
        return (b.review_count ?? 0) - (a.review_count ?? 0);
      })
      .slice(0, limit)
      .map((p: any) => {
        let category = 'Tham quan';
        const typeData = Array.isArray(p.types) ? p.types[0] : p.types;
        if (typeData?.categories) {
          const catData = Array.isArray(typeData.categories)
            ? typeData.categories[0]
            : typeData.categories;
          if (catData?.name) category = catData.name;
        }
        let imageUrl =
          'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=600&q=80';
        if (Array.isArray(p.image_url) && p.image_url.length > 0) {
          imageUrl = p.image_url[0];
        } else if (
          typeof p.image_url === 'string' &&
          p.image_url.trim().length > 0
        ) {
          imageUrl = p.image_url;
        }
        return {
          id: p.id,
          name: p.name,
          address: p.address || '',
          category,
          rating: p.average_rating || 0,
          reviewCount: p.review_count || 0,
          imageUrl,
          distanceKm: null,
          latitude: p.latitude,
          longitude: p.longitude,
          isSameCategory: false,
          openHourCompressed: p.open_hour_compressed || null,
        };
      });
  }

  // ════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ════════════════════════════════════════════════════════════════

  /**
   * Gọi FastAPI optimizer để sắp xếp lại thứ tự và thời gian các hoạt động trong một ngày.
   *
   * Flow:
   * 1. Lấy toàn bộ hoạt động của ngày đó từ DB (JOIN với places để có tọa độ, giờ mở cửa)
   * 2. Gửi sang FastAPI /api/v1/itinerary/optimize
   * 3. FastAPI trả về schedule đã tối ưu (có thứ tự mới, arrival_time mới)
   * 4. Cập nhật lại vào DB theo kết quả
   * 5. Trả về danh sách hoạt động đã cập nhật cho controller
   *
   * @param itineraryId - ID lịch trình
   * @param visitDate   - Ngày cần tối ưu ('YYYY-MM-DD')
   */
  private async _reOptimizeDay(
    itineraryId: string,
    visitDate: string,
    newActivityId?: string,
    allowReduceTime: boolean = false,
    extendTime: boolean = false,
  ) {
    // ─── Lấy thời gian hoạt động của lịch trình ───────────────────
    const { data: itinerary } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('daily_start_time, daily_end_time')
      .eq('id', itineraryId)
      .single();

    const dailyStartTime = itinerary?.daily_start_time || '07:00';
    let dailyEndTime = itinerary?.daily_end_time || '22:00';

    if (extendTime) {
      dailyEndTime = '23:59:00';
    }

    // ─── Lấy toàn bộ hoạt động trong ngày (JOIN với places) ──────
    const { data: activities, error: fetchErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        `
        id,
        place_id,
        arrival_time,
        duration_minutes,
        is_locked,
        locked_arrive_time,
        sequence_order,
        estimated_cost,
        user_notes,
        added_by,
        places:place_id (
          id,
          name,
          address,
          image_url,
          average_rating,
          review_count,
          estimated_cost,
          latitude,
          longitude,
          open_time,
          close_time,
          slot_type,
          types (name, categories (id, name))
        )
      `,
      )
      .eq('itinerary_id', itineraryId)
      .eq('visit_date', visitDate)
      .order('sequence_order', { ascending: true });

    if (fetchErr || !activities || activities.length === 0) {
      // Không còn hoạt động nào → trả về mảng rỗng
      return this._buildDayResponse(itineraryId, visitDate, []);
    }

    // ─── Gọi FastAPI optimizer ────────────────────────────────────
    let optimizedSchedule: any[] | null = null;
    try {
      const optimizePayload = {
        itinerary_id: itineraryId,
        visit_date: visitDate,
        activities: activities
          .filter((a: any) => !this.isStartPointDetail(a))
          .map((a: any) => ({
            id: a.id,
            place_id: a.place_id,
            duration_minutes: a.duration_minutes ?? 60,
            is_locked: a.is_locked ?? false,
            locked_arrive_time: a.locked_arrive_time ?? null,
            lat: a.places?.latitude ?? null,
            lng: a.places?.longitude ?? null,
            open_time: a.places?.open_time ?? '07:00',
            close_time: a.places?.close_time ?? '22:00',
            estimated_cost: a.estimated_cost ?? 0,
            category: this.extractCategoryName(a.places) ?? null,
            is_restaurant: this.isRestaurant(
              a.places?.slot_type,
              a.locked_arrive_time || a.arrival_time,
              this.addMinutesToTime(
                a.locked_arrive_time || a.arrival_time,
                Number(a.duration_minutes ?? 60),
              ),
            ),
            original_arrival_time: a.arrival_time,
            is_new: newActivityId ? a.id === newActivityId : false,
          })),
        day_start_time: dailyStartTime,
        day_end_time: dailyEndTime,
        allow_reduce_time: allowReduceTime,
      };

      const response = await axios.post(
        `${AI_SERVICE_URL}/api/v1/itinerary/optimize`,
        optimizePayload,
        { timeout: 10000 }, // 10 giây timeout
      );
      optimizedSchedule = response.data.optimized_activities;
    } catch (aiErr: any) {
      if (aiErr.response?.status === 422) {
        throw new ConflictException('SCHEDULE_FULL');
      }
      // AI Service không khả dụng → giữ nguyên thứ tự cũ, không throw lỗi
      console.warn(
        '[ItineraryService] AI optimizer không khả dụng, giữ nguyên thứ tự:',
        aiErr instanceof Error ? aiErr.message : String(aiErr),
      );
    }

    // ─── Cập nhật DB theo kết quả tối ưu (nếu có) ────────────────
    if (optimizedSchedule && optimizedSchedule.length > 0) {
      // Cập nhật từng hoạt động theo batch (song song)
      await Promise.all(
        optimizedSchedule.map((opt: any) =>
          supabase
            .schema('travel')
            .from('itinerary_details')
            .update({
              arrival_time: opt.arrival_time,
              sequence_order: opt.sequence_order,
              duration_minutes: opt.duration_minutes,
            })
            .eq('id', opt.id),
        ),
      );
    }

    // ─── Đọc lại dữ liệu mới nhất từ DB để trả về client ────────
    return this._buildDayResponse(itineraryId, visitDate, activities);
  }

  /**
   * Đọc lại dữ liệu ngày từ DB và format về cấu trúc response cho client.
   */
  private async _buildDayResponse(
    itineraryId: string,
    visitDate: string,
    fallbackActivities: any[],
  ) {
    const { data: updatedActivities } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        `
        id,
        place_id,
        visit_date,
        detail_type,
        arrival_time,
        duration_minutes,
        is_locked,
        locked_arrive_time,
        sequence_order,
        estimated_cost,
        travel_distance_km,
        travel_minutes,
        transport_cost,
        user_notes,
        added_by,
        places:place_id (
          id,
          name,
          address,
          image_url,
          average_rating,
          review_count,
          latitude,
          longitude,
          slot_type,
          types (name, categories (id, name))
        )
      `,
      )
      .eq('itinerary_id', itineraryId)
      .eq('visit_date', visitDate)
      .order('sequence_order', { ascending: true });

    const list = updatedActivities ?? fallbackActivities;

    // ─── Tính số ngày trong lịch trình (để lấy dayNumber) ────────
    const { data: itn } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('start_date, travel_mode, adult_count, children_count')
      .eq('id', itineraryId)
      .single();

    let affectedDay = 1;
    if (itn?.start_date) {
      const start = new Date(itn.start_date);
      const visit = new Date(visitDate);
      affectedDay =
        Math.round(
          (visit.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
        ) + 1;
    }

    // Dùng đúng nguồn distance_matrix như getItineraryDetail() /
    // calculateTripCostBreakdown(), thay vì Haversine cục bộ — tránh 3 nơi
    // hiển thị 3 con số phút di chuyển khác nhau cho cùng 1 chặng.
    await this.hydrateMissingTravelSnapshots(
      list,
      itn?.travel_mode,
      Math.max(
        1,
        Number(itn?.adult_count ?? 0) + Number(itn?.children_count ?? 0),
      ),
    );

    return {
      success: true,
      message: 'Lịch trình đã được cập nhật và sắp xếp lại',
      affectedDay,
      updatedActivities: list.map((a: any, idx: number) => {
        const nextA: any = list[idx + 1];
        const transportInfo: string | null =
          nextA && Number(nextA.travel_minutes ?? 0) > 0
            ? `${nextA.travel_minutes} phút di chuyển (~${Number(nextA.travel_distance_km ?? 0).toFixed(1)} km)`
            : null;
        return {
          id: a.id,
          placeId: a.place_id,
          title: a.places?.name ?? '',
          startTime: a.arrival_time ?? '',
          endTime:
            this.addMinutesToTime(
              a.arrival_time,
              Number(a.duration_minutes ?? 0),
            ) ?? '',
          address: a.places?.address ?? '',
          imageUrl: a.places?.image_url ?? '',
          estimatedCost: a.estimated_cost ?? 0,
          isFree: (a.estimated_cost ?? 0) === 0,
          durationMinutes: a.duration_minutes ?? 60,
          isLocked: a.is_locked ?? false,
          lockedArriveTime: a.locked_arrive_time ?? null,
          userNotes: a.user_notes ?? null,
          sequenceOrder: a.sequence_order ?? 0,
          rating: a.places?.average_rating ?? 0,
          reviewCount: a.places?.review_count ?? 0,
          category: this.extractCategoryName(a.places) ?? null,
          placeType: a.places?.slot_type ?? null,
          transportInfo,
        };
      }),
    };
  }

  /**
   * Ước tính thời gian di chuyển thêm giữa 2 điểm (dùng công thức Haversine đơn giản).
   * Trả về chuỗi mô tả VD: "+5 phút" hoặc "~Gần đây"
   *
   * @param lat1, lng1 - Tọa độ điểm hiện tại
   * @param lat2, lng2 - Tọa độ điểm gợi ý
   */
  private _estimateTimeDiff(
    lat1: number | null,
    lng1: number | null,
    lat2: number | null,
    lng2: number | null,
  ): string {
    // Nếu thiếu tọa độ → không ước tính được
    if (!lat1 || !lng1 || !lat2 || !lng2) return 'Gần khu vực';

    // Công thức Haversine tính khoảng cách km
    const R = 6371; // Bán kính Trái Đất (km)
    const dLat = this._toRad(lat2 - lat1);
    const dLng = this._toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this._toRad(lat1)) *
        Math.cos(this._toRad(lat2)) *
        Math.sin(dLng / 2) ** 2;
    const distanceKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    // Ước tính thời gian với vận tốc xe máy ~25km/h trong thành phố
    const minutes = Math.round((distanceKm / 25) * 60);

    if (minutes <= 2) return '~Gần đây';
    if (minutes <= 10) return `+${minutes} phút di chuyển`;
    return `+${minutes} phút (~${distanceKm.toFixed(1)}km)`;
  }

  private _toRad(deg: number): number {
    return deg * (Math.PI / 180);
  }

  /** Khoảng cách thẳng Haversine (km) giữa 2 toạ độ. */
  private _haversineKm(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const R = 6371;
    const dLat = this._toRad(lat2 - lat1);
    const dLng = this._toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this._toRad(lat1)) *
        Math.cos(this._toRad(lat2)) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Ước tính thời gian di chuyển (phút) từ khoảng cách Haversine.
   * Đồng bộ với công thức Haversine fallback dùng lúc TẠO lịch trình
   * (ai-service/planner.py: build_travel_times_haversine, speed_kmh=30).
   * phút = km / 30 × 60 = km × 2.0
   */
  private _transitMinutes(distKm: number): number {
    return Math.max(1, Math.round(distKm * 2.0));
  }

  async updateActivities(id: string, days: any[]) {
    const { data: itinerary } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('start_date')
      .eq('id', id)
      .single();

    if (!itinerary) throw new Error('Itinerary not found');

    const allActivities: Array<{
      id: string;
      placeId?: string;
      dayNumber: number;
      startTime: string;
      endTime: string;
      sequenceOrder: number;
    }> = [];

    for (const day of days) {
      if (day.activities && Array.isArray(day.activities)) {
        day.activities.forEach((act, index) => {
          allActivities.push({
            id: act.id,
            placeId: act.placeId,
            dayNumber: day.dayNumber,
            startTime: act.startTime,
            endTime: act.endTime,
            sequenceOrder: index + 1,
          });
        });
      }
    }

    const { data: currentActs } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        'id, place_id, visit_date, arrival_time, duration_minutes, sequence_order, detail_type',
      )
      .eq('itinerary_id', id);

    // Khách sạn được chèn vào days.activities từ ngày 2 để hiển thị như điểm
    // xuất phát, nhưng không phải activity có thời lượng. Không validate hoặc
    // ghi ngược các bản sao hiển thị này vào itinerary_details.
    const hotelDetailIds = new Set(
      (currentActs ?? [])
        .filter((act: any) => this.isStartPointDetail(act))
        .map((act: any) => act.id),
    );
    const editableActivities = allActivities.filter(
      (act) => !hotelDetailIds.has(act.id),
    );
    const currentEditableActs = (currentActs ?? []).filter(
      (act: any) => !this.isStartPointDetail(act),
    );

    const currentActMap = new Map<
      string,
      {
        placeId: string | null;
        visitDate: string | null;
        arrivalTime: string;
        durationMinutes: number;
      }
    >();
    if (currentEditableActs.length > 0) {
      currentEditableActs.forEach((a) => {
        if (a.arrival_time) {
          currentActMap.set(a.id, {
            placeId: a.place_id ?? null,
            visitDate: a.visit_date ?? null,
            arrivalTime: a.arrival_time,
            durationMinutes: a.duration_minutes ?? 60,
          });
        }
      });
    }

    const incomingPlaceIds = [
      ...editableActivities.map((a) => a.placeId),
      ...currentEditableActs.map((a) => a.place_id),
    ].filter(Boolean);
    const { data: placesData } = await supabase
      .schema('travel')
      .from('places')
      .select('id, slot_type')
      .in('id', incomingPlaceIds);

    const placeTypeMap = new Map<string, string | null>();
    if (placesData) {
      placesData.forEach((p: any) => {
        placeTypeMap.set(p.id, p.slot_type ?? null);
      });
    }

    // Chặn toàn bộ payload trước khi ghi để không tạo lịch trình dở dang:
    // địa điểm đang đóng vai trò ăn trưa phải luôn nằm trọn trong 10:30-14:00.
    for (const act of editableActivities) {
      const oldState = currentActMap.get(act.id);
      if (!oldState) continue;

      const oldPlaceType = oldState.placeId
        ? placeTypeMap.get(oldState.placeId)
        : null;
      const currentPlaceType = act.placeId
        ? placeTypeMap.get(act.placeId)
        : oldPlaceType;
      const oldDepartureTime = this.addMinutesToTime(
        oldState.arrivalTime,
        oldState.durationMinutes,
      );
      const wasLunch = this.isRestaurant(
        oldPlaceType,
        oldState.arrivalTime,
        oldDepartureTime,
      );
      if (
        wasLunch &&
        !this.isRestaurant(currentPlaceType, act.startTime, act.endTime)
      ) {
        throw new BadRequestException({
          code: 'LUNCH_CONFLICT',
          message:
            'Địa điểm ăn trưa phải nằm trọn trong khung 10:30 - 14:00',
        });
      }
    }

    const activitiesByDay = new Map<number, typeof editableActivities>();
    for (const act of editableActivities) {
      const start = this.toMinutes(act.startTime);
      const end = this.toMinutes(act.endTime);
      if (end <= start) {
        throw new BadRequestException({
          code: 'INVALID_ACTIVITY_TIME',
          message: 'Giờ kết thúc phải sau giờ bắt đầu',
        });
      }
      const dayActivities = activitiesByDay.get(act.dayNumber) ?? [];
      dayActivities.push(act);
      activitiesByDay.set(act.dayNumber, dayActivities);
    }

    for (const dayActivities of activitiesByDay.values()) {
      dayActivities.sort(
        (a, b) => this.toMinutes(a.startTime) - this.toMinutes(b.startTime),
      );
      for (let i = 0; i < dayActivities.length; i++) {
        const left = dayActivities[i];
        for (let j = i + 1; j < dayActivities.length; j++) {
          const right = dayActivities[j];
          if (this.toMinutes(right.startTime) >= this.toMinutes(left.endTime)) {
            break;
          }

          const oldLeft = currentActMap.get(left.id);
          const oldRight = currentActMap.get(right.id);
          const oldLeftEnd = oldLeft
            ? this.toMinutes(oldLeft.arrivalTime) + oldLeft.durationMinutes
            : null;
          const oldRightEnd = oldRight
            ? this.toMinutes(oldRight.arrivalTime) + oldRight.durationMinutes
            : null;
          const overlapAlreadyExisted = Boolean(
            oldLeft &&
              oldRight &&
              oldLeft.visitDate === oldRight.visitDate &&
              oldLeftEnd != null &&
              oldRightEnd != null &&
              this.toMinutes(oldLeft.arrivalTime) < oldRightEnd &&
              this.toMinutes(oldRight.arrivalTime) < oldLeftEnd,
          );
          if (overlapAlreadyExisted) continue;

          throw new ConflictException({
            code: 'ACTIVITY_OVERLAP',
            message: 'Các địa điểm trong cùng ngày không được chồng giờ',
          });
        }
      }
    }

    const incomingIds = editableActivities.map((a) => a.id);
    const toDelete = currentEditableActs.filter(
      (a) => !incomingIds.includes(a.id),
    );

    if (toDelete.length > 0) {
      await supabase
        .schema('travel')
        .from('itinerary_details')
        .delete()
        .in(
          'id',
          toDelete.map((a) => a.id),
        );
    }

    await Promise.all(
      editableActivities.map(async (act) => {
        const isUUID =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            act.id,
          );

        if (isUUID) {
          const startDate = new Date(itinerary.start_date);
          startDate.setDate(startDate.getDate() + (act.dayNumber - 1));
          const visitDate = startDate.toISOString().split('T')[0];

          const startMin = this.toMinutes(act.startTime);
          const endMin = this.toMinutes(act.endTime);
          const duration = endMin - startMin > 0 ? endMin - startMin : 60;

          const updatePayload: any = {
            arrival_time: act.startTime,
            visit_date: visitDate,
            sequence_order: act.sequenceOrder,
            duration_minutes: duration,
          };
          if (act.placeId) {
            updatePayload.place_id = act.placeId;
          }

          const { error } = await supabase
            .schema('travel')
            .from('itinerary_details')
            .update(updatePayload)
            .eq('id', act.id);

          if (error) {
            console.warn(
              `[Supabase] Không thể cập nhật activity ${act.id}: ${error.message}`,
            );
          }
        } else {
          if (!act.placeId) return;

          const startDate = new Date(itinerary.start_date);
          startDate.setDate(startDate.getDate() + (act.dayNumber - 1));
          const visitDate = startDate.toISOString().split('T')[0];

          const startMin = this.toMinutes(act.startTime);
          const endMin = this.toMinutes(act.endTime);
          const duration = endMin - startMin > 0 ? endMin - startMin : 60;

          // ─── Validate place_id tồn tại trong bảng places trước khi INSERT ───
          // Tránh lỗi FK constraint "itinerary_details_place_id_fkey"
          // khi placeId là ID tạm thời hoặc không tồn tại trong travel.places
          const { data: placeExists } = await supabase
            .schema('travel')
            .from('places')
            .select('id')
            .eq('id', act.placeId)
            .single();

          if (!placeExists) {
            console.warn(
              `[Supabase] Bỏ qua activity ${act.id}: place_id "${act.placeId}" không tồn tại trong bảng places`,
            );
            return;
          }

          const { error } = await supabase
            .schema('travel')
            .from('itinerary_details')
            .insert({
              itinerary_id: id,
              place_id: act.placeId,
              visit_date: visitDate,
              arrival_time: act.startTime,
              duration_minutes: duration,
              sequence_order: act.sequenceOrder,
              detail_type: 'ACTIVITY',
            });

          if (error) {
            this.logger.error(
              `updateActivities insert failed for temporary activity ${act.id}: ${error.message}`,
            );
            throw new InternalServerErrorException(
              `Không thể lưu địa điểm mới: ${error.message}`,
            );
          }
        }
      }),
    );

    try {
      await this.recomputeCostEstimateAfterEdit(id);
    } catch (err: any) {
      this.logger.warn(
        `Cannot recompute itinerary_cost_estimates after updateActivities for ${id}: ${err?.message ?? err}`,
      );
    }

    return true;
  }

  async getItineraryDetail(id: string, touristId?: string) {
    const { data: itinerary, error: itinError } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('*')
      .eq('id', id)
      .eq('is_deleted', false)
      .maybeSingle();

    if (itinError) {
      this.logger.error(
        `getItineraryDetail itinerary query failed id=${id}: ${itinError.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to load itinerary: ${itinError.message}`,
      );
    }

    if (!itinerary) {
      throw new NotFoundException(`Itinerary not found: ${id}`);
    }

    const { data: details, error: detailError } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        `
        id,
        itinerary_id,
        place_id,
        visit_date,
        arrival_time,
        notes,
        estimated_cost,
        duration_minutes,
        sequence_order,
        detail_type,
        user_notes,
        locked_arrive_time,
        transport_cost,
        travel_distance_km,
        travel_minutes
      `,
      )
      .eq('itinerary_id', id)
      .order('visit_date', { ascending: true })
      .order('arrival_time', { ascending: true, nullsFirst: true });

    if (detailError) {
      this.logger.error(
        `getItineraryDetail details query failed id=${id}: ${detailError.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to load itinerary details: ${detailError.message}`,
      );
    }

    const hydratedSomething = await this.hydrateMissingTravelSnapshots(
      details ?? [],
      itinerary.travel_mode,
      Math.max(
        1,
        Number(itinerary.adult_count ?? 0) + Number(itinerary.children_count ?? 0),
      ),
    );
    // Nếu vừa tính + lưu thêm được chặng nào trước đó còn thiếu (thường do
    // Goong rate-limit lúc tạo lịch trình), itinerary_cost_estimates đang giữ
    // số CŨ (tính lúc còn thiếu dữ liệu) trong khi chi phí từng ngày ở màn
    // này đọc trực tiếp itinerary_details nên đã thấy số MỚI — lệch nhau.
    // Recompute lại NGAY (await) để response này cũng nhất quán luôn, không
    // phải đợi lần load sau — chỉ xảy ra ở lần đầu 1 chặng được hydrate xong,
    // các lần đọc sau đã có sẵn dữ liệu nên không tốn thêm gì.
    if (hydratedSomething) {
      try {
        await this.recomputeCostEstimate(id);
      } catch (err: any) {
        this.logger.warn(
          `Cannot recompute itinerary_cost_estimates after hydrate for ${id}: ${err?.message ?? err}`,
        );
      }
    }

    const placeIds = Array.from(
      new Set(
        (details || [])
          .map((detail: any) => detail.place_id)
          .filter(
            (placeId: unknown): placeId is string =>
              typeof placeId === 'string' && placeId.length > 0,
          ),
      ),
    );

    const placesById = new Map<string, any>();
    if (placeIds.length > 0) {
      const { data: places, error: placesError } = await supabase
        .schema('travel')
        .from('places')
        .select(
          `
          id,
          name,
          address,
          image_url,
          latitude,
          longitude,
          average_rating,
          review_count,
          slot_type,
          open_hour_compressed,
          types(categories(name))
        `,
        )
        .in('id', placeIds);

      if (placesError) {
        this.logger.error(
          `getItineraryDetail places query failed id=${id}: ${placesError.message}`,
        );
        throw new InternalServerErrorException(
          `Failed to load itinerary places: ${placesError.message}`,
        );
      }

      for (const place of places || []) {
        placesById.set((place as any).id, place);
      }
    }

    // Lấy trạng thái visit thực tế từ geofence_visits cho itinerary này.
    // Priority: visited > skipped > not_visited (default chuaDi)
    const visitStatusByDetailId = new Map<string, string>();
    try {
      const { data: geoVisits } = await supabase
        .schema('tracking')
        .from('geofence_visits')
        .select('itinerary_detail_id, status')
        .eq('itinerary_id', id);

      for (const v of geoVisits || []) {
        const detailId: string = v.itinerary_detail_id;
        const current = visitStatusByDetailId.get(detailId);
        if (v.status === 'visited') {
          visitStatusByDetailId.set(detailId, 'daDi');
        } else if (v.status === 'skipped' && current !== 'daDi') {
          visitStatusByDetailId.set(detailId, 'diQua');
        }
      }
    } catch (_) {
      // Nếu query tracking thất bại thì vẫn trả về dữ liệu bình thường với status mặc định.
    }

    const hotelDetail = (details || []).find(
      (detail: any) =>
        detail.detail_type === 'HOTEL' || this.isStartPointDetail(detail),
    );
    const adultCount = Math.max(0, Number(itinerary.adult_count ?? 0));
    const childCount = Math.max(0, Number(itinerary.children_count ?? 0));
    const participantCount = Math.max(1, adultCount + childCount);
    const daysMap = new Map<string, any[]>();
    for (const detail of details || []) {
      if (detail.detail_type === 'HOTEL' || this.isStartPointDetail(detail)) {
        continue;
      }
      const dateStr = detail.visit_date;
      if (!dateStr) {
        this.logger.warn(
          `Skipping itinerary_detail without visit_date id=${detail.id} itinerary=${id}`,
        );
        continue;
      }
      const list = daysMap.get(dateStr) || [];
      list.push({
        ...detail,
        place: placesById.get(detail.place_id) ?? null,
      });
      daysMap.set(dateStr, list);
    }

    const sortedDates = Array.from(daysMap.keys()).sort();

    const days = sortedDates.map((dateStr, index) => {
      const dayNumber = index + 1;
      const activitiesRaw = daysMap.get(dateStr) || [];
      // Day 1 starts directly from the first scheduled activity. From day 2
      // onward the hotel is shown as the day's departure point, but its cost
      // remains exclusively in the trip-level accommodation breakdown.
      const displayRows =
        hotelDetail && index > 0
          ? [
              {
                ...hotelDetail,
                visit_date: dateStr,
                estimated_cost: 0,
                place: placesById.get(hotelDetail.place_id) ?? null,
              },
              ...activitiesRaw,
            ]
          : activitiesRaw;

      const activities = displayRows.map((act, actIndex) => {
        const place = act.place;
        const images = place?.image_url;
        const imageUrl =
          Array.isArray(images) && images.length > 0
            ? images[0]
            : typeof images === 'string'
              ? images
              : 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=600&q=80';

        // Dữ liệu chặng được lưu trên điểm đến. Chuyển chặng kế tiếp sang
        // hoạt động hiện tại để khớp contract transitToNext của mobile.
        const nextAct = displayRows[actIndex + 1];
        const nextTravelMinutes = nextAct
          ? this.roundTravelMinutes(nextAct.travel_minutes)
          : 0;
        const nextTravelDistanceKm = nextAct
          ? Number(nextAct.travel_distance_km ?? 0)
          : 0;
        const nextTransportCost = nextAct
          ? Number(nextAct.transport_cost ?? 0)
          : 0;
        const transitInfo =
          nextTravelMinutes > 0
            ? `${this.formatDuration(nextTravelMinutes)} di chuyển`
            : null;
        // Do not synthesize a wait activity from legacy timestamp gaps.
        // Scheduler v2 enforces wait = 0 for newly generated itineraries.
        const waitMinutes = 0;
        const groupTransportCost = Math.max(0, Number(act.transport_cost ?? 0));
        const perPersonTransportCost =
          Math.round(groupTransportCost / participantCount / 1000) * 1000;
        const transportDisplay = nextAct
          ? [
              nextTravelMinutes > 0
                ? `${this.formatDuration(nextTravelMinutes)} di chuyển`
                : null,
              nextTravelDistanceKm > 0
                ? `${Number(nextTravelDistanceKm.toFixed(1))} km`
                : null,
              waitMinutes > 0
                ? `${this.formatDuration(waitMinutes)} chờ`
                : null,
            ]
              .filter((value): value is string => Boolean(value))
              .join(' • ')
          : null;

        const typeData = Array.isArray(place?.types)
          ? place.types[0]
          : place?.types;
        const catData = Array.isArray(typeData?.categories)
          ? typeData.categories[0]
          : typeData?.categories;
        const category: string | null = catData?.name ?? null;
        const durationMinutes = act.duration_minutes ?? 0;
        const sequenceOrder = act.sequence_order ?? actIndex + 1;
        const isAccommodation = this.isAccommodationCategory(category);
        const isStartPoint =
          act.detail_type === 'HOTEL' ||
          (isAccommodation && durationMinutes === 0 && sequenceOrder === 0);

        return {
          id: act.id,
          placeId: act.place_id,
          sequenceOrder,
          startTime: act.arrival_time || '08:00',
          endTime:
            this.addMinutesToTime(
              act.arrival_time,
              Number(act.duration_minutes ?? 0),
            ) || '09:00',
          placeName: place?.name || 'Điểm tham quan',
          address: place?.address || '',
          imageUrl: imageUrl,
          priceLabel: act.estimated_cost
            ? `${act.estimated_cost}đ`
            : 'MIỄN PHÍ',
          tags: [],
          transitToNext: transitInfo
            ? {
                durationStr: transitInfo,
                durationMinutes: nextTravelMinutes,
                distanceKm: nextTravelDistanceKm,
                estimatedCost: nextTransportCost,
                waitMinutes,
                waitStr:
                  waitMinutes > 0
                    ? `${this.formatDuration(waitMinutes)} chờ`
                    : null,
              }
            : null,
          transport_info: transportDisplay,
          title: place?.name || 'Điểm tham quan',
          locationName: place?.name || 'Điểm tham quan',
          estimatedCost: act.estimated_cost || 0,
          participantCount,
          participant_count: participantCount,
          price: act.estimated_cost || 0,
          transportCost: act.transport_cost || 0,
          transport_cost: act.transport_cost || 0,
          groupTransportCost,
          group_transport_cost: groupTransportCost,
          perPersonTransportCost,
          per_person_transport_cost: perPersonTransportCost,
          travelDistanceKm: Number(act.travel_distance_km ?? 0),
          travel_distance_km: Number(act.travel_distance_km ?? 0),
          currency: 'VNĐ',
          isFree: !act.estimated_cost,
          category:
            act.detail_type === 'HOTEL'
              ? 'hotel'
              : (place?.slot_type ?? category),
          categoryName: category,
          placeType:
            act.detail_type === 'HOTEL'
              ? 'hotel'
              : (place?.slot_type ?? 'attraction'),
          place_type:
            act.detail_type === 'HOTEL'
              ? 'hotel'
              : (place?.slot_type ?? 'attraction'),
          durationMinutes,
          isAccommodation,
          isStartPoint,
          open_hour_compressed: place?.open_hour_compressed ?? null,
          latitude: place?.latitude,
          longitude: place?.longitude,
          // Không tự tạo điểm đánh giá khi nguồn dữ liệu chưa có rating.
          // Client sẽ chỉ hiển thị khi cả rating và số lượt đánh giá là hợp lệ.
          rating:
            place?.average_rating != null
              ? Number(place.average_rating)
              : null,
          reviewCount:
            place?.review_count != null ? Number(place.review_count) : 0,
          // Hệ thống tự ghi (VD annotateDaysMissingRestaurant() cảnh báo
          // "không có quán ăn gần") — khác user_notes (người dùng tự nhập).
          notes: act.notes ?? null,
          status: visitStatusByDetailId.get(act.id) ?? 'chuaDi',
        };
      });

      const totalDurationMinutes = activities.reduce(
        (sum, activity) => sum + (activity.durationMinutes ?? 0),
        0,
      );
      const totalActivityCost = activities.reduce(
        (sum, activity) => sum + Number(activity.price ?? 0),
        0,
      );
      const totalTransportCost = activities.reduce(
        (sum, activity) => sum + Number(activity.transportCost ?? 0),
        0,
      );
      const totalDistanceKm = activitiesRaw.reduce(
        (sum, activity) =>
          sum + Math.max(0, Number(activity.travel_distance_km ?? 0)),
        0,
      );
      const totalTransitMinutes = activitiesRaw.reduce(
        (sum, activity) =>
          sum + this.roundTravelMinutes(activity.travel_minutes),
        0,
      );
      const totalDuration = this.formatDuration(totalDurationMinutes);
      const activityCount = activities.filter(
        (activity) => !activity.isStartPoint,
      ).length;

      let dateLabel = dateStr;
      try {
        const parts = dateStr.split('-');
        if (parts.length === 3) {
          dateLabel = `${parts[2]}/${parts[1]}`;
        }
      } catch (_) {}

      // "Tổng chi phí" mỗi ngày giờ CHỈ gồm địa điểm tham quan + ăn uống —
      // xăng xe tách ra hiển thị riêng 1 mục "cả chuyến" (giống khách sạn,
      // không thuộc về ngày nào cụ thể — xem transportCost ở cuối hàm và
      // _buildTransportOverviewRow bên mobile). transport_cost/dayBudget cũ
      // (đã gồm xăng xe) không còn dùng nữa, nhưng vẫn trả transport_cost
      // riêng của ngày đó để hiển thị thông tin (vd cùng quãng đường/km).
      const dayBudget = totalActivityCost;

      return {
        dateLabel: dateLabel,
        dayNumber: dayNumber,
        date: dateStr,
        weatherTemp: 30,
        activeTimeStr: totalDuration,
        dayBudget,
        participantCount,
        participant_count: participantCount,
        progressPercent: 0,
        totalDistanceStr: `${Number(totalDistanceKm.toFixed(1))}km`,
        totalTransitTimeStr: this.formatDuration(totalTransitMinutes),
        activities: activities,
        day_number: dayNumber,
        locations_count: activityCount,
        day_budget: dayBudget,
        place_cost: totalActivityCost,
        transport_cost: totalTransportCost,
        total_duration: totalDuration,
      };
    });

    const startStr = itinerary.start_date || '';
    const endStr = itinerary.end_date || '';
    const isFavorite = touristId
      ? await this.checkFavoriteItinerary(touristId, id)
      : false;
    const creatorId: string | null = itinerary.creator_id ?? null;
    const isOwner = Boolean(
      touristId?.trim() && creatorId && touristId.trim() === creatorId,
    );
    const members = await this.getItineraryMemberProfiles(id, creatorId);

    let diffDays = 1;
    try {
      const diffTime = Math.abs(
        new Date(endStr).getTime() - new Date(startStr).getTime(),
      );
      diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    } catch (_) {}

    const baselineAmountsByPlace =
      await this.loadBaselineExpenseAmountsByPlace(id);
    const costRows = (details || []).map((detail: any) => {
      const place = placesById.get(detail.place_id);
      const typeData = Array.isArray(place?.types)
        ? place.types[0]
        : place?.types;
      const catData = Array.isArray(typeData?.categories)
        ? typeData.categories[0]
        : typeData?.categories;
      const isHotel =
        detail.detail_type === 'HOTEL' ||
        this.isStartPointDetail(detail) ||
        this.isAccommodationCategory(catData?.name);
      const estimatedCost =
        baselineAmountsByPlace.get(detail.place_id) ??
        Number(detail.estimated_cost ?? 0);
      return {
        detail,
        isHotel,
        estimatedCost,
        transportCost: Number(detail.transport_cost ?? 0),
      };
    });
    const hotelIds = new Set(
      costRows
        .filter((row) => row.isHotel && row.detail?.place_id)
        .map((row) => row.detail.place_id),
    );
    const hotelDetailsCount = hotelIds.size;
    const nonHotelDetailsCount = Math.max(
      0,
      costRows.filter((row) => !row.isHotel).length,
    );
    const placeCost = costRows
      .filter((row) => !row.isHotel)
      .reduce((sum, row) => sum + row.estimatedCost, 0);
    const hotelCost = costRows
      .filter((row) => row.isHotel)
      .reduce((max, row) => Math.max(max, row.estimatedCost), 0);
    const transportCost = costRows.reduce(
      (sum, row) => sum + row.transportCost,
      0,
    );
    const rideHailingTransportCost =
      transportCost > 0 ? Math.round(transportCost * 2.5) : 0;
    const hotelNights = Math.max(1, (diffDays || days.length || 1) - 1);
    const hotelCostPerPersonPerNight =
      hotelCost > 0 ? Math.round(hotelCost / hotelNights) : 0;
    const { childPriceRatio } = await this.tripCostConfig.getConfig();
    // Tổng cả chuyến (totalBudget/estimatedCostForGroup) giờ đọc từ bảng chi
    // phí ước tính ĐÓNG BĂNG (itinerary_cost_estimates) — để khớp tuyệt đối
    // với Danh sách/Sổ chi tiêu, không còn tính riêng 1 công thức lệch (thiếu
    // 10% dự trù, vẫn ưu tiên giá đã sửa qua check-in) như trước nữa. Các
    // field khác bên trên (hotelCostPerPersonPerNight, rideHailingTransportCost,
    // hotelDetailsCount, nonHotelDetailsCount) vẫn dùng costRows/placeCost/
    // hotelCost LIVE (phản ánh giá đã sửa qua check-in) — đúng mục đích hiển
    // thị giá thực tế từng địa điểm trong ngày, không đụng vào.
    const frozen = await this.getCachedCostBreakdown(id);
    const calculatedTripCost = this.perAdultTripTotal(
      frozen.placeCost,
      frozen.hotelCost,
      frozen.transportCost,
      participantCount,
    );
    const transportPerAdultForChild =
      Math.round(frozen.transportCost / participantCount / 1000) * 1000;
    const childBaseCost =
      frozen.placeCost * childPriceRatio +
      frozen.hotelCost * childPriceRatio +
      transportPerAdultForChild;
    const estimatedCostForGroup = Math.round(
      calculatedTripCost * adultCount + childBaseCost * childCount,
    );

    return {
      id: itinerary.id,
      title: itinerary.description || 'Chi tiết lịch trình',
      tripIntent: itinerary.trip_intent ?? null,
      trip_intent: itinerary.trip_intent ?? null,
      creatorId,
      creator_id: creatorId,
      isOwner,
      is_owner: isOwner,
      members,
      dateRangeLabel: `${startStr} - ${endStr}`,
      status: (itinerary.status || 'pending').toUpperCase(),
      trackingActive: itinerary.tracking_active === true,
      tracking_active: itinerary.tracking_active === true,
      isPublic: itinerary.is_public || false,
      is_favorite: isFavorite,
      isFavorite,
      totalBudget: frozen.calculatedTripCost,
      estimatedCostForGroup,
      estimated_cost_for_group: estimatedCostForGroup,
      childPriceRatio,
      child_price_ratio: childPriceRatio,
      calculatedTripCost,
      calculated_trip_cost: calculatedTripCost,
      adultCount,
      adult_count: adultCount,
      childCount,
      children_count: childCount,
      participantCount,
      participant_count: participantCount,
      totalDays: diffDays || days.length || 1,
      totalPlaces: nonHotelDetailsCount,
      hotelsCount: hotelDetailsCount,
      days: days,
      destination: itinerary.destination || '',
      start_date: startStr,
      end_date: endStr,
      dailyStartTime: itinerary.daily_start_time || '07:00',
      dailyEndTime: itinerary.daily_end_time || '22:00',
      daily_start_time: itinerary.daily_start_time || '07:00',
      daily_end_time: itinerary.daily_end_time || '22:00',
      durationDays: diffDays || days.length || 1,
      activitiesCount: nonHotelDetailsCount,
      estimatedBudget: frozen.calculatedTripCost,
      estimated_budget: frozen.calculatedTripCost,
      // User's original input budget ceiling, stored in itineraries.estimated_cost
      // (repurposed: this column now holds the user's input, not a computed
      // cost) — separate from estimatedBudget above (đọc từ bảng chi phí ước
      // tính đóng băng itinerary_cost_estimates). Mobile shows both side by
      // side and warns when estimatedBudget exceeds 90% of this.
      userBudget: Number(itinerary.estimated_cost ?? 0),
      user_budget: Number(itinerary.estimated_cost ?? 0),
      // Needed so the mobile map/route-drawing can pass the right vehicle
      // mode to Goong/Google Maps instead of always assuming car (see
      // map_utils.dart getGoongRoute/getDirectionsUrl).
      travelMode: itinerary.travel_mode ?? 'DRIVING',
      travel_mode: itinerary.travel_mode ?? 'DRIVING',
      placeCost,
      place_cost: placeCost,
      hotelCost,
      hotel_cost: hotelCost,
      hotelNights,
      hotel_nights: hotelNights,
      hotelCostPerPersonPerNight,
      hotel_cost_per_person_per_night: hotelCostPerPersonPerNight,
      transportCost,
      transport_cost: transportCost,
      rideHailingTransportCost,
      ride_hailing_transport_cost: rideHailingTransportCost,
      centerCoordinate: [10.7769, 106.7009],
      notes: [
        'Chuẩn bị quần áo thoải mái và phù hợp.',
        'Đem theo các giấy tờ tùy thân đầy đủ.',
      ],
      visitedRestaurants: [],
    };
  }

  private async checkFavoriteItinerary(
    touristId: string,
    itineraryId: string,
  ): Promise<boolean> {
    const { data, error } = await supabase
      .schema('travel')
      .from('favorite_itineraries')
      .select('tourist_id')
      .eq('tourist_id', touristId)
      .eq('itinerary_id', itineraryId)
      .maybeSingle<{ tourist_id: string }>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return Boolean(data);
  }

  /**
   * Lấy danh sách thành viên của lịch trình (gồm cả chủ lịch trình) kèm
   * họ tên và avatar để mobile hiển thị ở màn tóm tắt. Lỗi ở đây không
   * được làm hỏng response chi tiết nên luôn fallback về mảng rỗng.
   */
  async getItineraryMemberProfiles(
    itineraryId: string,
    creatorId: string | null,
  ): Promise<
    Array<{
      id: string;
      fullName: string;
      avatarUrl: string;
      isOwner: boolean;
    }>
  > {
    try {
      const { data: memberRows, error: memberError } = await supabase
        .schema('travel')
        .from('itinerary_members')
        .select('tourist_id')
        .eq('itinerary_id', itineraryId);

      if (memberError) {
        this.logger.warn(
          `getItineraryMemberProfiles members query failed itinerary=${itineraryId}: ${memberError.message}`,
        );
        return [];
      }

      const memberIds: string[] = [];
      if (creatorId) {
        memberIds.push(creatorId);
      }
      for (const row of memberRows ?? []) {
        const touristId = (row as any).tourist_id;
        if (
          typeof touristId === 'string' &&
          touristId.length > 0 &&
          !memberIds.includes(touristId)
        ) {
          memberIds.push(touristId);
        }
      }
      if (memberIds.length === 0) {
        return [];
      }

      const { data: users, error: userError } = await supabase
        .schema('public')
        .from('users')
        .select('id, full_name, avatar_url')
        .in('id', memberIds);

      if (userError) {
        this.logger.warn(
          `getItineraryMemberProfiles users query failed itinerary=${itineraryId}: ${userError.message}`,
        );
        return [];
      }

      const usersById = new Map<string, any>();
      for (const user of users ?? []) {
        usersById.set((user as any).id, user);
      }

      // Giữ nguyên thứ tự: chủ lịch trình đứng đầu, sau đó tới các member.
      return memberIds
        .filter((memberId) => usersById.has(memberId))
        .map((memberId) => {
          const user = usersById.get(memberId);
          return {
            id: memberId,
            fullName: ((user.full_name ?? '') as string).trim(),
            avatarUrl: ((user.avatar_url ?? '') as string).trim(),
            isOwner: creatorId != null && memberId === creatorId,
          };
        });
    } catch (err) {
      this.logger.warn(
        `getItineraryMemberProfiles failed itinerary=${itineraryId}: ${String(err)}`,
      );
      return [];
    }
  }

  /**
   * Tính thời gian di chuyển giữa 2 địa điểm dựa trên gap thời gian.
   * @param departureStr - Giờ rời khỏi địa điểm hiện tại "HH:mm" hoặc "HH:mm:ss"
   * @param nextArrivalStr - Giờ đến địa điểm kế tiếp "HH:mm" hoặc "HH:mm:ss"
   * @returns Chuỗi mô tả như "15 phút di chuyển", "1 giờ 10 phút di chuyển", hoặc null nếu dữ liệu không hợp lệ
   */
  private _calcTransitLabel(
    departureStr: string,
    nextArrivalStr: string,
  ): string | null {
    if (!departureStr || !nextArrivalStr) return null;
    try {
      const toMinutes = (t: string): number => {
        const parts = t.split(':').map(Number);
        return parts[0] * 60 + parts[1];
      };
      const gapMins = toMinutes(nextArrivalStr) - toMinutes(departureStr);
      if (gapMins <= 0) return null;
      if (gapMins < 60) return `${gapMins} phút di chuyển`;
      const h = Math.floor(gapMins / 60);
      const m = gapMins % 60;
      return m === 0 ? `${h} giờ di chuyển` : `${h} giờ ${m} phút di chuyển`;
    } catch (_) {
      return null;
    }
  }

  /**
   * Xác định giờ mở/đóng cửa cho một địa điểm.
   * Ưu tiên: openTime/closeTime tường minh → parse openHourCompressed → default.
   *
   * openHourCompressed format (từ DB / Google):
   *   {"Monday":[["07:00:00","22:00:00"]],"Tuesday":[...],...}
   */
  private _resolveOpenClose(
    openTime: string | null | undefined,
    closeTime: string | null | undefined,
    openHourCompressed: string | null | undefined,
    visitDate: string,
  ): { open_time: string; close_time: string } {
    const DEFAULT = { open_time: '07:00', close_time: '22:00' };

    if (openTime && closeTime) {
      return {
        open_time: openTime.slice(0, 5),
        close_time: closeTime.slice(0, 5),
      };
    }

    if (openHourCompressed) {
      try {
        const hours: Record<string, string[][]> =
          JSON.parse(openHourCompressed);
        const DAY_NAMES = [
          'Sunday',
          'Monday',
          'Tuesday',
          'Wednesday',
          'Thursday',
          'Friday',
          'Saturday',
        ];
        const dayName = DAY_NAMES[new Date(visitDate).getDay()];
        const slots = hours[dayName];
        if (Array.isArray(slots) && slots.length > 0) {
          const [open, close] = slots[0];
          if (open && close) {
            return {
              open_time: String(open).slice(0, 5),
              close_time: String(close).slice(0, 5),
            };
          }
        }
      } catch (_) {
        // JSON parse failed — fall through to default
      }
    }

    return DEFAULT;
  }

  /**
   * Một activity chỉ được coi là "địa điểm ăn trưa" khi thỏa cả 2 điều kiện (AND):
   * 1. place_type (travel.places.slot_type — cùng nguồn với lúc tạo lịch trình) = 'restaurant'.
   * 2. CẢ giờ đến VÀ giờ rời đều nằm trong khung giờ ăn trưa (LUNCH_START_MIN..LUNCH_END_MIN)
   *    — khớp đúng ràng buộc cứng solver dùng khi tối ưu lại (itinerary_optimizer.py:
   *    `arrival >= LUNCH_START AND departure <= LUNCH_END`), không chỉ riêng giờ đến.
   */
  private isRestaurant(
    placeType: string | null | undefined,
    arrivalTimeStr?: string | null,
    departureTimeStr?: string | null,
  ): boolean {
    const isFoodPlace = (placeType ?? '').trim().toLowerCase() === 'restaurant';
    if (!isFoodPlace) return false;

    if (arrivalTimeStr && departureTimeStr) {
      try {
        const [ah, am] = arrivalTimeStr.split(':').map(Number);
        const [dh, dm] = departureTimeStr.split(':').map(Number);
        const arrivalMin = ah * 60 + (am || 0);
        const departureMin = dh * 60 + (dm || 0);
        return arrivalMin >= LUNCH_START_MIN && departureMin <= LUNCH_END_MIN;
      } catch (e) {
        // Ignore parse errors, fall back to place_type only
      }
    }

    return isFoodPlace;
  }

  private extractCategoryName(places: any): string | null {
    if (!places) return null;
    let result = '';

    if (places.categories?.name) {
      result += places.categories.name + ' ';
    }

    const typeData = Array.isArray(places.types) ? places.types[0] : places.types;
    if (typeData) {
      const catData = Array.isArray(typeData.categories) ? typeData.categories[0] : typeData.categories;
      if (catData?.name) {
        result += catData.name + ' ';
      }
      if (typeData.name) {
        result += typeData.name + ' ';
      }
    }
    
    return result.trim() || null;
  }
  async optimizeDayRoute(
    activities: any[],
    dailyStartTime?: string,
    dailyEndTime?: string,
    allowReduceTime: boolean = false,
    visitDate?: string,
  ): Promise<{ optimized: any[]; reorderNotes: string[] }> {
    if (activities.length === 0) return { optimized: [], reorderNotes: [] };

    const resolvedVisitDate =
      visitDate ?? new Date().toISOString().split('T')[0];

    // ─── Tra place_type (travel.places.slot_type) theo placeId ──
    // Dùng để nhận diện địa điểm ăn trưa — cùng cơ chế với lúc tạo lịch trình,
    // thay vì đoán qua từ khóa category do client gửi lên.
    const incomingPlaceIds = activities
      .map((a: any) => a.placeId)
      .filter(Boolean);
    const placeTypeMap = new Map<string, string | null>();
    if (incomingPlaceIds.length > 0) {
      const { data: placesData } = await supabase
        .schema('travel')
        .from('places')
        .select('id, slot_type')
        .in('id', incomingPlaceIds);
      (placesData || []).forEach((p: any) =>
        placeTypeMap.set(p.id, p.slot_type ?? null),
      );
    }

    try {
      // ─── Chuẩn bị payload cho TSPTW optimizer (đầy đủ ràng buộc) ─
      const payload = {
        itinerary_id: 'client-optimize', // placeholder — không cần lưu DB
        visit_date: resolvedVisitDate,
        day_start_time: this.trimTime(dailyStartTime) || '07:00',
        day_end_time: this.trimTime(dailyEndTime) || '22:00',
        activities: activities.map((a: any) => {
          // Tính duration từ startTime/endTime nếu không có sẵn
          const startMin = this.toMinutes(a.startTime || '07:00');
          const endMin = this.toMinutes(a.endTime || '08:00');
          const duration = endMin - startMin > 0 ? endMin - startMin : 60;

          // openTime/closeTime: ưu tiên trường tường minh, rồi parse openHourCompressed
          let { open_time, close_time } = this._resolveOpenClose(
            a.openTime,
            a.closeTime,
            a.openHourCompressed,
            resolvedVisitDate,
          );

          const dayEndStr = this.trimTime(dailyEndTime) || '22:00';
          if (this.toMinutes(close_time) > this.toMinutes(dayEndStr)) {
            close_time = dayEndStr;
          }

          return {
            id: a.id,
            place_id: a.id, // dùng id làm place_id
            duration_minutes: a.durationMinutes ?? duration,
            is_locked: a.isLocked ?? false,
            locked_arrive_time: a.lockedArriveTime ?? null,
            lat: a.latitude ?? null,
            lng: a.longitude ?? null,
            open_time,
            close_time,
            estimated_cost: a.price ?? 0,
            category: a.category ?? null,
            is_restaurant: this.isRestaurant(
              a.placeId ? placeTypeMap.get(a.placeId) : null,
              a.lockedArriveTime || a.startTime,
              this.addMinutesToTime(
                a.lockedArriveTime || a.startTime,
                a.durationMinutes ?? duration,
              ),
            ),
            original_arrival_time: a.startTime ?? null,
            // Flutter đánh dấu activity mới bằng isNew: true → optimizer chèn vào vị trí tối ưu
            is_new: a.isNew ?? false,
          };
        }),
        allow_reduce_time: allowReduceTime,
      };

      const response = await axios.post(
        `${AI_SERVICE_URL}/api/v1/itinerary/optimize`,
        payload,
        { timeout: 10000 },
      );

      const optimized: any[] = response.data?.optimized_activities ?? [];
      let reorderNotes: string[] = response.data?.reorder_notes ?? [];
      if (optimized.length === 0)
        return { optimized: activities, reorderNotes: [] };

      reorderNotes = reorderNotes.map((note) => {
        let newNote = note;
        for (const a of activities) {
          if (newNote.includes(a.id)) {
            newNote = newNote.replace(
              a.id,
              a.title || a.locationName || 'địa điểm',
            );
          }
        }
        return newNote;
      });

      // Map kết quả TSPTW về format Flutter mong đợi
      const mappedOptimized = optimized.map((opt: any) => {
        const original = activities.find((a: any) => a.id === opt.id) ?? {};
        return {
          ...original,
          startTime: opt.arrival_time,
          endTime: opt.departure_time,
          transportInfo: opt.transport_to_next ?? original.transportInfo,
          durationMinutes: opt.duration_minutes ?? original.durationMinutes,
        };
      });

      return { optimized: mappedOptimized, reorderNotes };
    } catch (e: any) {
      // Python AI service trả về 422 khi lịch kín — phải check 422, không phải 400
      if (
        e.response?.status === 422 &&
        e.response?.data?.detail === 'SCHEDULE_FULL'
      ) {
        throw new BadRequestException('SCHEDULE_FULL');
      }
      console.error('optimizeDayRoute failed:', e);
      if (allowReduceTime) {
        // Ném lỗi 500 nếu AI server timeout, để khách hàng biết là do server chứ không phải do lịch kín
        throw new Error('AI Server is unresponsive or timed out.');
      }
      return { optimized: activities, reorderNotes: [] }; // Fallback: giữ nguyên thứ tự cũ
    }
  }

  private toMinutes(t: string): number {
    if (!t) return 0;
    const parts = t.split(':').map(Number);
    return parts[0] * 60 + parts[1];
  }

  private toTimeString(m: number): string {
    const h = Math.floor(m / 60) % 24;
    const min = m % 60;
    return `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
  }

  // ─── Missing helpers (restored after rebase) ─────────────────────

  /** Cắt bỏ phần giây nếu có, chuẩn hoá về "HH:mm" */
  private trimTime(t: string | null | undefined): string {
    if (!t) return '';
    return t.slice(0, 5);
  }

  /** Ném lỗi nếu plan AI trả về không dùng được */
  private assertPlanIsUsable(plan: AIPlanResult): void {
    if (!plan || !Array.isArray(plan.days) || plan.days.length === 0) {
      throw new BadRequestException(
        'AI planner returned an empty or invalid itinerary plan',
      );
    }
    if (!plan.hotel_id || plan.hotel_id === 'demo_hotel') {
      throw new BadRequestException(
        'AI planner did not return a real hotel for this itinerary',
      );
    }
  }

  /** Lấy tên thành phố theo locationId, trả null nếu không tìm thấy */
  private async getCityNameOrNull(locationId: string): Promise<string | null> {
    if (!locationId) return null;
    const { data } = await supabase
      .schema('travel')
      .from('cities')
      .select('name')
      .eq('id', locationId)
      .maybeSingle();
    return (data as any)?.name ?? null;
  }

  /** Trả true nếu entry nên được lưu vào DB (bỏ qua điểm trả về khách sạn) */
  private shouldPersistScheduleEntry(entry: ScheduleEntry): boolean {
    return !entry.is_return_to_hotel && !!entry.location_id;
  }

  private buildHotelDetailRow(
    itineraryId: string,
    plan: AIPlanResult,
    visitDate: string,
    dailyStartTime: string,
    estimatedCost = 0,
  ) {
    const startTime = this.trimTime(dailyStartTime) || '08:00';
    return {
      itinerary_id: itineraryId,
      place_id: plan.hotel_id,
      visit_date: visitDate,
      arrival_time: startTime,
      duration_minutes: 0,
      sequence_order: 0,
      detail_type: 'HOTEL',
      estimated_cost: estimatedCost,
      is_locked: true,
      // Không ghi note mô tả cho dòng khách sạn nữa — mobile không hiển thị
      // banner cho detail_type=HOTEL (xem timeline_activity_card.dart), và
      // notes ở đây chỉ để trống cho annotateDaysMissingRestaurant() dùng
      // sau này nếu cần (dòng HOTEL không nằm trong phạm vi hàm đó).
      notes: null,
    };
  }

  private async getPlaceEstimatedCostMap(
    plan: AIPlanResult,
  ): Promise<Map<string, number>> {
    const ids = new Set<string>();
    if (plan.hotel_id) ids.add(plan.hotel_id);
    for (const day of plan.days || []) {
      for (const entry of day.schedule || []) {
        if (entry?.location_id) ids.add(entry.location_id);
      }
    }
    if (ids.size === 0) return new Map();

    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .select('id, price')
      .in('id', Array.from(ids));

    if (error) {
      this.logger.warn(`Cannot load place estimated costs: ${error.message}`);
      return new Map();
    }

    return new Map(
      (data || []).map((row: any) => [row.id, Number(row.price ?? 0)]),
    );
  }

  /**
   * Phần thuần đồng bộ của estimateSelfDriveTransportCost — tách riêng để
   * createGeneratedItinerary() có thể tính transport_cost cho hàng chục
   * activity row cùng lúc mà chỉ cần `await getConfig()` đúng 1 lần (TTL
   * cache 60s, xem trip-cost-config.service.ts) thay vì spawn hàng chục
   * promise chỉ để đọc lại đúng 1 config đã cache.
   */
  private computeSelfDriveTransportCostSync(
    distanceKm: number | null | undefined,
    transportMode: string | undefined,
    headcount: number,
    config: TripCostConfig,
  ): number {
    const km = Number(distanceKm ?? 0);
    if (!Number.isFinite(km) || km <= 0) return 0;
    const mode = (transportMode ?? '').toUpperCase();
    // Same canonical keys as trip_cost_config_service.py: ROAD has always
    // been priced the same as CAR here, so it maps onto "car".
    const capacityMode = mode === TransportMode.MOTORBIKE ? 'motorbike' : 'car';
    const costPerKm =
      config.transportCostPerKm[capacityMode] ?? config.transportCostPerKmDefault;
    // Fuel cost is per vehicle, not per person: the group needs
    // ceil(headcount / seats_per_vehicle) vehicles, each burning fuel over
    // the same distance.
    const vehicles = this.tripCostConfig.vehiclesNeeded(headcount, capacityMode, config);
    // Rounded to the nearest 1,000đ (not the nearest đ) — gasoline cost is an
    // estimate, showing exact-đồng precision reads as falsely precise.
    return Math.round((km * costPerKm * vehicles) / 1000) * 1000;
  }

  private async estimateSelfDriveTransportCost(
    distanceKm: number | null | undefined,
    transportMode?: string,
    headcount = 1,
  ): Promise<number> {
    const config = await this.tripCostConfig.getConfig();
    return this.computeSelfDriveTransportCostSync(
      distanceKm,
      transportMode,
      headcount,
      config,
    );
  }

  /**
   * placeCost/hotelCost are already per-adult (see recommendation.service.ts).
   * transportCost is a real shared cost (fuel for the group's vehicles), so
   * it's divided by the real headcount once here — never per-activity/per-day
   * — before folding it into the per-adult total, to avoid compounding
   * rounding error across many small divisions.
   */
  /**
   * Giá HIỆU LỰC hiện tại theo place_id — đọc từ dòng "Chi phí kế hoạch" đã
   * lưu (IncurredCostsService.recordVisitBaselineExpense() ghi lúc check-in,
   * updatePlaceEffectivePrice() sửa trực tiếp sau đó — không còn cơ chế
   * "Điều chỉnh giá" dạng delta cộng dồn nữa). Dùng chung bởi cả
   * getItineraryDetail() và calculateTripCostBreakdown() để 1 giá đã sửa
   * không bao giờ bị thiếu ở đường này mà lại lộ ra ở đường kia (đúng lớp
   * bug "2 công thức lệch nhau" đã fix trong phiên này). Địa điểm CHƯA
   * visited thì chưa có dòng baseline — map sẽ không có key đó, gọi nơi
   * dùng phải tự fallback về estimated_cost gốc.
   */
  async loadBaselineExpenseAmountsByPlace(
    itineraryId: string,
  ): Promise<Map<string, number>> {
    const { data, error } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .select('place_id, amount')
      .eq('itinerary_id', itineraryId)
      .eq('type', CostType.CHI_PHI_KE_HOACH);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load baseline expenses: ${error.message}`,
      );
    }
    const amountsByPlace = new Map<string, number>();
    for (const row of data ?? []) {
      const placeId = (row as any).place_id;
      if (!placeId) continue;
      amountsByPlace.set(placeId, Number((row as any).amount ?? 0));
    }
    return amountsByPlace;
  }

  /**
   * Tổng delta "Điều chỉnh xăng xe" cho cả chuyến — khác loadBaselineExpenseAmountsByPlace
   * ở chỗ không group theo place_id (điều chỉnh xăng xe áp dụng cho CẢ
   * CHUYẾN, không gắn 1 địa điểm/ngày cụ thể — xem CostType.DIEU_CHINH_XANG_XE).
   * Có thể âm (giảm chi phí xăng xe so với ước tính).
   */
  async loadTransportAdjustmentDelta(itineraryId: string): Promise<number> {
    const { data, error } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .select('amount')
      .eq('itinerary_id', itineraryId)
      .eq('type', CostType.DIEU_CHINH_XANG_XE);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load transport adjustments: ${error.message}`,
      );
    }
    return (data ?? []).reduce(
      (sum, row: any) => sum + Number(row.amount ?? 0),
      0,
    );
  }

  /** Public: cũng dùng bởi IncurredCostsService.computeCostBreakdown() để suy
   * lại calculatedTripCost RAW (chưa reserve) từ place/hotel/transport RAW đã
   * lấy sẵn từ itinerary_cost_estimates. */
  perAdultTripTotal(
    placeCost: number,
    hotelCost: number,
    transportCost: number,
    participantCount: number,
  ): number {
    const transportPerAdult =
      Math.round(transportCost / Math.max(1, participantCount) / 1000) * 1000;
    return Math.round(placeCost + hotelCost + transportPerAdult);
  }

  calculatePlanEstimatedCost(
    plan: AIPlanResult,
    adultCount: number,
    childCount: number,
  ): number {
    const hotelCost = Math.max(
      0,
      Number(plan.hotel_selection?.hotel_total_cost ?? 0),
    );
    const activityCost = (plan.days ?? []).reduce(
      (total, day) =>
        total +
        (day.schedule ?? []).reduce((dayTotal, entry) => {
          if (entry.is_return_to_hotel) return dayTotal;
          return dayTotal + Math.max(0, Number(entry.estimated_cost ?? 0));
        }, 0),
      0,
    );
    const transportCost = (plan.days ?? []).reduce(
      (total, day: any) =>
        total + Math.max(0, Number(day.total_transport_cost ?? 0)),
      0,
    );
    const participantCount = Math.max(1, adultCount + childCount);
    return this.perAdultTripTotal(
      activityCost,
      hotelCost,
      transportCost,
      participantCount,
    );
  }

  calculateRecommendedBudget(
    plan: AIPlanResult,
    adultCount: number,
    childCount: number,
  ): number {
    const calculatedCost = this.calculatePlanEstimatedCost(
      plan,
      adultCount,
      childCount,
    );
    if (calculatedCost <= 0) return 0;
    const withReserve = calculatedCost / 0.9;
    return Math.ceil(withReserve / 1_000_000) * 1_000_000;
  }

  /**
   * Engine tính chi phí ƯỚC TÍNH đóng băng của 1 lịch trình — nguồn duy nhất
   * ghi vào travel.itinerary_cost_estimates (xem recomputeCostEstimate()).
   * placeCost/hotelCost luôn lấy RAW từ itinerary_details.estimated_cost —
   * KHÔNG bao giờ ưu tiên giá đã sửa qua check-in/"Sửa giá" (đó là luồng
   * "đã chi/thực tế" hoàn toàn tách biệt, xem IncurredCostsService).
   * transportCost chỉ tính từ khoảng cách thật (distance_matrix/Goong) —
   * KHÔNG cộng "Điều chỉnh xăng xe" (khoản đó cũng chỉ tồn tại trong
   * incurred_costs, không đụng vào số ước tính đóng băng này).
   */
  async calculateTripCostBreakdown(
    itineraryId: string,
  ): Promise<{
    placeCost: number;
    hotelCost: number;
    transportCost: number;
    calculatedTripCost: number;
  }> {
    const { data: itinerary, error: itineraryError } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('adult_count, children_count, travel_mode')
      .eq('id', itineraryId)
      .maybeSingle();
    if (itineraryError) {
      throw new InternalServerErrorException(
        `Failed to load itinerary: ${itineraryError.message}`,
      );
    }
    const adultCount = Math.max(0, Number((itinerary as any)?.adult_count ?? 0));
    const childCount = Math.max(
      0,
      Number((itinerary as any)?.children_count ?? 0),
    );

    const { data: details, error: detailError } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        'id, place_id, detail_type, estimated_cost, duration_minutes, sequence_order, visit_date, transport_cost, travel_distance_km, travel_minutes',
      )
      .eq('itinerary_id', itineraryId);
    if (detailError) {
      throw new InternalServerErrorException(
        `Failed to load itinerary details: ${detailError.message}`,
      );
    }

    await this.hydrateMissingTravelSnapshots(
      details ?? [],
      (itinerary as any)?.travel_mode,
      Math.max(1, adultCount + childCount),
    );

    const placeIds = [
      ...new Set((details ?? []).map((d: any) => d.place_id).filter(Boolean)),
    ];
    const placesById = new Map<string, any>();
    if (placeIds.length > 0) {
      const { data: places, error: placesError } = await supabase
        .schema('travel')
        .from('places')
        .select('id, types(categories(name))')
        .in('id', placeIds);
      if (placesError) {
        throw new InternalServerErrorException(
          `Failed to load places: ${placesError.message}`,
        );
      }
      for (const place of places ?? []) {
        placesById.set((place as any).id, place);
      }
    }

    const costRows = (details ?? []).map((detail: any) => {
      const place = placesById.get(detail.place_id);
      const typeData = Array.isArray(place?.types)
        ? place.types[0]
        : place?.types;
      const catData = Array.isArray(typeData?.categories)
        ? typeData.categories[0]
        : typeData?.categories;
      const isHotel =
        detail.detail_type === 'HOTEL' ||
        this.isStartPointDetail(detail) ||
        this.isAccommodationCategory(catData?.name);
      return {
        isHotel,
        estimatedCost: Number(detail.estimated_cost ?? 0),
        transportCost: Number(detail.transport_cost ?? 0),
      };
    });
    const placeCost = costRows
      .filter((row) => !row.isHotel)
      .reduce((sum, row) => sum + row.estimatedCost, 0);
    const hotelCost = costRows
      .filter((row) => row.isHotel)
      .reduce((max, row) => Math.max(max, row.estimatedCost), 0);
    const transportCost = costRows.reduce(
      (sum, row) => sum + row.transportCost,
      0,
    );
    const participantCount = Math.max(1, adultCount + childCount);
    return {
      placeCost,
      hotelCost,
      transportCost,
      calculatedTripCost: this.perAdultTripTotal(
        placeCost,
        hotelCost,
        transportCost,
        participantCount,
      ),
    };
  }

  /** Ghi/upsert 1 dòng travel.itinerary_cost_estimates — lỗi ghi cache không
   * được làm fail thao tác gốc (tạo/sửa lịch trình), chỉ log warn. */
  private async upsertCostEstimate(
    itineraryId: string,
    breakdown: {
      placeCost: number;
      hotelCost: number;
      transportCost: number;
      calculatedTripCost: number;
    },
  ): Promise<void> {
    try {
      const roundedCalculatedTripCost =
        Math.round((breakdown.calculatedTripCost * 1.1) / 100000) * 100000;
      const { error } = await supabase
        .schema('travel')
        .from('itinerary_cost_estimates')
        .upsert(
          {
            itinerary_id: itineraryId,
            place_cost: breakdown.placeCost,
            hotel_cost: breakdown.hotelCost,
            transport_cost: breakdown.transportCost,
            calculated_trip_cost: roundedCalculatedTripCost,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'itinerary_id' },
        );
      if (error) {
        this.logger.warn(
          `Cannot upsert itinerary_cost_estimates for ${itineraryId}: ${error.message}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Cannot upsert itinerary_cost_estimates for ${itineraryId}: ${err?.message ?? err}`,
      );
    }
  }

  /** Tính lại (từ nguồn) + ghi đè travel.itinerary_cost_estimates — gọi ở mọi
   * điểm sửa cấu trúc lịch trình (tạo mới/thêm/xóa/đổi hoạt động). KHÔNG gọi
   * từ check-in/"Sửa giá"/"Điều chỉnh xăng xe" — các luồng đó không được
   * phép đụng vào số ước tính đóng băng. */
  async recomputeCostEstimate(itineraryId: string): Promise<{
    placeCost: number;
    hotelCost: number;
    transportCost: number;
    calculatedTripCost: number;
  }> {
    const breakdown = await this.calculateTripCostBreakdown(itineraryId);
    await this.upsertCostEstimate(itineraryId, breakdown);
    return breakdown;
  }

  /** Đọc chi phí ước tính đóng băng; nếu lịch trình chưa từng có dòng cache
   * (tạo trước khi có bảng này) thì tính + backfill 1 lần rồi trả về. */
  async getCachedCostBreakdown(itineraryId: string): Promise<{
    placeCost: number;
    hotelCost: number;
    transportCost: number;
    calculatedTripCost: number;
  }> {
    const { data, error } = await supabase
      .schema('travel')
      .from('itinerary_cost_estimates')
      .select('place_cost, hotel_cost, transport_cost, calculated_trip_cost')
      .eq('itinerary_id', itineraryId)
      .maybeSingle();
    if (error) {
      this.logger.warn(
        `Cannot read itinerary_cost_estimates for ${itineraryId}: ${error.message}`,
      );
    }
    if (data) {
      return {
        placeCost: Number((data as any).place_cost ?? 0),
        hotelCost: Number((data as any).hotel_cost ?? 0),
        transportCost: Number((data as any).transport_cost ?? 0),
        calculatedTripCost: Number((data as any).calculated_trip_cost ?? 0),
      };
    }
    return this.recomputeCostEstimate(itineraryId);
  }

  /** Xóa snapshot khoảng cách/chi phí xăng đã lưu trên itinerary_details của
   * CẢ lịch trình — gọi khi sửa cấu trúc lịch trình làm đổi thứ tự chặng
   * (thêm/xóa/đổi/sắp xếp lại hoạt động), vì "điểm trước đó" của nhiều dòng
   * đã đổi nên số cũ không còn đúng nữa. hydrateMissingTravelSnapshots() sẽ
   * tự tính + lưu lại ở lần đọc kế tiếp (bên trong recomputeCostEstimate()). */
  private async resetTravelSnapshots(itineraryId: string): Promise<void> {
    try {
      const { error } = await supabase
        .schema('travel')
        .from('itinerary_details')
        .update({
          transport_cost: null,
          travel_distance_km: null,
          travel_minutes: null,
        })
        .eq('itinerary_id', itineraryId);
      if (error) {
        this.logger.warn(
          `Cannot reset travel snapshots for itinerary ${itineraryId}: ${error.message}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Cannot reset travel snapshots for itinerary ${itineraryId}: ${err?.message ?? err}`,
      );
    }
  }

  /** Gọi ở mọi điểm sửa cấu trúc lịch trình sau khi tạo (thêm/xóa/đổi hoạt
   * động): reset snapshot chặng cũ rồi tính lại + ghi đè chi phí ước tính
   * đóng băng. Không dùng cho lần tạo lịch trình đầu tiên (chưa có snapshot
   * cũ nào để reset — gọi thẳng recomputeCostEstimate()). */
  async recomputeCostEstimateAfterEdit(itineraryId: string): Promise<{
    placeCost: number;
    hotelCost: number;
    transportCost: number;
    calculatedTripCost: number;
  }> {
    await this.resetTravelSnapshots(itineraryId);
    return this.recomputeCostEstimate(itineraryId);
  }

  /**
   * "Chi phí ước tính của tất cả thành viên" — NGUỒN DUY NHẤT dùng bởi cả
   * danh sách lịch trình (withEstimatedListCosts) và Sổ chi tiêu
   * (IncurredCostsService.computeCostBreakdown). Trước đây danh sách lịch
   * trình tự tính riêng bằng itineraries.estimated_cost (thực ra là NGÂN
   * SÁCH người dùng nhập — "mức có thể chi trả", không phải chi phí ước
   * tính thật), khiến 2 màn hiện 2 con số khác hẳn nhau cho cùng 1 lịch
   * trình. Trẻ em: ăn uống/lưu trú nhân childPriceRatio, xăng xe DÙNG CHUNG
   * 1 mức với người lớn (chia theo đầu người thật, không phải theo giá vé).
   *
   * [roundedGroupTotal] là số NÊN HIỂN THỊ ra UI (đã gồm 10% dự trù, làm
   * tròn từng người đến hàng trăm nghìn rồi mới nhân số người — quy ước
   * dùng chung toàn hệ thống, xem IncurredCostsService.computeCostBreakdown).
   * [estimatedCostForGroup] (chưa dự trù) chỉ để tham chiếu/so sánh.
   */
  async computeGroupEstimatedCost(
    itineraryId: string,
    adultCount: number,
    childCount: number,
  ): Promise<{
    estimatedCostForGroup: number;
    estimatedCostPerAdult: number;
    estimatedCostPerChild: number;
    roundedGroupTotal: number;
  }> {
    const breakdown = await this.getCachedCostBreakdown(itineraryId);
    const { childPriceRatio } = await this.tripCostConfig.getConfig();
    return this.deriveGroupEstimatedCost(
      breakdown,
      adultCount,
      childCount,
      childPriceRatio,
    );
  }

  /** Phần tính THUẦN (không I/O) của computeGroupEstimatedCost — tách riêng
   * để withEstimatedListCosts() có thể batch-fetch breakdown cho CẢ danh
   * sách bằng 1 query (getCachedCostBreakdownBatch) rồi gọi hàm này trong bộ
   * nhớ cho từng lịch trình, thay vì mỗi lịch trình tự query riêng. */
  private deriveGroupEstimatedCost(
    breakdown: {
      placeCost: number;
      hotelCost: number;
      transportCost: number;
      calculatedTripCost: number;
    },
    adultCount: number,
    childCount: number,
    childPriceRatio: number,
  ): {
    estimatedCostForGroup: number;
    estimatedCostPerAdult: number;
    estimatedCostPerChild: number;
    roundedGroupTotal: number;
  } {
    // calculatedTripCost ở đây là bản ĐÃ reserve/round (đọc thẳng từ
    // itinerary_cost_estimates.calculated_trip_cost) — dùng luôn làm
    // roundedCostPerAdult, không tính lại reserve/round cho người lớn nữa.
    const { calculatedTripCost: roundedCostPerAdult, placeCost, hotelCost, transportCost } =
      breakdown;
    const participantCount = Math.max(1, adultCount + childCount);
    // Bản RAW (chưa reserve) chỉ dùng cho estimatedCostForGroup/estimatedCostPerAdult
    // (số tham chiếu, không hiển thị chính).
    const rawCalculatedTripCost = this.perAdultTripTotal(
      placeCost,
      hotelCost,
      transportCost,
      participantCount,
    );
    const transportPerAdult =
      Math.round(transportCost / participantCount / 1000) * 1000;
    const childBaseCost =
      placeCost * childPriceRatio + hotelCost * childPriceRatio + transportPerAdult;

    const reserveRate = 0.1;
    const roundedCostPerChild =
      childCount > 0
        ? Math.round((childBaseCost * (1 + reserveRate)) / 100000) * 100000
        : 0;

    return {
      estimatedCostForGroup: Math.round(
        rawCalculatedTripCost * adultCount + childBaseCost * childCount,
      ),
      estimatedCostPerAdult: Math.round(rawCalculatedTripCost),
      estimatedCostPerChild: Math.round(childBaseCost),
      roundedGroupTotal:
        roundedCostPerAdult * adultCount + roundedCostPerChild * childCount,
    };
  }

  /** Batch-fetch itinerary_cost_estimates cho CẢ danh sách bằng 1 query duy
   * nhất (WHERE itinerary_id IN (...)) — thay vì gọi getCachedCostBreakdown()
   * riêng cho từng lịch trình (N query, dù chạy song song vẫn là N round-trip
   * mạng). Lịch trình nào chưa có dòng cache (hiếm, tạo trước khi có bảng
   * này) mới backfill riêng, không kéo cả danh sách xuống N query như cũ. */
  private async getCachedCostBreakdownBatch(
    itineraryIds: string[],
  ): Promise<
    Map<
      string,
      {
        placeCost: number;
        hotelCost: number;
        transportCost: number;
        calculatedTripCost: number;
      }
    >
  > {
    const result = new Map<
      string,
      {
        placeCost: number;
        hotelCost: number;
        transportCost: number;
        calculatedTripCost: number;
      }
    >();
    if (itineraryIds.length === 0) return result;

    const { data, error } = await supabase
      .schema('travel')
      .from('itinerary_cost_estimates')
      .select(
        'itinerary_id, place_cost, hotel_cost, transport_cost, calculated_trip_cost',
      )
      .in('itinerary_id', itineraryIds);
    if (error) {
      this.logger.warn(
        `Cannot batch-read itinerary_cost_estimates: ${error.message}`,
      );
    }
    for (const row of data ?? []) {
      result.set((row as any).itinerary_id, {
        placeCost: Number((row as any).place_cost ?? 0),
        hotelCost: Number((row as any).hotel_cost ?? 0),
        transportCost: Number((row as any).transport_cost ?? 0),
        calculatedTripCost: Number((row as any).calculated_trip_cost ?? 0),
      });
    }

    const missingIds = itineraryIds.filter((id) => !result.has(id));
    if (missingIds.length > 0) {
      await Promise.all(
        missingIds.map(async (id) => {
          try {
            result.set(id, await this.recomputeCostEstimate(id));
          } catch (err: any) {
            this.logger.warn(
              `Cannot backfill itinerary_cost_estimates for ${id}: ${err?.message ?? err}`,
            );
          }
        }),
      );
    }
    return result;
  }

  private formatDuration(totalMinutes: number): string {
    if (!totalMinutes || totalMinutes <= 0) return '0 phút';
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `${hours} giờ ${minutes} phút`;
    if (hours > 0) return `${hours} giờ`;
    return `${minutes} phút`;
  }

  private roundTravelMinutes(value: unknown): number {
    const minutes = Number(value ?? 0);
    if (!Number.isFinite(minutes) || minutes <= 0) return 0;
    return Math.ceil(minutes / 5) * 5;
  }

  private addMinutesToTime(
    time: string | null | undefined,
    minutes: number,
  ): string | null {
    if (!time) return null;
    const parts = time.split(':').map(Number);
    if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) {
      return null;
    }
    const total = parts[0] * 60 + parts[1] + Math.max(0, minutes);
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(
      total % 60,
    ).padStart(2, '0')}`;
  }

  private minutesBetween(
    from: string | null | undefined,
    to: string | null | undefined,
  ): number {
    if (!from || !to) return 0;
    const fromParts = from.split(':').map(Number);
    const toParts = to.split(':').map(Number);
    if (
      fromParts.length < 2 ||
      toParts.length < 2 ||
      [...fromParts, ...toParts].some((value) => !Number.isFinite(value))
    ) {
      return 0;
    }
    return Math.max(
      0,
      toParts[0] * 60 + toParts[1] - (fromParts[0] * 60 + fromParts[1]),
    );
  }

  /** Trả về true nếu có ít nhất 1 chặng vừa được tính + ghi lại vào
   * itinerary_details (trước đó thiếu/0) — gọi nơi dùng phải tự recompute lại
   * itinerary_cost_estimates nếu true, nếu không cache sẽ giữ số CŨ (tính lúc
   * còn thiếu dữ liệu, thường do Goong rate-limit) trong khi các nơi đọc trực
   * tiếp itinerary_details (vd chi phí từng ngày) đã thấy số MỚI — lệch nhau. */
  private async hydrateMissingTravelSnapshots(
    details: any[],
    travelMode?: string | null,
    headcount = 1,
  ): Promise<boolean> {
    if (!Array.isArray(details) || details.length === 0) return false;

    const hotel = details.find((detail) => this.isStartPointDetail(detail));
    const activitiesByDate = new Map<string, any[]>();
    for (const detail of details) {
      if (this.isStartPointDetail(detail) || !detail.visit_date) continue;
      const rows = activitiesByDate.get(detail.visit_date) ?? [];
      rows.push(detail);
      activitiesByDate.set(detail.visit_date, rows);
    }

    const legs: Array<{ originId: string; destination: any }> = [];
    for (const rows of activitiesByDate.values()) {
      rows.sort(
        (left, right) =>
          Number(left.sequence_order ?? 0) - Number(right.sequence_order ?? 0),
      );
      let previousPlaceId = hotel?.place_id;
      for (const destination of rows) {
        if (
          previousPlaceId &&
          destination.place_id &&
          previousPlaceId !== destination.place_id &&
          (Number(destination.travel_distance_km ?? 0) <= 0 ||
            Number(destination.travel_minutes ?? 0) <= 0)
        ) {
          legs.push({ originId: previousPlaceId, destination });
        }
        previousPlaceId = destination.place_id;
      }
    }

    if (legs.length === 0) return false;

    const originIds = [...new Set(legs.map((leg) => leg.originId))];
    const destinationIds = [
      ...new Set(legs.map((leg) => leg.destination.place_id)),
    ];

    const matrixMode = this.normalizeMatrixTravelMode(travelMode);
    let anyChanged = false;
    try {
      const { data, error } = await supabase
        .schema('travel')
        .from('distance_matrix')
        .select(
          'origin_place_id, destination_place_id, distance_meters, duration_seconds',
        )
        .eq('travel_mode', matrixMode)
        .in('origin_place_id', originIds)
        .in('destination_place_id', destinationIds);

      if (error) {
        this.logger.warn(
          `Distance matrix fallback unavailable: ${error.message}`,
        );
        return false;
      }

      const matrix = new Map<string, any>(
        (data ?? []).map((row: any) => [
          `${row.origin_place_id}:${row.destination_place_id}`,
          row,
        ]),
      );
      const missingLegs = legs.filter(
        (leg) => !matrix.has(`${leg.originId}:${leg.destination.place_id}`),
      );
      if (missingLegs.length > 0) {
        const goongRows = await this.fetchAndCacheGoongLegs(
          missingLegs,
          matrixMode,
        );
        for (const row of goongRows) {
          matrix.set(`${row.origin_place_id}:${row.destination_place_id}`, row);
        }
      }

      await Promise.all(
        legs.map(async (leg) => {
          const row = matrix.get(
            `${leg.originId}:${leg.destination.place_id}`,
          ) as any;
          if (!row) return;
          let changed = false;
          if (Number(leg.destination.travel_distance_km ?? 0) <= 0) {
            leg.destination.travel_distance_km =
              Number(row.distance_meters ?? 0) / 1000;
            changed = true;
          }
          if (Number(leg.destination.travel_minutes ?? 0) <= 0) {
            leg.destination.travel_minutes = this.roundTravelMinutes(
              Math.ceil(Number(row.duration_seconds ?? 0) / 60),
            );
            changed = true;
          }
          if (Number(leg.destination.transport_cost ?? 0) <= 0) {
            leg.destination.transport_cost =
              await this.estimateSelfDriveTransportCost(
                leg.destination.travel_distance_km,
                matrixMode === 'MOTORBIKE'
                  ? TransportMode.MOTORBIKE
                  : TransportMode.CAR,
                headcount,
              );
            changed = true;
          }
          // Persist snapshot lên chính dòng itinerary_details — để lần đọc
          // sau (bất kỳ hàm/user nào) không cần query distance_matrix lại.
          // Bị reset về null mỗi khi sửa cấu trúc lịch trình làm đổi thứ tự
          // chặng (xem resetTravelSnapshots()).
          if (changed && leg.destination.id) {
            const { error: persistError } = await supabase
              .schema('travel')
              .from('itinerary_details')
              .update({
                travel_distance_km: leg.destination.travel_distance_km,
                travel_minutes: leg.destination.travel_minutes,
                transport_cost: leg.destination.transport_cost,
              })
              .eq('id', leg.destination.id);
            if (persistError) {
              this.logger.warn(
                `Cannot persist travel snapshot for detail ${leg.destination.id}: ${persistError.message}`,
              );
            } else {
              anyChanged = true;
            }
          }
        }),
      );
    } catch (error) {
      this.logger.warn(`Distance matrix fallback failed: ${String(error)}`);
      return false;
    }
    return anyChanged;
  }

  private normalizeMatrixTravelMode(
    mode?: string | null,
  ): 'DRIVING' | 'MOTORBIKE' {
    return (mode ?? '').toUpperCase() === TransportMode.MOTORBIKE
      ? 'MOTORBIKE'
      : 'DRIVING';
  }

  // Số request Goong chạy song song tối đa cho các cặp THẬT SỰ mới (chưa ai
  // đang resolve). Goong rate-limit theo giây nên không thể để loop này chạy
  // không giới hạn khi 1 itinerary/candidate có hàng chục chặng mới cùng lúc.
  private static readonly GOONG_CONCURRENCY = 3;

  private async fetchAndCacheGoongLegs(
    legs: Array<{ originId: string; destination: any }>,
    travelMode: 'DRIVING' | 'MOTORBIKE',
  ): Promise<any[]> {
    if (legs.length === 0) return [];

    // Dedupe trong phạm vi 1 lệnh gọi — 1 itinerary có thể ghé lại cùng 1 cặp
    // điểm nhiều lần (đi rồi quay lại) nhưng chỉ cần tra/gọi Goong 1 lần.
    const uniqueLegs = new Map<string, { originId: string; destination: any }>();
    for (const leg of legs) {
      uniqueLegs.set(`${leg.originId}:${leg.destination.place_id}`, leg);
    }

    const placeIds = [
      ...new Set(
        [...uniqueLegs.values()].flatMap((leg) => [
          leg.originId,
          leg.destination.place_id,
        ]),
      ),
    ];
    const { data: places, error } = await supabase
      .schema('travel')
      .from('places')
      .select('id, latitude, longitude')
      .in('id', placeIds);
    if (error) {
      this.logger.warn(
        `Cannot load coordinates for Goong fallback: ${error.message}`,
      );
      return [];
    }

    const coordinates = new Map(
      (places ?? [])
        .filter(
          (place: any) =>
            Number.isFinite(Number(place.latitude)) &&
            Number.isFinite(Number(place.longitude)),
        )
        .map((place: any) => [
          place.id,
          `${Number(place.latitude)},${Number(place.longitude)}`,
        ]),
    );

    const entries = [...uniqueLegs.entries()].filter(([, leg]) =>
      coordinates.has(leg.originId) && coordinates.has(leg.destination.place_id),
    );

    // Mỗi cặp (origin, destination, mode) chỉ có TỐI ĐA 1 request Goong đang
    // bay trong toàn bộ process tại 1 thời điểm — request thứ 2 trở đi cho
    // cùng 1 cặp (đến từ itinerary khác, hoặc request đồng thời khác) sẽ chờ
    // và dùng chung kết quả thay vì tự gọi Goong riêng (chống cache-stampede).
    const resolved = await this.mapWithConcurrency(
      entries,
      ItineraryService.GOONG_CONCURRENCY,
      async ([key, leg]) => {
        const lockKey = `${key}:${travelMode}`;
        const pending = this.pendingGoongLegRequests.get(lockKey);
        if (pending) return pending;

        const promise = this.resolveSingleGoongLeg(leg, travelMode, coordinates).finally(
          () => this.pendingGoongLegRequests.delete(lockKey),
        );
        this.pendingGoongLegRequests.set(lockKey, promise);
        return promise;
      },
    );

    const rows = resolved.filter((row): row is any => row !== null);
    // Chỉ cache dòng đến TỪ Goong thật (source đường đi chính xác). Ước lượng
    // haversine chỉ dùng tạm cho response hiện tại — không ghi vào
    // distance_matrix, để lần đọc sau vẫn thử gọi Goong thật thay vì giữ mãi
    // 1 con số ước lượng kém chính xác.
    const goongRows = rows
      .filter((row) => row.source === 'GOONG')
      .map(({ source, ...row }) => row);
    if (goongRows.length > 0) {
      const { error: upsertError } = await supabase
        .schema('travel')
        .from('distance_matrix')
        .upsert(goongRows, {
          onConflict: 'origin_place_id,destination_place_id,travel_mode',
        });
      if (upsertError) {
        this.logger.warn(
          `Cannot cache Goong distance matrix: ${upsertError.message}`,
        );
      }
    }
    return rows;
  }

  private async resolveSingleGoongLeg(
    leg: { originId: string; destination: any },
    travelMode: 'DRIVING' | 'MOTORBIKE',
    coordinates: Map<string, string>,
  ): Promise<any | null> {
    const apiKey = process.env.GOONG_API_KEY?.trim();
    const origin = coordinates.get(leg.originId)!;
    const destination = coordinates.get(leg.destination.place_id)!;
    const vehicle = travelMode === 'MOTORBIKE' ? 'bike' : 'car';

    try {
      if (!apiKey) throw new Error('GOONG_API_KEY is not configured');
      const response = await axios.get(
        'https://rsapi.goong.io/v2/distancematrix',
        {
          params: {
            origins: origin,
            destinations: destination,
            vehicle,
            api_key: apiKey,
          },
          timeout: 10000,
        },
      );
      const element = response.data?.rows?.[0]?.elements?.[0];
      if (element?.status !== 'OK') {
        throw new Error(`Goong element status ${element?.status ?? 'unknown'}`);
      }
      return {
        origin_place_id: leg.originId,
        destination_place_id: leg.destination.place_id,
        travel_mode: travelMode,
        distance_meters: Math.max(
          0,
          Math.round(Number(element.distance?.value ?? 0)),
        ),
        duration_seconds: Math.max(
          0,
          Math.round(Number(element.duration?.value ?? 0)),
        ),
        source: 'GOONG',
        updated_at: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.warn(
        `Goong fallback failed for ${leg.originId} -> ${leg.destination.place_id}: ${String(error)}`,
      );
      // Vẫn cache lại ước lượng đường chim bay (đánh dấu source=HAVERSINE) —
      // nếu không cache, cặp này sẽ mãi bị coi là "thiếu" và gọi lại Goong ở
      // MỌI lần đọc sau, kể cả khi Goong đang bị rate-limit (429) ngay lúc đó.
      const [originLat, originLng] = origin.split(',').map(Number);
      const [destinationLat, destinationLng] = destination
        .split(',')
        .map(Number);
      const distanceKm = this.haversineDistanceKm(
        originLat,
        originLng,
        destinationLat,
        destinationLng,
      );
      return {
        origin_place_id: leg.originId,
        destination_place_id: leg.destination.place_id,
        travel_mode: travelMode,
        distance_meters: Math.round(distanceKm * 1000),
        duration_seconds: Math.max(60, Math.ceil((distanceKm / 30) * 3600)),
        source: 'HAVERSINE',
        updated_at: new Date().toISOString(),
      };
    }
  }

  private haversineDistanceKm(
    latitude1: number,
    longitude1: number,
    latitude2: number,
    longitude2: number,
  ): number {
    const toRadians = (value: number) => (value * Math.PI) / 180;
    const deltaLatitude = toRadians(latitude2 - latitude1);
    const deltaLongitude = toRadians(longitude2 - longitude1);
    const a =
      Math.sin(deltaLatitude / 2) ** 2 +
      Math.cos(toRadians(latitude1)) *
        Math.cos(toRadians(latitude2)) *
        Math.sin(deltaLongitude / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  private isAccommodationCategory(category?: string | null): boolean {
    const normalized = (category ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    return (
      normalized.includes('luu tru') ||
      normalized.includes('khach san') ||
      normalized.includes('hotel') ||
      normalized.includes('accommodation')
    );
  }

  private isStartPointDetail(detail: any): boolean {
    return (
      detail?.detail_type === 'HOTEL' ||
      ((detail?.sequence_order ?? null) === 0 &&
        (detail?.duration_minutes ?? 0) === 0)
    );
  }
  /** Cộng thêm N ngày vào chuỗi ngày 'YYYY-MM-DD', trả về chuỗi mới */
  private addDays(dateStr: string, days: number): string {
    const d = new Date(dateStr);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split('T')[0];
  }

}
