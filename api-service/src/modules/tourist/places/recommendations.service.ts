import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface RecommendationItem {
  id: string;
  name?: string | null;
  city_name?: string | null;
  category_name?: string | null;
  type_name?: string | null;
  distance_km?: number | null;
  model_score: number;
  distance_score: number;
  final_score: number;
  rank: number;
  source: string;
}

interface RecommendationsResponse {
  place_id: string;
  count: number;
  items: RecommendationItem[];
}

/**
 * Client gọi AI Service (FastAPI) để lấy gợi ý "Có thể bạn sẽ thích".
 * Mọi lỗi/timeout đều nuốt và trả [] để PlacesService tự fallback (đồng địa điểm cùng city).
 */
@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);
  private readonly baseUrl =
    process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000';
  private readonly timeoutMs = Number(
    process.env.AI_SERVICE_TIMEOUT_MS || 2500,
  );

  constructor(private readonly http: HttpService) {}

  /** Trả về danh sách place id đã xếp hạng theo model (rỗng nếu AI service không sẵn sàng). */
  async getRecommendedPlaceIds(
    placeId: string,
    options: { userId?: number | null; k?: number } = {},
  ): Promise<RecommendationItem[]> {
    const { userId = null, k } = options;
    const url = `${this.baseUrl}/recommend/places/${encodeURIComponent(placeId)}/recommendations`;

    try {
      const response = await firstValueFrom(
        this.http.get<RecommendationsResponse>(url, {
          params: {
            ...(k != null ? { k } : {}),
            ...(userId != null ? { user_id: userId } : {}),
          },
          timeout: this.timeoutMs,
        }),
      );
      return response.data?.items ?? [];
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response
        ?.status;
      this.logger.warn(
        `AI Service không trả gợi ý cho place ${placeId} (status=${status ?? 'n/a'}): ${
          (error as Error).message
        }. Dùng fallback cùng thành phố.`,
      );
      return [];
    }
  }
}
