import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { supabase } from '../../../config/supabase';
import {
  PipelineHistoryItemDto,
  PipelineHistoryResponseDto,
  PipelineRunRequestDto,
  PipelineRunResponseDto,
} from './dto/pipeline-run.dto';
import { AdminAlgorithmSettingsService } from '../algorithm-settings/admin-algorithm-settings.service';

const REVIEW_FILTER_ALGORITHM_NAME = 'review_filter';

type AlgorithmRow = {
  id: string;
  name: string;
};

type AlgorithmLogRow = {
  id: string;
  algorithm_id: string | null;
  status: string;
  action: string;
  details: string | null;
  created_at: string;
};

@Injectable()
export class AdminAlgorithmPipelineService {
  private readonly logger = new Logger(AdminAlgorithmPipelineService.name);
  private readonly aiServiceUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly algorithmSettingsService: AdminAlgorithmSettingsService,
  ) {
    this.aiServiceUrl = this.normalizeAiServiceUrl(
      process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000',
    );
  }

  private normalizeAiServiceUrl(url: string): string {
    return url.trim().replace('://localhost:', '://127.0.0.1:');
  }

  async runPipeline(dto: PipelineRunRequestDto): Promise<PipelineRunResponseDto> {
    this.logger.log('Kich hoat pipeline phan loai review...');
    let requestPayload: Record<string, any> = dto;
    try {
      const settings = await this.algorithmSettingsService.getReviewFilterSettings();
      const settingsPayload =
        this.algorithmSettingsService.getReviewFilterPipelinePayload(settings);
      requestPayload = { ...dto, ...settingsPayload };

      const response = await firstValueFrom(
        this.httpService.post<PipelineRunResponseDto>(
          `${this.aiServiceUrl}/api/v1/review-pipeline/run`,
          requestPayload,
          { timeout: 600_000 },
        ),
      );
      await this.insertPipelineLog('active', response.data, requestPayload);
      return response.data;
    } catch (error) {
      this.logger.error(`Pipeline run failed: ${error.message}`);
      await this.insertPipelineLog('failed', null, requestPayload, error);
      if (error.response?.data) {
        throw new InternalServerErrorException(
          error.response.data.detail || 'Pipeline th?t b?i',
        );
      }
      throw new InternalServerErrorException(
        'Kh?ng th? k?t n?i ??n AI service. H?y ki?m tra ai-service ?ang ch?y.',
      );
    }
  }


  async getPipelineHistory(limit = 20): Promise<PipelineHistoryResponseDto> {
    const safeLimit = Math.min(Math.max(limit || 20, 1), 100);
    try {
      const { data, error, count } = await supabase
        .schema('ai_config')
        .from('algorithm_logs')
        .select('id,algorithm_id,status,action,details,created_at', {
          count: 'exact',
        })
        .order('created_at', { ascending: false })
        .limit(safeLimit);

      if (error) {
        throw error;
      }

      const rows = (data ?? []) as AlgorithmLogRow[];
      const algorithmMap = await this.loadAlgorithmMap(
        rows
          .map((row) => row.algorithm_id)
          .filter((id): id is string => Boolean(id)),
      );

      return {
        history: rows.map((row) => this.toHistoryItem(row, algorithmMap)),
        total: count ?? rows.length,
      };
    } catch (error) {
      this.logger.warn(`Không lấy được lịch sử pipeline: ${error.message}`);
      return { history: [], total: 0 };
    }
  }

  private async insertPipelineLog(
    status: 'active' | 'failed',
    result: PipelineRunResponseDto | null,
    request: Record<string, any>,
    error?: any,
  ): Promise<void> {
    try {
      const algorithm = await this.ensureReviewFilterAlgorithm();
      const details = result
        ? {
            requestedAction: 'run_pipeline',
            request,
            run_id: result.run_id,
            started_at: result.started_at,
            completed_at: result.completed_at,
            duration_seconds: result.duration_seconds,
            total_reviews: result.total_reviews,
            contents_processed: result.contents_processed,
            conflicts_detected: result.conflicts_detected,
            long_term_summaries: result.long_term_summaries,
            hidden_reviews: result.hidden_reviews,
            embedding_model_active: result.embedding_model_active,
            sentiment_model_active: result.sentiment_model_active,
            zeroshot_model_active: result.zeroshot_model_active,
            phobert_model_active: result.phobert_model_active,
            result_message: `Đã xử lý ${result.contents_processed}/${result.total_reviews} đánh giá đã duyệt đang chờ xử lý`,
          }
        : {
            requestedAction: 'run_pipeline',
            request,
            error:
              error?.response?.data?.detail ??
              error?.message ??
              'Pipeline run failed',
          };

      const { error: insertError } = await supabase
        .schema('ai_config')
        .from('algorithm_logs')
        .insert({
          algorithm_id: algorithm.id,
          status,
          action: 'updated',
          details: JSON.stringify(details),
        });

      if (insertError) {
        throw insertError;
      }
    } catch (logError: any) {
      this.logger.warn(`Could not insert pipeline log: ${logError.message}`);
    }
  }

  private async ensureReviewFilterAlgorithm(): Promise<AlgorithmRow> {
    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithms')
      .select('id,name')
      .eq('name', REVIEW_FILTER_ALGORITHM_NAME)
      .maybeSingle();

    if (error) {
      throw error;
    }
    if (data) {
      return data as AlgorithmRow;
    }

    const { data: inserted, error: insertError } = await supabase
      .schema('ai_config')
      .from('algorithms')
      .insert({
        name: REVIEW_FILTER_ALGORITHM_NAME,
        description: 'Review filtering and time-label classification pipeline',
        is_active: true,
      })
      .select('id,name')
      .single();

    if (insertError) {
      const { data: retry, error: retryError } = await supabase
        .schema('ai_config')
        .from('algorithms')
        .select('id,name')
        .eq('name', REVIEW_FILTER_ALGORITHM_NAME)
        .maybeSingle();

      if (retryError || !retry) {
        throw insertError;
      }
      return retry as AlgorithmRow;
    }

    return inserted as AlgorithmRow;
  }

  private async loadAlgorithmMap(
    algorithmIds: string[],
  ): Promise<Map<string, AlgorithmRow>> {
    const uniqueIds = Array.from(new Set(algorithmIds));
    if (!uniqueIds.length) {
      return new Map();
    }

    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithms')
      .select('id,name')
      .in('id', uniqueIds);

    if (error) {
      this.logger.warn(`Could not load algorithm names: ${error.message}`);
      return new Map();
    }

    return new Map(
      ((data ?? []) as AlgorithmRow[]).map((algorithm) => [
        algorithm.id,
        algorithm,
      ]),
    );
  }

  private toHistoryItem(
    row: AlgorithmLogRow,
    algorithmMap: Map<string, AlgorithmRow>,
  ): PipelineHistoryItemDto {
    const details = this.parseDetails(row.details);
    const success = row.status !== 'failed';

    return {
      run_id: this.detailString(details, 'run_id') || row.id,
      algorithm_id: row.algorithm_id,
      algorithm_name:
        (row.algorithm_id && algorithmMap.get(row.algorithm_id)?.name) ||
        'unknown',
      status: row.status,
      action: row.action,
      details,
      started_at: this.detailString(details, 'started_at') || row.created_at,
      completed_at:
        this.detailString(details, 'completed_at') || row.created_at,
      total_reviews: this.detailNumber(details, 'total_reviews'),
      contents_processed: this.detailNumber(details, 'contents_processed'),
      conflicts_detected: this.detailNumber(details, 'conflicts_detected'),
      long_term_summaries: this.detailNumber(details, 'long_term_summaries'),
      duration_seconds: this.detailNumber(details, 'duration_seconds'),
      success,
      error: this.detailString(details, 'error') || null,
      created_at: row.created_at,
    };
  }

  private parseDetails(details: string | null): Record<string, any> | null {
    if (!details) {
      return null;
    }
    try {
      const parsed = JSON.parse(details);
      return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
    } catch {
      return { value: details };
    }
  }

  private detailString(
    details: Record<string, any> | null,
    key: string,
  ): string | null {
    const value = details?.[key];
    return typeof value === 'string' ? value : null;
  }

  private detailNumber(
    details: Record<string, any> | null,
    key: string,
  ): number {
    const value = details?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
}
