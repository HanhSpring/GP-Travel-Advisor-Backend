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

export interface ItineraryPlanPayload {
  places: Array<{
    id: string;
    name: string;
    longitude: number;
    latitude: number;
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
  }>;
  num_days: number;
  daily_start_time: string;
  daily_end_time: string;
  selected_hotel_id?: string | null;
  return_to_hotel?: boolean;
  use_goong?: boolean;
  travel_vehicle?: string;
  population_size?: number;
  generations?: number;
  mutation_rate?: number;
  seed?: number;
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
      const response: { data: { embedding: number[]; dim: number } } = await firstValueFrom(
        this.http.post<{ embedding: number[]; dim: number }>(url, payload),
      );
      return response.data.embedding;
    } catch (error) {
      const msg = error?.response?.data?.detail ?? error?.message ?? 'unknown';
      this.logger.error(`encodeQuery failed: ${msg}`);
      throw new Error(`AI Service is unavailable: ${msg}`);
    }
  }

  async planItinerary(payload: ItineraryPlanPayload): Promise<unknown> {
    const url = `${this.aiServiceUrl}/itinerary/plan`;
    try {
      const response: { data: unknown } = await firstValueFrom(
        this.http.post<unknown>(url, payload),
      );
      return response.data;
    } catch (error) {
      const msg = error?.response?.data?.detail ?? error?.message ?? 'unknown';
      this.logger.error(`planItinerary failed: ${msg}`);
      throw new Error(`AI Service is unavailable: ${msg}`);
    }
  }
}
