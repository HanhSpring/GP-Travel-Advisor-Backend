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
  AlgorithmTrainingScheduleDto,
  AlgorithmTrainingScheduleFrequency,
  ModelVersionDto,
  PrepareDatasetResponseDto,
  RunFullTrainingRequestDto,
  RunFullTrainingResponseDto,
  TrainingCallbackDto,
  TrainingRunDto,
  UpdateAlgorithmTrainingScheduleDto,
} from './dto/algorithm-training.dto';

// :algorithm nhan tu URL -> ten that trong ai_config.algorithms. Chi ho tro 'two-tower' o lan
// nay (docs/trigger) -- them 'hybrid-recommender' sau bang cach mo rong map nay, khong can sua
// controller/service khac.
const ALGORITHM_NAME_MAP: Record<string, string> = {
  'two-tower': 'two_tower_retrieval',
};

// Phai khop CHINH XAC _STRONG_SIGNAL_ACTION_TYPES trong
// ai-service/scripts/export_training_data.py -- day la tap action_type duy nhat export giu lai
// (loai unsave/view/click/search/save), nen row_counts.interactions/date_range_end da luu trong
// training_datasets CHI dai dien cho tap con nay, khong phai toan bo mv_training_interactions.
const STRONG_SIGNAL_ACTION_TYPES = ['rating', 'review', 'visited'];

type AlgorithmRow = { id: string; name: string };
type TrainingDatasetRow = {
  id: string;
  algorithm_id: string;
  status: 'preparing' | 'ready' | 'failed';
  r2_prefix: string;
  row_counts: Record<string, number> | null;
  date_range_start: string | null;
  date_range_end: string | null;
};
type TrainingRunRow = {
  id: string;
  algorithm_id: string;
  run_type: 'data_export' | 'training' | 'promotion';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  trigger_type: 'manual' | 'schedule';
  triggered_by: string | null;
  training_dataset_id: string | null;
  model_version_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  error_message: string | null;
  metrics: Record<string, unknown> | null;
  created_at: string;
};
type ModelVersionRow = {
  id: string;
  algorithm_id: string;
  version_tag: string;
  status: 'candidate' | 'active' | 'archived' | 'failed';
  training_dataset_id: string | null;
  weights_r2_key: string | null;
  vocab_r2_key: string | null;
  metrics: Record<string, number> | null;
  trained_at: string | null;
  promoted_at: string | null;
  created_at: string;
};
type ScheduleRow = {
  id: string;
  algorithm_id: string;
  is_enabled: boolean;
  frequency: AlgorithmTrainingScheduleFrequency;
  run_time: string;
  run_day: number | null;
  last_run_at: string | null;
};

@Injectable()
export class AlgorithmTrainingService {
  private readonly logger = new Logger(AlgorithmTrainingService.name);
  private readonly aiServiceUrl: string;

