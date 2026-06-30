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
  ReviewFilterScheduleDto,
  ReviewFilterScheduleFrequency,
  UpdateReviewFilterScheduleDto,
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

type ScheduleRow = {
  id: string;
  algorithm_id: string;
  is_enabled: boolean;
  frequency: ReviewFilterScheduleFrequency;
  run_time: string;
  run_day: number | null;
  timezone: string | null;
  last_run_at: string | null;
  updated_at?: string | null;
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

  async getReviewFilterSchedule(): Promise<ReviewFilterScheduleDto> {
    const algorithm = await this.ensureReviewFilterAlgorithm();
    const schedule = await this.ensureScheduleRow(algorithm.id);
    return this.buildScheduleResponse(schedule);
  }

  async updateReviewFilterSchedule(
    dto: UpdateReviewFilterScheduleDto,
  ): Promise<ReviewFilterScheduleDto> {
    const algorithm = await this.ensureReviewFilterAlgorithm();
    const current = await this.ensureScheduleRow(algorithm.id);
    const updates: Partial<ScheduleRow> = {};

    if (typeof dto.autoEnabled === 'boolean') {
      updates.is_enabled = dto.autoEnabled;
    }
    if (dto.frequency) {
      updates.frequency = dto.frequency;
    }
    if (dto.runTime !== undefined) {
      updates.run_time = this.normalizeRunTime(dto.runTime);
    }
    if (dto.runDay !== undefined) {
      updates.run_day = Number(dto.runDay);
    }

    const nextFrequency = updates.frequency ?? current.frequency;
    const nextRunDay = updates.run_day ?? current.run_day ?? 1;
    this.validateScheduleDay(nextFrequency, nextRunDay);

    if (Object.keys(updates).length > 0) {
      const { data, error } = await supabase
        .schema('ai_config')
        .from('algorithm_schedules')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('algorithm_id', algorithm.id)
        .select('*')
        .single();

      this.throwIfSupabaseError(error, 'Could not update review filter schedule');
      const updated = data as ScheduleRow;
      await this.insertScheduleLog(algorithm.id, current, updated);
      return this.buildScheduleResponse(updated);
    }

    return this.buildScheduleResponse(current);
  }

  async runReviewFilterIfDue(): Promise<void> {
    const schedule = await this.getReviewFilterSchedule();
    if (!schedule.autoEnabled) {
      return;
    }

    const due = this.getDueScheduleTime(schedule);
    if (!due) {
      return;
    }

    this.logger.log(`Review filter auto schedule due at ${due.toISOString()}`);
    try {
      await this.runPipeline({ dry_run: false, triggered_by: 'schedule' } as PipelineRunRequestDto);
    } finally {
      await this.markScheduleLastRun(due.getTime());
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

  private async ensureScheduleRow(algorithmId: string): Promise<ScheduleRow> {
    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithm_schedules')
      .select('*')
      .eq('algorithm_id', algorithmId)
      .maybeSingle();

    this.throwIfSupabaseError(error, 'Could not load review filter schedule');
    if (data) {
      return data as ScheduleRow;
    }

    const { data: inserted, error: insertError } = await supabase
      .schema('ai_config')
      .from('algorithm_schedules')
      .insert({
        algorithm_id: algorithmId,
        is_enabled: false,
        frequency: 'daily',
        run_time: '02:00',
        run_day: 1,
        timezone: 'Asia/Ho_Chi_Minh',
      })
      .select('*')
      .single();

    this.throwIfSupabaseError(insertError, 'Could not seed review filter schedule');
    return inserted as ScheduleRow;
  }

  private buildScheduleResponse(
    row: ScheduleRow,
  ): ReviewFilterScheduleDto {
    return {
      autoEnabled: Boolean(row.is_enabled),
      frequency: row.frequency ?? 'daily',
      runTime: this.normalizeRunTime(row.run_time),
      runDay: String(row.run_day ?? 1),
      lastRunAt: row.last_run_at ?? null,
    };
  }

  private normalizeRunTime(runTime: string): string {
    const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(runTime);
    if (!match) {
      throw new InternalServerErrorException('Invalid run time format');
    }
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      throw new InternalServerErrorException('Invalid run time value');
    }
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  private validateScheduleDay(
    frequency: ReviewFilterScheduleFrequency,
    runDay: number,
  ): void {
    if (frequency === 'weekly' && (runDay < 0 || runDay > 6)) {
      throw new InternalServerErrorException('Weekly run day must be 0 - 6');
    }
    if (frequency === 'monthly' && (runDay < 1 || runDay > 28)) {
      throw new InternalServerErrorException('Monthly run day must be 1 - 28');
    }
  }

  private getDueScheduleTime(schedule: ReviewFilterScheduleDto): Date | null {
    const now = new Date();
    const [hours, minutes] = schedule.runTime.split(':').map(Number);
    const scheduled = new Date(now);
    scheduled.setHours(hours, minutes, 0, 0);

    if (now < scheduled) {
      return null;
    }
    if (schedule.frequency === 'weekly' && now.getDay() !== Number(schedule.runDay)) {
      return null;
    }
    if (schedule.frequency === 'monthly' && now.getDate() !== Number(schedule.runDay)) {
      return null;
    }

    const lastRunAt = schedule.lastRunAt ? new Date(schedule.lastRunAt).getTime() : 0;
    return lastRunAt >= scheduled.getTime() ? null : scheduled;
  }

  private async markScheduleLastRun(epochMs: number): Promise<void> {
    const algorithm = await this.ensureReviewFilterAlgorithm();
    const { error } = await supabase
      .schema('ai_config')
      .from('algorithm_schedules')
      .update({
        last_run_at: new Date(epochMs).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('algorithm_id', algorithm.id);

    this.throwIfSupabaseError(error, 'Could not update schedule last_run_at');
  }

  private async insertScheduleLog(
    algorithmId: string,
    before: ScheduleRow,
    after: ScheduleRow,
  ): Promise<void> {
    const changes: string[] = [];
    const add = (label: string, oldValue: string, newValue: string) => {
      if (oldValue !== newValue) {
        changes.push(`${label}: ${oldValue} → ${newValue}`);
      }
    };

    add(
      'Tự động',
      before.is_enabled ? 'Bật' : 'Tắt',
      after.is_enabled ? 'Bật' : 'Tắt',
    );
    add(
      'Định kỳ',
      this.frequencyLabel(before.frequency),
      this.frequencyLabel(after.frequency),
    );
    add(
      'Giờ chạy',
      this.normalizeRunTime(before.run_time),
      this.normalizeRunTime(after.run_time),
    );
    add(
      'Ngày chạy',
      String(before.run_day ?? 1),
      String(after.run_day ?? 1),
    );

    if (!changes.length) {
      return;
    }

    const { error } = await supabase
      .schema('ai_config')
      .from('algorithm_logs')
      .insert({
        algorithm_id: algorithmId,
        status: 'active',
        action: 'parameter_changed',
        details: JSON.stringify({
          requestedAction: 'review_filter_schedule_update',
          message: `Đã cập nhật lịch chạy tự động thuật toán lọc đánh giá. ${changes.join('; ')}`,
          changes,
        }),
      });

    this.throwIfSupabaseError(error, 'Could not insert review filter schedule log');
  }

  private frequencyLabel(frequency: ReviewFilterScheduleFrequency): string {
    if (frequency === 'weekly') {
      return 'Hàng tuần';
    }
    if (frequency === 'monthly') {
      return 'Hàng tháng';
    }
    return 'Hàng ngày';
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

  private throwIfSupabaseError(error: unknown, message: string): void {
    if (!error) {
      return;
    }
    const detail =
      typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error);
    this.logger.error(`${message}: ${detail}`);
    throw new InternalServerErrorException(message);
  }
}
