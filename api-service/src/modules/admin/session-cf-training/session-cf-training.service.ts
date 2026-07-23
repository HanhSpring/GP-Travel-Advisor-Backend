import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { supabase } from '../../../config/supabase';
import {
  SessionCfTrainingRunRequestDto,
  SessionCfTrainingRunResponseDto,
  SessionCfTrainingScheduleDto,
  SessionCfTrainingScheduleFrequency,
  UpdateSessionCfTrainingScheduleDto,
} from './dto/session-cf-training.dto';

// Tên thuật toán RIÊNG, khác hẳn 'session_cf_reranker' (dùng để tinh chỉnh trọng số rerank lúc
// serving, xem ai-service/app/services/session_cf_config_service.py) — module này chỉ quản lý
// việc TRIGGER TRAIN LẠI, không đụng tới trọng số đó.
const SESSION_CF_TRAINING_ALGORITHM_NAME = 'session_cf_training';

type AlgorithmRow = {
  id: string;
  name: string;
};

type ScheduleRow = {
  id: string;
  algorithm_id: string;
  is_enabled: boolean;
  frequency: SessionCfTrainingScheduleFrequency;
  run_time: string;
  run_day: number | null;
  timezone: string | null;
  last_run_at: string | null;
  updated_at?: string | null;
};

@Injectable()
export class SessionCfTrainingService {
  private readonly logger = new Logger(SessionCfTrainingService.name);
  private readonly aiServiceUrl: string;

  constructor(private readonly httpService: HttpService) {
    this.aiServiceUrl = this.normalizeAiServiceUrl(
      process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000',
    );
  }

  private normalizeAiServiceUrl(url: string): string {
    return url.trim().replace('://localhost:', '://127.0.0.1:');
  }

  async runTraining(
    dto: SessionCfTrainingRunRequestDto,
    adminId: string | null = null,
  ): Promise<SessionCfTrainingRunResponseDto> {
    this.logger.log('Kích hoạt train lại Session-Aware CF Reranker...');
    try {
      const response = await firstValueFrom(
        this.httpService.post<SessionCfTrainingRunResponseDto>(
          `${this.aiServiceUrl}/api/v1/session-cf-training/run`,
          dto,
          { timeout: 600_000 },
        ),
      );
      await this.insertTrainingLog('active', response.data, dto, adminId);
      return response.data;
    } catch (error) {
      this.logger.error(`Session-CF training failed: ${error.message}`);
      await this.insertTrainingLog('failed', null, dto, adminId, error);
      if (error.response?.data) {
        throw new InternalServerErrorException(
          error.response.data.detail || 'Train thất bại',
        );
      }
      throw new InternalServerErrorException(
        'Không thể kết nối đến AI service. Hãy kiểm tra ai-service đang chạy.',
      );
    }
  }

  async getSchedule(): Promise<SessionCfTrainingScheduleDto> {
    const algorithm = await this.ensureAlgorithm();
    const schedule = await this.ensureScheduleRow(algorithm.id);
    return this.buildScheduleResponse(schedule);
  }

  async updateSchedule(
    dto: UpdateSessionCfTrainingScheduleDto,
    adminId: string | null = null,
  ): Promise<SessionCfTrainingScheduleDto> {
    const algorithm = await this.ensureAlgorithm();
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
        'Could not update session-cf training schedule',
      );
      const updated = data as ScheduleRow;
      await this.insertScheduleLog(algorithm.id, current, updated, adminId);
      return this.buildScheduleResponse(updated);
    }

    return this.buildScheduleResponse(current);
  }

  /** Gọi mỗi phút bởi SessionCfTrainingScheduleCron — tự train nếu đến giờ và đang bật tự động. */
  async runIfDue(): Promise<void> {
    const schedule = await this.getSchedule();
    if (!schedule.autoEnabled) {
      return;
    }

    const due = this.getDueScheduleTime(schedule);
    if (!due) {
      return;
    }

    this.logger.log(
      `Session-CF training auto schedule due at ${due.toISOString()}`,
    );
    try {
      await this.runTraining({
        dry_run: false,
        upload_r2: true,
      } as SessionCfTrainingRunRequestDto);
    } finally {
      await this.markScheduleLastRun(due.getTime());
    }
  }

  private async insertTrainingLog(
    status: 'active' | 'failed',
    result: SessionCfTrainingRunResponseDto | null,
    request: Record<string, any>,
    adminId: string | null,
    error?: any,
  ): Promise<void> {
    try {
      const algorithm = await this.ensureAlgorithm();
      const details = result
        ? {
            requestedAction: 'run_session_cf_training',
            request,
            run_id: result.run_id,
            started_at: result.started_at,
            completed_at: result.completed_at,
            duration_seconds: result.duration_seconds,
            n_users: result.n_users,
            n_items: result.n_items,
            n_interactions: result.n_interactions,
            model_type: result.model_type,
            metrics: result.metrics,
            exported: result.exported,
            uploaded_r2: result.uploaded_r2,
            result_message: `Đã train lại với ${result.n_users} user, ${result.n_items} place (model=${result.model_type})`,
          }
        : {
            requestedAction: 'run_session_cf_training',
            request,
            error:
              error?.response?.data?.detail ??
              error?.message ??
              'Session-CF training failed',
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
      this.logger.warn(
        `Could not insert session-cf training log: ${logError.message}`,
      );
    }
  }

  private async ensureAlgorithm(): Promise<AlgorithmRow> {
    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithms')
      .select('id,name')
      .eq('name', SESSION_CF_TRAINING_ALGORITHM_NAME)
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
        name: SESSION_CF_TRAINING_ALGORITHM_NAME,
        description:
          'Train lại Funk-SVD (historical CF) cho Session-Aware CF Reranker — docs/create-data',
        is_active: true,
      })
      .select('id,name')
      .single();

    if (insertError) {
      const { data: retry, error: retryError } = await supabase
        .schema('ai_config')
        .from('algorithms')
        .select('id,name')
        .eq('name', SESSION_CF_TRAINING_ALGORITHM_NAME)
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

    this.throwIfSupabaseError(
      error,
      'Could not load session-cf training schedule',
    );
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
      'Could not seed session-cf training schedule',
    );
    return inserted as ScheduleRow;
  }

  private buildScheduleResponse(row: ScheduleRow): SessionCfTrainingScheduleDto {
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
    frequency: SessionCfTrainingScheduleFrequency,
    runDay: number,
  ): void {
    if (frequency === 'weekly' && (runDay < 0 || runDay > 6)) {
      throw new InternalServerErrorException('Weekly run day must be 0 - 6');
    }
    if (frequency === 'monthly' && (runDay < 1 || runDay > 28)) {
      throw new InternalServerErrorException('Monthly run day must be 1 - 28');
    }
  }

  private getDueScheduleTime(
    schedule: SessionCfTrainingScheduleDto,
  ): Date | null {
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
    const algorithm = await this.ensureAlgorithm();
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
          requestedAction: 'session_cf_training_schedule_update',
          message: `Đã cập nhật lịch chạy tự động train Session-CF. ${changes.join('; ')}`,
          changes,
        }),
      });

    this.throwIfSupabaseError(
      error,
      'Could not insert session-cf training schedule log',
    );
  }

  private frequencyLabel(frequency: SessionCfTrainingScheduleFrequency): string {
    if (frequency === 'weekly') {
      return 'Hàng tuần';
    }
    if (frequency === 'monthly') {
      return 'Hàng tháng';
    }
    return 'Hàng ngày';
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