  constructor(private readonly httpService: HttpService) {
    this.aiServiceUrl = (process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000')
      .trim()
      .replace('://localhost:', '://127.0.0.1:');
  }

  // ------------------------------------------------------------------ helpers

  resolveAlgorithmSlug(slug: string): string {
    if (!ALGORITHM_NAME_MAP[slug]) {
      throw new NotFoundException(
        `Thuật toán '${slug}' chưa được hỗ trợ ở tính năng train lại (hiện chỉ có: ${Object.keys(ALGORITHM_NAME_MAP).join(', ')})`,
      );
    }
    return slug;
  }

  private async getAlgorithm(slug: string): Promise<AlgorithmRow> {
    const name = ALGORITHM_NAME_MAP[slug];
    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithms')
      .select('id,name')
      .eq('name', name)
      .maybeSingle();
    this.throwIfSupabaseError(error, `Could not load algorithm '${name}'`);
    if (!data) {
      throw new NotFoundException(
        `Chưa seed ai_config.algorithms cho '${name}' — chạy migration 20260710060000_mv_training_interactions.sql`,
      );
    }
    return data as AlgorithmRow;
  }

  private throwIfSupabaseError(error: unknown, message: string): void {
    if (!error) return;
    const detail =
      typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error);
    this.logger.error(`${message}: ${detail}`);
    throw new InternalServerErrorException(message);
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: unknown }).code === '23505'
    );
  }

  /** Ban "ready" gan nhat cua 1 thuat toan, hoac null neu chua tung export lan nao. Dung chung
   * boi prepareDataset() (change-detection) va runFullTraining() (khi khong chi dinh dataset). */
  private async getLatestReadyDataset(algorithmId: string): Promise<TrainingDatasetRow | null> {
    const { data, error } = await supabase
      .schema('ai_config')
      .from('training_datasets')
      .select('*')
      .eq('algorithm_id', algorithmId)
      .eq('status', 'ready')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    this.throwIfSupabaseError(error, 'Could not load latest training_datasets row');
    return (data as TrainingDatasetRow) ?? null;
  }

  /** So sanh voi lan export "ready" gan nhat: dem + tim created_at moi nhat tren dung tap
   * action_type ma export_training_data.py giu lai (STRONG_SIGNAL_ACTION_TYPES), khop 1:1 voi
   * row_counts.interactions/date_range_end da luu -- KHONG dung COUNT(*) tho tren toan bo MV vi
   * MV con chua ca view/click/search/save/unsave (khong bao gio duoc export), so sai tap se
   * luon bao "changed" du khong co gi moi. */
  private async detectTrainingDataChange(
    previous: TrainingDatasetRow,
  ): Promise<{ changed: boolean; currentCount: number; currentMaxCreatedAt: string | null; reason: string }> {
    const { count, error: countError } = await supabase
      .schema('travel')
      .from('mv_training_interactions')
      .select('*', { count: 'exact', head: true })
      .in('action_type', STRONG_SIGNAL_ACTION_TYPES);
    this.throwIfSupabaseError(countError, 'Could not count mv_training_interactions');

    const { data: latestRow, error: maxError } = await supabase
      .schema('travel')
      .from('mv_training_interactions')
      .select('created_at')
      .in('action_type', STRONG_SIGNAL_ACTION_TYPES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    this.throwIfSupabaseError(maxError, 'Could not read latest mv_training_interactions.created_at');

    const currentCount = count ?? 0;
    const currentMaxCreatedAt = (latestRow as { created_at: string } | null)?.created_at ?? null;
    const previousCount = previous.row_counts?.interactions ?? null;
    const previousMaxCreatedAt = previous.date_range_end;

    if (previousCount === null || previousMaxCreatedAt === null) {
      return { changed: true, currentCount, currentMaxCreatedAt, reason: 'Chưa có mốc so sánh hợp lệ từ lần export trước.' };
    }
    if (currentCount !== previousCount) {
      return {
        changed: true, currentCount, currentMaxCreatedAt,
        reason: `Số interaction đổi: ${previousCount} -> ${currentCount}.`,
      };
    }
    if (currentMaxCreatedAt === null || new Date(currentMaxCreatedAt).getTime() > new Date(previousMaxCreatedAt).getTime()) {
      return {
        changed: true, currentCount, currentMaxCreatedAt,
        reason: `Có interaction mới hơn mốc đã export (${previousMaxCreatedAt}).`,
      };
    }
    return {
      changed: false, currentCount, currentMaxCreatedAt,
      reason: `Không có interaction rating/review/visited mới kể từ lần export gần nhất ` +
        `(count=${currentCount}, mới nhất=${currentMaxCreatedAt ?? 'n/a'}).`,
    };
  }

  // ------------------------------------------------------------ prepare-dataset

  async prepareDataset(
    algorithmSlug: string,
    userId?: string,
    force = false,
  ): Promise<PrepareDatasetResponseDto> {
    const algorithm = await this.getAlgorithm(algorithmSlug);

    if (!force) {
      const latestDataset = await this.getLatestReadyDataset(algorithm.id);
      if (latestDataset) {
        const check = await this.detectTrainingDataChange(latestDataset);
        if (!check.changed) {
          this.logger.log(`prepareDataset('${algorithmSlug}') skipped -- ${check.reason}`);
          return {
            trainingRunId: null,
            trainingDatasetId: latestDataset.id,
            r2Prefix: latestDataset.r2_prefix,
            rowCounts: latestDataset.row_counts ?? {},
            dateRangeStart: latestDataset.date_range_start,
            dateRangeEnd: latestDataset.date_range_end,
            skipped: true,
            skipReason: check.reason,
          };
        }
      }
    }

    const startedAt = new Date().toISOString();

    const { data: run, error: insertRunError } = await supabase
      .schema('ai_config')
      .from('training_runs')
      .insert({
        algorithm_id: algorithm.id,
        run_type: 'data_export',
        status: 'running',
        trigger_type: userId ? 'manual' : 'schedule',
        triggered_by: userId ?? null,
        started_at: startedAt,
      })
      .select('*')
      .single();

    if (insertRunError) {
      if (this.isUniqueViolation(insertRunError)) {
        throw new ConflictException(
          'Đang có 1 lần chạy khác cho thuật toán này, vui lòng đợi.',
        );
      }
      this.throwIfSupabaseError(insertRunError, 'Could not create training_runs row');
    }
    const trainingRun = run as TrainingRunRow;

    try {
      const response = await firstValueFrom(
        this.httpService.post<{
          run_id: string;
          r2_prefix: string;
          n_interactions: number;
          n_users: number;
          n_places: number;
          date_range_start: string | null;
          date_range_end: string | null;
        }>(
          `${this.aiServiceUrl}/api/v1/two-tower-training/prepare-dataset`,
          { run_id: trainingRun.id },
          { timeout: 600_000 },
        ),
      );
      const result = response.data;

      const { data: dataset, error: insertDatasetError } = await supabase
        .schema('ai_config')
        .from('training_datasets')
        .insert({
          algorithm_id: algorithm.id,
          status: 'ready',
          r2_prefix: result.r2_prefix,
          row_counts: {
            users: result.n_users,
            places: result.n_places,
            interactions: result.n_interactions,
          },
          date_range_start: result.date_range_start,
          date_range_end: result.date_range_end,
          created_by: userId ?? null,
          completed_at: new Date().toISOString(),
        })
        .select('*')
        .single();
      this.throwIfSupabaseError(insertDatasetError, 'Could not create training_datasets row');
      const trainingDataset = dataset as TrainingDatasetRow;

      const completedAt = new Date().toISOString();
      await supabase
        .schema('ai_config')
        .from('training_runs')
        .update({
          status: 'completed',
          training_dataset_id: trainingDataset.id,
          completed_at: completedAt,
          duration_seconds: Math.round(
            (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000,
          ),
          metrics: { row_counts: trainingDataset.row_counts },
        })
        .eq('id', trainingRun.id);

      return {
        trainingRunId: trainingRun.id,
        trainingDatasetId: trainingDataset.id,
        r2Prefix: trainingDataset.r2_prefix,
        rowCounts: trainingDataset.row_counts ?? {},
        dateRangeStart: trainingDataset.date_range_start,
        dateRangeEnd: trainingDataset.date_range_end,
      };
    } catch (error: any) {
      await supabase
        .schema('ai_config')
        .from('training_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: error?.response?.data?.detail ?? error?.message ?? 'prepare-dataset failed',
        })
        .eq('id', trainingRun.id);

      if (error?.response?.data) {
        throw new InternalServerErrorException(error.response.data.detail || 'Chuẩn bị dữ liệu thất bại');
      }
      throw new InternalServerErrorException(
        'Không thể kết nối đến AI service. Hãy kiểm tra ai-service đang chạy.',
      );
    }
  }

  // ------------------------------------------------------------ run-full-training

  async runFullTraining(
    algorithmSlug: string,
    dto: RunFullTrainingRequestDto,
    userId?: string,
  ): Promise<RunFullTrainingResponseDto> {
    const algorithm = await this.getAlgorithm(algorithmSlug);

    let trainingDataset: TrainingDatasetRow;
    if (dto.trainingDatasetId) {
      const { data, error } = await supabase
        .schema('ai_config')
        .from('training_datasets')
        .select('*')
        .eq('id', dto.trainingDatasetId)
        .eq('algorithm_id', algorithm.id)
        .maybeSingle();
      this.throwIfSupabaseError(error, 'Could not load training_datasets row');
      if (!data) {
        throw new NotFoundException('Không tìm thấy training_dataset đã chỉ định');
      }
      trainingDataset = data as TrainingDatasetRow;
    } else {
      const latest = await this.getLatestReadyDataset(algorithm.id);
      if (!latest) {
        throw new NotFoundException(
          'Chưa có dataset nào sẵn sàng — bấm "Chuẩn bị dữ liệu" trước khi train.',
        );
      }
      trainingDataset = latest;
    }

    // Warm-start tu version dang active (neu co) -- "pretrain rarely + fine-tune often".
    const { data: activeVersion } = await supabase
      .schema('ai_config')
      .from('model_versions')
      .select('weights_r2_key,vocab_r2_key')
      .eq('algorithm_id', algorithm.id)
      .eq('status', 'active')
      .maybeSingle();
    const activeRow = activeVersion as Pick<ModelVersionRow, 'weights_r2_key' | 'vocab_r2_key'> | null;

    const startedAt = new Date().toISOString();
    const { data: run, error: insertRunError } = await supabase
      .schema('ai_config')
      .from('training_runs')
      .insert({
        algorithm_id: algorithm.id,
        run_type: 'training',
        status: 'pending',
        trigger_type: userId ? 'manual' : 'schedule',
        triggered_by: userId ?? null,
        training_dataset_id: trainingDataset.id,
        started_at: startedAt,
      })
      .select('*')
      .single();

    if (insertRunError) {
      if (this.isUniqueViolation(insertRunError)) {
        throw new ConflictException(
          'Đang có 1 lần chạy khác cho thuật toán này, vui lòng đợi.',
        );
      }
      this.throwIfSupabaseError(insertRunError, 'Could not create training_runs row');
    }
    const trainingRun = run as TrainingRunRow;

    try {
      const response = await firstValueFrom(
        this.httpService.post<{ status: string; modal_call_id?: string }>(
          `${this.aiServiceUrl}/api/v1/two-tower-training/train`,
          {
            run_id: trainingRun.id,
            dataset_r2_prefix: trainingDataset.r2_prefix,
            warm_start_weights_r2_key: activeRow?.weights_r2_key ?? undefined,
            warm_start_vocab_r2_key: activeRow?.vocab_r2_key ?? undefined,
            // Mac dinh FALSE tuong minh (khong de undefined cho ai-service/Modal tu suy luan
            // theo "co warm_start_dir hay khong") -- vi Yelp KHONG duoc upload len R2 (chi luu
            // tren Google Drive), neu lan chay dau tien chua co model_version nao active thi
            // Modal se tu suy include_yelp=True va crash FileNotFoundError khi tim file Yelp.
            // Chi doi thanh true neu thuc su muon pretrain lai tu dau qua Modal (hiem, thu cong).
            include_yelp: dto.includeYelp ?? false,
            is_demo_mode: dto.isDemoMode ?? false,
          },
          { timeout: 10_000 },
        ),
      );

      await supabase
        .schema('ai_config')
        .from('training_runs')
        .update({
          status: 'running',
          metrics: { modal_call_id: response.data.modal_call_id ?? null },
        })
        .eq('id', trainingRun.id);

      return {
        trainingRunId: trainingRun.id,
        status: response.data.status,
        modalCallId: response.data.modal_call_id ?? null,
      };
    } catch (error: any) {
      await supabase
        .schema('ai_config')
        .from('training_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: error?.response?.data?.detail ?? error?.message ?? 'run-full-training failed',
        })
        .eq('id', trainingRun.id);

      if (error?.response?.data) {
        throw new InternalServerErrorException(error.response.data.detail || 'Gửi job train thất bại');
      }
      throw new InternalServerErrorException(
        'Không thể kết nối đến AI service. Hãy kiểm tra ai-service đang chạy.',
      );
    }
  }

  // ------------------------------------------------------------------ runs / versions

  async getRuns(algorithmSlug: string, limit = 20): Promise<TrainingRunDto[]> {
    const algorithm = await this.getAlgorithm(algorithmSlug);
    const { data, error } = await supabase
      .schema('ai_config')
      .from('training_runs')
      .select('*')
      .eq('algorithm_id', algorithm.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    this.throwIfSupabaseError(error, 'Could not load training_runs');
    return ((data ?? []) as TrainingRunRow[]).map((r) => ({
      id: r.id,
      runType: r.run_type,
      status: r.status,
      triggerType: r.trigger_type,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      durationSeconds: r.duration_seconds,
      errorMessage: r.error_message,
      metrics: r.metrics,
      createdAt: r.created_at,
    }));
  }

  async getVersions(algorithmSlug: string): Promise<ModelVersionDto[]> {
    const algorithm = await this.getAlgorithm(algorithmSlug);
    const { data, error } = await supabase
      .schema('ai_config')
      .from('model_versions')
      .select('*')
      .eq('algorithm_id', algorithm.id)
      .order('created_at', { ascending: false });
    this.throwIfSupabaseError(error, 'Could not load model_versions');
    return ((data ?? []) as ModelVersionRow[]).map((v) => ({
      id: v.id,
      versionTag: v.version_tag,
      status: v.status,
      metrics: v.metrics,
      trainedAt: v.trained_at,
      promotedAt: v.promoted_at,
      createdAt: v.created_at,
    }));
  }

  // ------------------------------------------------------------------ promote

  async promoteVersion(
    algorithmSlug: string,
    versionId: string,
    userId?: string,
  ): Promise<ModelVersionDto> {
    const algorithm = await this.getAlgorithm(algorithmSlug);

    const { data: targetData, error: targetError } = await supabase
      .schema('ai_config')
      .from('model_versions')
      .select('*')
      .eq('id', versionId)
      .eq('algorithm_id', algorithm.id)
      .maybeSingle();
    this.throwIfSupabaseError(targetError, 'Could not load model_versions row');
    if (!targetData) {
      throw new NotFoundException('Không tìm thấy model_version đã chỉ định');
    }
    const target = targetData as ModelVersionRow;
    if (!target.weights_r2_key || !target.vocab_r2_key) {
      throw new InternalServerErrorException('Version này thiếu weights_r2_key/vocab_r2_key, không thể kích hoạt');
    }

    const { data: currentActiveData } = await supabase
      .schema('ai_config')
      .from('model_versions')
      .select('id')
      .eq('algorithm_id', algorithm.id)
      .eq('status', 'active')
      .maybeSingle();
    const currentActive = currentActiveData as { id: string } | null;

    // 1. Archive ban active hien tai TRUOC (ton trong unique index "1 active/algorithm").
    if (currentActive && currentActive.id !== target.id) {
      await supabase
        .schema('ai_config')
        .from('model_versions')
        .update({ status: 'archived' })
        .eq('id', currentActive.id);
    }

    // 2. Set target -> active.
    const { error: activateError } = await supabase
      .schema('ai_config')
      .from('model_versions')
      .update({
        status: 'active',
        promoted_at: new Date().toISOString(),
        promoted_by: userId ?? null,
      })
      .eq('id', target.id);
    this.throwIfSupabaseError(activateError, 'Could not activate model_version');

    // 3. Hot-reload ai-service. Neu loi: dao nguoc DB (giu nguyen ban cu active, target quay lai
    // trang thai truoc) -- KHONG duoc de DB noi "active" trong khi ai-service van dang chay
    // model cu (hoac khong co model nao).
    try {
      await firstValueFrom(
        this.httpService.post(
          `${this.aiServiceUrl}/api/v1/two-tower-training/reload`,
          {
            weights_r2_key: target.weights_r2_key,
            vocab_r2_key: target.vocab_r2_key,
            model_version_id: target.id,
          },
          { timeout: 120_000 },
        ),
      );
    } catch (error: any) {
      await supabase
        .schema('ai_config')
        .from('model_versions')
        .update({ status: target.status })
        .eq('id', target.id);
      if (currentActive && currentActive.id !== target.id) {
        await supabase
          .schema('ai_config')
          .from('model_versions')
          .update({ status: 'active' })
          .eq('id', currentActive.id);
      }
      const detail = error?.response?.data?.detail ?? error?.message ?? 'reload failed';
      throw new InternalServerErrorException(
        `Kích hoạt thất bại, ai-service không load được model mới (${detail}) — đã giữ nguyên bản đang chạy.`,
      );
    }

    const { data: refreshed } = await supabase
      .schema('ai_config')
      .from('model_versions')
      .select('*')
      .eq('id', target.id)
      .single();
    const v = refreshed as ModelVersionRow;
    return {
      id: v.id,
      versionTag: v.version_tag,
      status: v.status,
      metrics: v.metrics,
      trainedAt: v.trained_at,
      promotedAt: v.promoted_at,
      createdAt: v.created_at,
    };
  }

  // ------------------------------------------------------------------ webhook

  async handleTrainingCallback(payload: TrainingCallbackDto): Promise<void> {
    const { data: runData, error: runError } = await supabase
      .schema('ai_config')
      .from('training_runs')
      .select('*')
      .eq('id', payload.run_id)
      .maybeSingle();
    this.throwIfSupabaseError(runError, 'Could not load training_runs row for callback');
    if (!runData) {
      throw new NotFoundException(`Không tìm thấy training_runs với id=${payload.run_id}`);
    }
    const run = runData as TrainingRunRow;
    const completedAt = new Date().toISOString();

    if (payload.status === 'failed') {
      await supabase
        .schema('ai_config')
        .from('training_runs')
        .update({
          status: 'failed',
          completed_at: completedAt,
          error_message: payload.error_message ?? 'Modal training job reported failure',
        })
        .eq('id', run.id);
      return;
    }

    const { data: versionData, error: versionError } = await supabase
      .schema('ai_config')
      .from('model_versions')
      .insert({
        algorithm_id: run.algorithm_id,
        version_tag: run.id,
        status: 'candidate',
        training_dataset_id: run.training_dataset_id,
        weights_r2_key: payload.weights_r2_key,
        vocab_r2_key: payload.vocab_r2_key,
        metrics: payload.metrics ?? {},
        trained_at: completedAt,
      })
      .select('*')
      .single();
    this.throwIfSupabaseError(versionError, 'Could not create model_versions row');
    const version = versionData as ModelVersionRow;

    const durationSeconds = run.started_at
      ? Math.round((new Date(completedAt).getTime() - new Date(run.started_at).getTime()) / 1000)
      : null;

    await supabase
      .schema('ai_config')
      .from('training_runs')
      .update({
        status: 'completed',
        model_version_id: version.id,
        completed_at: completedAt,
        duration_seconds: durationSeconds,
        metrics: { ...(run.metrics ?? {}), epochs_run: payload.epochs_run, is_finetune: payload.is_finetune },
      })
      .eq('id', run.id);

    this.logger.log(`Training callback: run_id=${run.id} -> model_version=${version.id} (candidate)`);
  }

  // ------------------------------------------------------------------ schedule
  // (chi tu dong hoa buoc "Chuan bi du lieu", KHONG bao gio tu goi train -- nguyen tac README muc 4)

  async getSchedule(algorithmSlug: string): Promise<AlgorithmTrainingScheduleDto> {
    const algorithm = await this.getAlgorithm(algorithmSlug);
    const schedule = await this.ensureScheduleRow(algorithm.id);
    return this.buildScheduleResponse(schedule);
  }

  async updateSchedule(
    algorithmSlug: string,
    dto: UpdateAlgorithmTrainingScheduleDto,
  ): Promise<AlgorithmTrainingScheduleDto> {
    const algorithm = await this.getAlgorithm(algorithmSlug);
    const current = await this.ensureScheduleRow(algorithm.id);
    const updates: Partial<ScheduleRow> = {};

    if (typeof dto.autoEnabled === 'boolean') updates.is_enabled = dto.autoEnabled;
    if (dto.frequency) updates.frequency = dto.frequency;
    if (dto.runTime !== undefined) updates.run_time = this.normalizeRunTime(dto.runTime);
    if (dto.runDay !== undefined) updates.run_day = Number(dto.runDay);

    if (Object.keys(updates).length === 0) {
      return this.buildScheduleResponse(current);
    }

    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithm_schedules')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('algorithm_id', algorithm.id)
      .select('*')
      .single();
    this.throwIfSupabaseError(error, 'Could not update algorithm_training schedule');
    return this.buildScheduleResponse(data as ScheduleRow);
  }

  /** Goi moi phut boi AlgorithmTrainingScheduleCron -- CHI goi prepare-dataset neu den gio. */
  async runPrepareDatasetIfDue(): Promise<void> {
    for (const slug of Object.keys(ALGORITHM_NAME_MAP)) {
      const schedule = await this.getSchedule(slug);
      if (!schedule.autoEnabled) continue;

      const due = this.getDueScheduleTime(schedule);
      if (!due) continue;

      this.logger.log(`Algorithm training (prepare-dataset) auto schedule due for '${slug}' at ${due.toISOString()}`);
      try {
        await this.prepareDataset(slug);
      } catch (error: any) {
        this.logger.error(`Auto prepare-dataset failed for '${slug}': ${error?.message ?? error}`);
      } finally {
        await this.markScheduleLastRun(slug, due.getTime());
      }
    }
  }

  private async ensureScheduleRow(algorithmId: string): Promise<ScheduleRow> {
    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithm_schedules')
      .select('*')
      .eq('algorithm_id', algorithmId)
      .maybeSingle();
    this.throwIfSupabaseError(error, 'Could not load algorithm_training schedule');
    if (data) return data as ScheduleRow;

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
    this.throwIfSupabaseError(insertError, 'Could not seed algorithm_training schedule');
    return inserted as ScheduleRow;
  }

  private buildScheduleResponse(row: ScheduleRow): AlgorithmTrainingScheduleDto {
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
    if (!match) throw new InternalServerErrorException('Invalid run time format');
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      throw new InternalServerErrorException('Invalid run time value');
    }
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  private getDueScheduleTime(schedule: AlgorithmTrainingScheduleDto): Date | null {
    const now = new Date();
    const [hours, minutes] = schedule.runTime.split(':').map(Number);
    const scheduled = new Date(now);
    scheduled.setHours(hours, minutes, 0, 0);

    if (now < scheduled) return null;
    if (schedule.frequency === 'weekly' && now.getDay() !== Number(schedule.runDay)) return null;
    if (schedule.frequency === 'monthly' && now.getDate() !== Number(schedule.runDay)) return null;

    const lastRunAt = schedule.lastRunAt ? new Date(schedule.lastRunAt).getTime() : 0;
    return lastRunAt >= scheduled.getTime() ? null : scheduled;
  }

  private async markScheduleLastRun(algorithmSlug: string, epochMs: number): Promise<void> {
    const algorithm = await this.getAlgorithm(algorithmSlug);
    const { error } = await supabase
      .schema('ai_config')
      .from('algorithm_schedules')
      .update({ last_run_at: new Date(epochMs).toISOString(), updated_at: new Date().toISOString() })
      .eq('algorithm_id', algorithm.id);
    this.throwIfSupabaseError(error, 'Could not update algorithm_training schedule last_run_at');
  }
}
