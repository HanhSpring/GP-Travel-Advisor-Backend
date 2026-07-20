import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

export interface EncodeQueryPayload {
  user_id: string;
  city: string;
  trip_intent: string;
  intent_vibe: string;
  history_types: string[];
  history_vibes: string[];
  history_biz: string[];
}

export interface SessionRerankCandidate {
  place_id: string;
  place_name: string;
  address: string | null;
  image_url: string | null;
  category: string;
  cosine_score: number;
  average_rating?: number | null;
  is_top20_visited?: boolean;
}

export interface SessionRerankedCandidate extends SessionRerankCandidate {
  predict_ranking?: number | null;
  historical_cf_score?: number;
  session_score?: number;
  popularity_score?: number;
  is_cold_start?: boolean;
}

export interface ItineraryPlaceCandidate {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  district_old?: string | null;
  place_type?: string;
  slot_type?: string;
  category?: string;
  source?: string;
  type_id?: string;
  type_name?: string;
  category_id?: string | null;
  category_name?: string | null;
  open_hour?: string | null;
  open_hour_compressed?: string | null;
  visit_duration?: number | null;
  average_rating?: number | null;
  review_count?: number | null;
  retrieval_score?: number | null;
  candidate_rank?: number | null;
  candidate_total?: number | null;
  estimated_cost?: number | null;
  price_min?: number | null;
  price_max?: number | null;
  price_basis?: string | null;
  price_inferred?: boolean | null;
  best_time?: 'MORNING' | 'AFTERNOON' | 'NIGHT' | 'ALL_DAY' | null;
  best_time_source?: string | null;
  planner_source?: string | null;
}

export interface ItineraryPlanPayload {
  places: ItineraryPlaceCandidate[];
  // Pool nhà hàng dự phòng quanh điểm đến, KHÔNG lọc theo sở thích/two-tower
  // — ai-service chỉ dùng khi 1 ngày sau khi cluster địa lý bị thiếu ứng
  // viên nhà hàng (xem SchedulerV2Planner._ensure_restaurant_coverage()).
  fallback_restaurants?: ItineraryPlaceCandidate[];
  num_days: number;
  daily_start_time: string;
  daily_end_time: string;
  trip_start_date?: string | null;
  adult_count?: number;
  child_count?: number;
  trip_budget_total?: number;
  selected_hotel_id?: string | null;
  hotel_total_cost?: number;
  return_to_hotel?: boolean;
  use_goong?: boolean;
  require_goong?: boolean;
  travel_vehicle?: string;
  population_size?: number;
  generations?: number;
  mutation_rate?: number;
  seed?: number;
  planner_engine?: 'scheduler_v2' | 'ga_v1';
  region_day_allocations?: Array<{ place_ids: string[]; days: number }>;
}

export interface RegionDetectionPayload {
  places: ItineraryPlanPayload['places'];
  num_days: number;
  daily_start_time: string;
  daily_end_time: string;
}

export interface RegionDetectionResult {
  regions: Array<{
    region_name: string;
    place_ids: string[];
    place_names: string[];
    max_days: number;
    total_visit_minutes: number;
    travel_minutes_from_central: number;
    is_remote: boolean;
    suggested_days: number;
    centroid_lat: number | null;
    centroid_lng: number | null;
    // Đường viền vùng (convex hull đã nới rộng nhẹ quanh centroid) — mảng
    // các cặp [lat, lng] theo thứ tự vẽ polygon; null nếu vùng có < 3 điểm
    // phân biệt (không đủ để tính hull).
    boundary: Array<[number, number]> | null;
  }>;
  estimated_total_days: number;
  num_days: number;
  shortfall_days: number;
}

@Injectable()
export class MlClientService {
  private readonly logger = new Logger(MlClientService.name);
  private readonly aiServiceUrl: string;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.aiServiceUrl = this.config.get<string>(
      'AI_SERVICE_URL',
      'http://localhost:8000',
    );
  }

  async encodeQuery(payload: EncodeQueryPayload): Promise<number[]> {
    const url = `${this.aiServiceUrl}/recommend/encode-query`;
    try {
      const response: { data: { embedding: number[]; dim: number } } =
        await firstValueFrom(
          this.http.post<{ embedding: number[]; dim: number }>(url, payload, {
            timeout: 120_000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            headers: { Connection: 'close' },
          }),
        );
      return response.data.embedding;
    } catch (error) {
      const msg = error?.response?.data?.detail ?? error?.message ?? 'unknown';
      this.logger.error(`encodeQuery failed: ${msg}`);
      throw new Error(`Itinerary planning failed: ${msg}`);
    }
  }

  /**
   * Session-Aware CF rerank — gọi SAU diversifyTopK, TRƯỚC khi map response DTO.
   * Graceful degrade: lỗi/timeout → trả nguyên candidates gốc, không throw,
   * để NestJS luôn giữ được thứ tự Two-Tower nếu ai-service không sẵn sàng.
   */
  async sessionRerank(
    userId: string,
    candidates: SessionRerankCandidate[],
  ): Promise<SessionRerankedCandidate[]> {
    const url = `${this.aiServiceUrl}/recommend/itinerary/session-rerank`;
    try {
      const response: { data: { candidates: SessionRerankedCandidate[] } } =
        await firstValueFrom(
          this.http.post<{ candidates: SessionRerankedCandidate[] }>(
            url,
            { user_id: userId, candidates },
            { timeout: 3000, headers: { Connection: 'close' } },
          ),
        );
      return response.data.candidates;
    } catch (error) {
      const msg = error?.response?.data?.detail ?? error?.message ?? 'unknown';
      this.logger.warn(
        `sessionRerank failed, giữ nguyên thứ tự Two-Tower: ${msg}`,
      );
      return candidates;
    }
  }

  async planItinerary(payload: ItineraryPlanPayload): Promise<unknown> {
    const url = `${this.aiServiceUrl}/itinerary/plan`;
    try {
      const response: { data: unknown } = await firstValueFrom(
        this.http.post<unknown>(url, payload, {
          timeout: 300_000,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          headers: { Connection: 'close' },
        }),
      );
      return response.data;
    } catch (error) {
      const msg = error?.response?.data?.detail ?? error?.message ?? 'unknown';
      this.logger.error(`planItinerary failed: ${msg}`);
      throw new Error(`AI Service is unavailable: ${msg}`);
    }
  }

  /** Region-allocation wizard, step 1: cheap macro-cluster detection — no
   * hotel selection, no travel matrix, no CP-SAT solving on the ai-service side. */
  async detectRegions(
    payload: RegionDetectionPayload,
  ): Promise<RegionDetectionResult> {
    const url = `${this.aiServiceUrl}/itinerary/detect-regions`;
    try {
      const response: { data: RegionDetectionResult } = await firstValueFrom(
        this.http.post<RegionDetectionResult>(url, payload, {
          timeout: 30_000,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          headers: { Connection: 'close' },
        }),
      );
      return response.data;
    } catch (error) {
      const msg = error?.response?.data?.detail ?? error?.message ?? 'unknown';
      this.logger.error(`detectRegions failed: ${msg}`);
      throw new Error(`AI Service is unavailable: ${msg}`);
    }
  }
}
