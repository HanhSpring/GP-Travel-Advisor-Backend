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
      const { data } = await firstValueFrom(
        this.http.post<{ embedding: number[]; dim: number }>(url, payload),
      );
      return data.embedding;
    } catch (error) {
      const msg = error?.response?.data?.detail ?? error?.message ?? 'unknown';
      this.logger.error(`encodeQuery failed: ${msg}`);
      throw new Error(`AI Service không khả dụng: ${msg}`);
    }
  }
}
