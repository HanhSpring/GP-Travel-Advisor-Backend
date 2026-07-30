import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { supabase } from '../../../config/supabase';
import {
  PipelineHistoryQueryDto,
  PipelineHistoryItemDto,
  PipelineHistoryResponseDto,
  PipelineRunRequestDto,
  PipelineRunResponseDto,
  ReviewFilterScheduleDto,
  RecommenderRetrainRunDto,
  RecommenderRetrainStatusDto,
  ReviewFilterScheduleFrequency,
  UpdateReviewFilterScheduleDto,
} from './dto/pipeline-run.dto';
import { AdminAlgorithmSettingsService } from '../algorithm-settings/admin-algorithm-settings.service';

const REVIEW_FILTER_ALGORITHM_NAME = 'review_filter';
const RECOMMENDER_RETRAIN_ALGORITHM_NAME = 'recommender_retrain';

type AlgorithmRow = {
  id: string;
  name: string;
};

type AlgorithmLogRow = {
  id: string;
  algorithm_id: string | null;
  admin_id: string | null;
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

  async runPipeline(
    dto: PipelineRunRequestDto,
    adminId: string | null = null,
    triggerType: 'manual' | 'scheduled' = 'manual',
  ): Promise<PipelineRunResponseDto> {
    this.logger.log('Kich hoat pipeline phan loai review...');
    let requestPayload: Record<string, any> = dto;
    try {
      const settings =
        await this.algorithmSettingsService.getReviewFilterSettings();
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
      await this.insertPipelineLog('active', response.data, requestPayload, adminId);
      if (triggerType === 'manual') {
        const completedAt = new Date(response.data.completed_at).getTime();
        await this.markScheduleLastRun(
          Number.isFinite(completedAt) ? completedAt : Date.now(),
        );
      }
      return response.data;
    } catch (error) {
      this.logger.error(`Pipeline run failed: ${error.message}`);
      await this.insertPipelineLog('failed', null, requestPayload, adminId, error);
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

  async getPipelineHistory(
    query: PipelineHistoryQueryDto | number = {},
  ): Promise<PipelineHistoryResponseDto> {
    const normalizedQuery =
      typeof query === 'number' ? { limit: query } : query;
    const safePageSize = Math.min(
      Math.max(normalizedQuery.pageSize ?? normalizedQuery.limit ?? 10, 1),
      100,
    );
    const safePage = Math.max(normalizedQuery.page ?? 1, 1);
    const from = (safePage - 1) * safePageSize;
    const to = from + safePageSize - 1;
    try {
      let algorithmId: string | null | undefined;
      if (normalizedQuery.algorithm) {
        algorithmId = await this.findAlgorithmIdByName(
          normalizedQuery.algorithm,
        );
        if (algorithmId === '') {
          return {
            history: [],
            total: 0,
            page: safePage,
            pageSize: safePageSize,
            totalPages: 0,
          };
        }
      }

      let request = supabase
        .schema('ai_config')
        .from('algorithm_logs')
        .select('id,algorithm_id,admin_id,status,action,details,created_at', {
          count: 'exact',
        })
        .order('created_at', { ascending: false });

      if (algorithmId) {
        request = request.eq('algorithm_id', algorithmId);
      }

      const dateRange = this.localDateToUtcRange(normalizedQuery.date);
      if (dateRange) {
        request = request
          .gte('created_at', dateRange.start)
          .lt('created_at', dateRange.end);
      }

      const { data, error, count } = await request.range(from, to);

      if (error) {
        throw error;
      }

      const rows = (data ?? []) as AlgorithmLogRow[];
      const algorithmMap = await this.loadAlgorithmMap(
        rows
          .map((row) => row.algorithm_id)
          .filter((id): id is string => Boolean(id)),
      );
      const adminMap = await this.loadAdminMap(
        rows.map((row) => row.admin_id).filter((id): id is string => Boolean(id)),
      );

      const total = count ?? rows.length;

      return {
        history: rows.map((row) => this.toHistoryItem(row, algorithmMap, adminMap)),
        total,
        page: safePage,
        pageSize: safePageSize,
        totalPages: Math.ceil(total / safePageSize),
      };
    } catch (error) {
      this.logger.warn(`Không lấy được lịch sử pipeline: ${error.message}`);
      return {
        history: [],
        total: 0,
        page: safePage,
        pageSize: safePageSize,
        totalPages: 0,
      };
    }
  }

  async getReviewFilterSchedule(): Promise<ReviewFilterScheduleDto> {
    const algorithm = await this.ensureReviewFilterAlgorithm();
    const schedule = await this.ensureScheduleRow(algorithm.id);
    return this.buildScheduleResponse(schedule);
  }

  async updateReviewFilterSchedule(
    dto: UpdateReviewFilterScheduleDto,
    adminId: string | null = null,
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

      this.throwIfSupabaseError(
        error,
        'Could not update review filter schedule',
      );
      const updated = data as ScheduleRow;
      await this.insertScheduleLog(algorithm.id, current, updated, adminId);
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
      await this.runPipeline(
        {
          dry_run: false,
          triggered_by: 'schedule',
        } as PipelineRunRequestDto,
        null,
        'scheduled',
      );
    } finally {
      await this.markScheduleLastRun(due.getTime());
    }
  }

  async startRecommenderRetrain(
    triggeredBy: string | null,
    triggerType: 'manual' | 'scheduled',
  ): Promise<RecommenderRetrainStatusDto> {
    const algorithm = await this.ensureRecommenderAlgorithm();
    const { data, error } = await supabase
      .schema('ai_config')
      .rpc('create_recommender_training_run', {
        p_algorithm_id: algorithm.id,
        p_trigger_type: triggerType,
        p_triggered_by: triggeredBy,
        // RPC mới bỏ quota nhưng vẫn giữ tham số để tương thích. Dùng max int thay
        // vì 0 để cả function DB bản cũ (còn kiểm tra count >= p_max_runs) cũng hoạt động.
        p_max_runs: 2_147_483_647,
      });

    if (error) {
      const detail = error.message || String(error);
      if (detail.includes('RETRAIN_ALREADY_RUNNING')) {
        throw new ConflictException('Đang có một retrain job chạy');
      }
      throw new InternalServerErrorException(`Không thể tạo retrain job: ${detail}`);
    }

    const row = (Array.isArray(data) ? data[0] : data) as any;
    try {
      await firstValueFrom(
        this.httpService.post(
          `${this.aiServiceUrl}/api/v1/retrain/runs`,
          {
            run_id: row.id,
            force: triggerType === 'manual',
            trigger_type: triggerType,
          },
          { timeout: 15_000 },
        ),
      );
      await this.insertRecommenderLog(algorithm.id, 'active', {
        requestedAction: 'recommender_retrain_started',
        run_id: row.id,
        trigger_type: triggerType,
      }, triggeredBy);
    } catch (startError: any) {
      await supabase
        .schema('ai_config')
        .from('training_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message:
            startError?.response?.data?.detail ?? startError?.message ?? 'AI service rejected retrain',
        })
        .eq('id', row.id);
      throw new InternalServerErrorException(
        'Không thể khởi động retrain trên AI service',
      );
    }
    return this.getRecommenderRetrainStatus();
  }

  async getRecommenderRetrainStatus(): Promise<RecommenderRetrainStatusDto> {
    const algorithm = await this.ensureRecommenderAlgorithm();
    const { data: rows, error } = await supabase
      .schema('ai_config')
      .from('training_runs')
      .select('*')
      .eq('algorithm_id', algorithm.id)
      .order('created_at', { ascending: false })
      .limit(10);
    this.throwIfSupabaseError(error, 'Could not load recommender retrain status');
    const mapped = (rows ?? []).map((row: any) => this.toRetrainRun(row));
    return {
      currentRun:
        mapped.find((run) => ['pending', 'running'].includes(run.status)) ?? null,
      latestRun: mapped[0] ?? null,
    };
  }

  async getRecommenderRetrainRun(id: string): Promise<RecommenderRetrainRunDto> {
    const algorithm = await this.ensureRecommenderAlgorithm();
    const { data, error } = await supabase
      .schema('ai_config')
      .from('training_runs')
      .select('*')
      .eq('id', id)
      .eq('algorithm_id', algorithm.id)
      .maybeSingle();
    this.throwIfSupabaseError(error, 'Could not load recommender retrain run');
    if (!data) {
      throw new NotFoundException('Không tìm thấy retrain run');
    }
    return this.toRetrainRun(data);
  }

  async getRecommenderRetrainSchedule(): Promise<ReviewFilterScheduleDto> {
    const algorithm = await this.ensureRecommenderAlgorithm();
    return this.buildScheduleResponse(await this.ensureScheduleRow(algorithm.id));
  }

  async updateRecommenderRetrainSchedule(
    dto: UpdateReviewFilterScheduleDto,
    adminId: string | null = null,
  ): Promise<ReviewFilterScheduleDto> {
    const algorithm = await this.ensureRecommenderAlgorithm();
    const current = await this.ensureScheduleRow(algorithm.id);
    const updates: Partial<ScheduleRow> = {};
    if (typeof dto.autoEnabled === 'boolean') updates.is_enabled = dto.autoEnabled;
    if (dto.frequency) updates.frequency = dto.frequency;
    if (dto.runTime !== undefined) updates.run_time = this.normalizeRunTime(dto.runTime);
    if (dto.runDay !== undefined) updates.run_day = Number(dto.runDay);
    const frequency = updates.frequency ?? current.frequency;
    this.validateScheduleDay(frequency, updates.run_day ?? current.run_day ?? 1);
    if (!Object.keys(updates).length) return this.buildScheduleResponse(current);
    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithm_schedules')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('algorithm_id', algorithm.id)
      .select('*')
      .single();
    this.throwIfSupabaseError(error, 'Could not update recommender retrain schedule');
    await this.insertScheduleLog(algorithm.id, current, data as ScheduleRow, adminId);
    return this.buildScheduleResponse(data as ScheduleRow);
  }

  async runRecommenderRetrainIfDue(): Promise<void> {
    const algorithm = await this.ensureRecommenderAlgorithm();
    const schedule = this.buildScheduleResponse(await this.ensureScheduleRow(algorithm.id));
    if (!schedule.autoEnabled) return;
    const due = this.getDueScheduleTime(schedule);
    if (!due) return;
    try {
      await this.startRecommenderRetrain(null, 'scheduled');
    } catch (error: any) {
      if (!(error instanceof ConflictException)) throw error;
      this.logger.warn(`Scheduled recommender retrain skipped: ${error.message}`);
    } finally {
      await this.markScheduleLastRunForAlgorithm(algorithm.id, due.getTime());
    }
  }

  private toRetrainRun(row: any): RecommenderRetrainRunDto {
    return {
      id: row.id,
      status: row.status,
      triggerType: row.trigger_type,
      triggeredBy: row.triggered_by ?? null,
      startedAt: this.normalizeUtcTimestamp(row.started_at) || null,
      completedAt: this.normalizeUtcTimestamp(row.completed_at) || null,
      durationSeconds: row.duration_seconds ?? null,
      errorMessage: row.error_message ?? null,
      metrics: row.metrics ?? null,
      createdAt: this.normalizeUtcTimestamp(row.created_at),
    };
  }

  private async insertRecommenderLog(
    algorithmId: string,
    status: 'active' | 'failed',
    details: Record<string, any>,
    adminId: string | null = null,
  ): Promise<void> {
    const { error } = await supabase
      .schema('ai_config')
      .from('algorithm_logs')
      .insert({
        algorithm_id: algorithmId,
        admin_id: adminId,
        status,
        action: 'updated',
        details: JSON.stringify(details),
      });
    if (error) this.logger.warn(`Could not insert recommender log: ${error.message}`);
  }

  private async insertPipelineLog(
    status: 'active' | 'failed',
    result: PipelineRunResponseDto | null,
    request: Record<string, any>,
    adminId: string | null,
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
          admin_id: adminId,
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

  private async ensureRecommenderAlgorithm(): Promise<AlgorithmRow> {
    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithms')
      .select('id,name')
      .eq('name', RECOMMENDER_RETRAIN_ALGORITHM_NAME)
      .maybeSingle();
    if (error) throw error;
    if (data) return data as AlgorithmRow;
    const { data: inserted, error: insertError } = await supabase
      .schema('ai_config')
      .from('algorithms')
      .insert({
        name: RECOMMENDER_RETRAIN_ALGORITHM_NAME,
        description: 'Rating + activity-log recommender retraining pipeline',
        is_active: true,
      })
      .select('id,name')
      .single();
    if (insertError || !inserted) throw insertError;
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

    this.throwIfSupabaseError(
      insertError,
      'Could not seed review filter schedule',
    );
    return inserted as ScheduleRow;
  }

  private buildScheduleResponse(row: ScheduleRow): ReviewFilterScheduleDto {
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
    if (
      schedule.frequency === 'weekly' &&
      now.getDay() !== Number(schedule.runDay)
    ) {
      return null;
    }
    if (
      schedule.frequency === 'monthly' &&
      now.getDate() !== Number(schedule.runDay)
    ) {
      return null;
    }

    const lastRunAt = schedule.lastRunAt
      ? new Date(schedule.lastRunAt).getTime()
      : 0;
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

  private async markScheduleLastRunForAlgorithm(
    algorithmId: string,
    epochMs: number,
  ): Promise<void> {
    const { error } = await supabase
      .schema('ai_config')
      .from('algorithm_schedules')
      .update({
        last_run_at: new Date(epochMs).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('algorithm_id', algorithmId);
    this.throwIfSupabaseError(error, 'Could not update schedule last_run_at');
  }

  private async insertScheduleLog(
    algorithmId: string,
    before: ScheduleRow,
    after: ScheduleRow,
    adminId: string | null = null,
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
    add('Ngày chạy', String(before.run_day ?? 1), String(after.run_day ?? 1));

    if (!changes.length) {
      return;
    }

    const { error } = await supabase
      .schema('ai_config')
      .from('algorithm_logs')
      .insert({
        algorithm_id: algorithmId,
        admin_id: adminId,
        status: 'active',
        action: 'parameter_changed',
        details: JSON.stringify({
          requestedAction: 'review_filter_schedule_update',
          message: `Đã cập nhật lịch chạy tự động thuật toán lọc đánh giá. ${changes.join('; ')}`,
          changes,
        }),
      });

    this.throwIfSupabaseError(
      error,
      'Could not insert review filter schedule log',
    );
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

  private async loadAdminMap(adminIds: string[]): Promise<Map<string, string>> {
    const uniqueIds = Array.from(new Set(adminIds));
    if (!uniqueIds.length) {
      return new Map();
    }

    const { data, error } = await supabase
      .from('users')
      .select('id,full_name,email')
      .in('id', uniqueIds);

    if (error) {
      this.logger.warn(`Could not load admin names: ${error.message}`);
      return new Map();
    }

    return new Map(
      (data ?? []).map((user: any) => [
        user.id,
        user.full_name || user.email || user.id,
      ]),
    );
  }

  private async findAlgorithmIdByName(name: string): Promise<string | null> {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName === 'all') {
      return null;
    }

    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithms')
      .select('id,name')
      .eq('name', normalizedName)
      .maybeSingle();

    if (error) {
      this.logger.warn(
        `Could not load algorithm filter ${normalizedName}: ${error.message}`,
      );
      return null;
    }

    return data ? (data as AlgorithmRow).id : '';
  }

  private localDateToUtcRange(
    date: string | undefined,
  ): { start: string; end: string } | null {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return null;
    }

    const [year, month, day] = date.split('-').map(Number);
    const start = Date.UTC(year, month - 1, day) - 7 * 60 * 60 * 1000;
    const end = start + 24 * 60 * 60 * 1000;

    return {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    };
  }

  private normalizeUtcTimestamp(value: string | null | undefined): string {
    if (!value) {
      return '';
    }
    if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(value)) {
      return value;
    }
    return `${value}Z`;
  }

  private toHistoryItem(
    row: AlgorithmLogRow,
    algorithmMap: Map<string, AlgorithmRow>,
    adminMap: Map<string, string>,
  ): PipelineHistoryItemDto {
    const details = this.parseDetails(row.details);
    const success = row.status !== 'failed';
    const createdAt = this.normalizeUtcTimestamp(row.created_at);

    return {
      run_id: this.detailString(details, 'run_id') || row.id,
      algorithm_id: row.algorithm_id,
      algorithm_name:
        (row.algorithm_id && algorithmMap.get(row.algorithm_id)?.name) ||
        'unknown',
      admin_id: row.admin_id,
      admin_name: (row.admin_id && adminMap.get(row.admin_id)) || null,
      status: row.status,
      action: row.action,
      details,
      started_at: this.detailString(details, 'started_at') || createdAt,
      completed_at:
        this.detailString(details, 'completed_at') || createdAt,
      total_reviews: this.detailNumber(details, 'total_reviews'),
      contents_processed: this.detailNumber(details, 'contents_processed'),
      conflicts_detected: this.detailNumber(details, 'conflicts_detected'),
      long_term_summaries: this.detailNumber(details, 'long_term_summaries'),
      duration_seconds: this.detailNumber(details, 'duration_seconds'),
      success,
      error: this.detailString(details, 'error') || null,
      created_at: createdAt,
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
