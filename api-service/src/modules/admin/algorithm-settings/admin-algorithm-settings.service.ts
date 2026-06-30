import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { supabase } from '../../../config/supabase';
import {
  AlgorithmLogDto,
  IntentKey,
  ParameterMetaDto,
  SlotKey,
  TwoTowerSettingsDto,
} from './dto/two-tower-settings.dto';
import {
  ReviewFilterSettingsDto,
  ReviewFilterTopicKey,
} from './dto/review-filter-settings.dto';
import { UpdateTwoTowerSettingsDto } from './dto/update-two-tower-settings.dto';
import { UpdateReviewFilterSettingsDto } from './dto/update-review-filter-settings.dto';

const ALGORITHM_NAME = 'two_tower_retrieval' as const;
const REVIEW_FILTER_ALGORITHM_NAME = 'review_filter' as const;
const HYBRID_RECOMMENDER_ALGORITHM_NAME = 'hybrid_recommender' as const;
const MAX_INTENT_QUOTA_TOTAL = 15;
const SETTINGS_CACHE_TTL_MS = 60_000;

const INTENT_KEYS = [
  'general',
  'food',
  'urban',
  'nature',
  'beach',
  'culture',
] as const satisfies readonly IntentKey[];

const SLOT_KEYS = [
  'attraction',
  'restaurant',
  'cafe',
  'entertainment',
  'accommodation',
] as const satisfies readonly SlotKey[];

const CORE_PARAM_MAP = {
  defaultTopK: 'default_top_k',
  maxTopK: 'max_top_k',
  maxIntents: 'max_intents',
  fetchBufferMultiplier: 'fetch_buffer_multiplier',
  enableAttractionTravelTypeFilter: 'enable_attraction_travel_type_filter',
  enableDiversityBudget: 'enable_diversity_budget',
  moderationBatchIntervalMinutes: 'moderation_batch_interval_minutes',
} as const;

const BOOLEAN_PARAMS = new Set<string>([
  CORE_PARAM_MAP.enableAttractionTravelTypeFilter,
  CORE_PARAM_MAP.enableDiversityBudget,
]);

const INTEGER_PARAMS = new Set<string>([
  CORE_PARAM_MAP.defaultTopK,
  CORE_PARAM_MAP.maxTopK,
  CORE_PARAM_MAP.maxIntents,
  CORE_PARAM_MAP.moderationBatchIntervalMinutes,
]);

const DEFAULT_PARAM_DEFINITIONS: Record<
  string,
  Omit<ParameterMetaDto, 'name'>
> = {
  default_top_k: {
    defaultValue: 100,
    currentValue: 100,
    minValue: 10,
    maxValue: 200,
    description: 'Default candidate count when top_k is omitted',
  },
  max_top_k: {
    defaultValue: 200,
    currentValue: 200,
    minValue: 50,
    maxValue: 300,
    description: 'Hard cap for top_k to protect retrieval performance',
  },
  max_intents: {
    defaultValue: 3,
    currentValue: 3,
    minValue: 1,
    maxValue: 6,
    description: 'Maximum number of trip intents used for late fusion',
  },
  fetch_buffer_multiplier: {
    defaultValue: 2,
    currentValue: 2,
    minValue: 1,
    maxValue: 5,
    description: 'Multiplier for per-slot fetch limit',
  },
  enable_attraction_travel_type_filter: {
    defaultValue: 1,
    currentValue: true,
    minValue: 0,
    maxValue: 1,
    description: 'Enable travel_type filter for attraction slot',
  },
  enable_diversity_budget: {
    defaultValue: 1,
    currentValue: true,
    minValue: 0,
    maxValue: 1,
    description: 'Enable quota-aware diversity budget selection',
  },
  moderation_batch_interval_minutes: {
    defaultValue: 10,
    currentValue: 10,
    minValue: 1,
    maxValue: 1440,
    description:
      'Interval in minutes between periodic review moderation batch runs',
  },
};

const DEFAULT_QUOTAS: Record<IntentKey, Record<SlotKey, number>> = {
  general: {
    attraction: 4,
    restaurant: 2,
    cafe: 1,
    entertainment: 1,
    accommodation: 1,
  },
  food: {
    attraction: 1,
    restaurant: 4,
    cafe: 2,
    entertainment: 0,
    accommodation: 1,
  },
  urban: {
    attraction: 2,
    restaurant: 2,
    cafe: 1,
    entertainment: 3,
    accommodation: 1,
  },
  nature: {
    attraction: 5,
    restaurant: 2,
    cafe: 0,
    entertainment: 0,
    accommodation: 1,
  },
  beach: {
    attraction: 3,
    restaurant: 2,
    cafe: 1,
    entertainment: 1,
    accommodation: 1,
  },
  culture: {
    attraction: 5,
    restaurant: 2,
    cafe: 1,
    entertainment: 2,
    accommodation: 1,
  },
};

for (const intent of INTENT_KEYS) {
  for (const slot of SLOT_KEYS) {
    const name = quotaParamName(intent, slot);
    DEFAULT_PARAM_DEFINITIONS[name] = {
      defaultValue: DEFAULT_QUOTAS[intent][slot],
      currentValue: DEFAULT_QUOTAS[intent][slot],
      minValue: 0,
      maxValue: 10,
      description: `Daily ${slot} quota for ${intent} intent`,
    };
    INTEGER_PARAMS.add(name);
  }
}

type AlgorithmRow = {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  updated_at: string | null;
};

type ParameterRow = {
  parameter_name: string;
  default_value: number | string | null;
  current_value: number | string | null;
  description: string | null;
  min_value: number | string | null;
  max_value: number | string | null;
  updated_at?: string | null;
};

type Change = {
  parameterName: string;
  newValue: number;
  oldValue: number;
};

function quotaParamName(intentKey: IntentKey, slotKey: SlotKey): string {
  return `quota_${intentKey}_${slotKey}`;
}

function toNumber(value: number | string | null | undefined, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

const REVIEW_FILTER_TOPICS: Array<{ key: ReviewFilterTopicKey; label: string }> = [
  { key: 'traffic', label: 'Giao thông' },
  { key: 'weather', label: 'Thời tiết' },
  { key: 'crowd', label: 'Đông đúc' },
  { key: 'service', label: 'Dịch vụ' },
  { key: 'price', label: 'Giá cả' },
  { key: 'infra', label: 'Cơ sở hạ tầng' },
  { key: 'cleanliness', label: 'Vệ sinh sạch sẽ' },
  { key: 'food', label: 'Đồ ăn & uống' },
  { key: 'activity', label: 'Hoạt động' },
  { key: 'atmosphere', label: 'Không khí' },
  { key: 'other', label: 'Khác' },
];

const REVIEW_FILTER_PARAM_LABELS: Record<string, string> = {
  topic_other_threshold: 'Ngưỡng nhận dạng chủ đề',
  classifier_confidence_threshold: 'Độ tin cậy tối thiểu của mô hình',
  classifier_ambiguity_margin: 'Biên độ phân biệt nhãn',
  conflict_score_threshold: 'Ngưỡng điểm xung đột',
  candidate_mode: 'Chế độ lựa chọn đánh giá so sánh',
  top_k: 'Số đánh giá tối đa để so sánh',
  promotion_mode: 'Chế độ nâng cấp đánh giá',
};

const REVIEW_FILTER_DEFAULTS: Record<string, Omit<ParameterMetaDto, 'name'>> = {
  topic_other_threshold: { defaultValue: 0.18, currentValue: 0.18, minValue: 0.05, maxValue: 0.5, description: REVIEW_FILTER_PARAM_LABELS.topic_other_threshold },
  classifier_confidence_threshold: { defaultValue: 0.55, currentValue: 0.55, minValue: 0.5, maxValue: 0.95, description: REVIEW_FILTER_PARAM_LABELS.classifier_confidence_threshold },
  classifier_ambiguity_margin: { defaultValue: 0.1, currentValue: 0.1, minValue: 0, maxValue: 0.4, description: REVIEW_FILTER_PARAM_LABELS.classifier_ambiguity_margin },
  conflict_score_threshold: { defaultValue: 0.65, currentValue: 0.65, minValue: 0.5, maxValue: 0.9, description: REVIEW_FILTER_PARAM_LABELS.conflict_score_threshold },
  candidate_mode: { defaultValue: 0, currentValue: 0, minValue: 0, maxValue: 1, description: REVIEW_FILTER_PARAM_LABELS.candidate_mode },
  top_k: { defaultValue: 5, currentValue: 5, minValue: 1, maxValue: 50, description: REVIEW_FILTER_PARAM_LABELS.top_k },
  promotion_mode: { defaultValue: 0, currentValue: 0, minValue: 0, maxValue: 1, description: REVIEW_FILTER_PARAM_LABELS.promotion_mode },
};

function setReviewFilterTopicParam(
  prefix: string,
  topic: ReviewFilterTopicKey,
  defaultValue: number,
  minValue: number,
  maxValue: number,
  description: string,
) {
  REVIEW_FILTER_DEFAULTS[`${prefix}.${topic}`] = {
    defaultValue,
    currentValue: defaultValue,
    minValue,
    maxValue,
    description,
  };
}

const ttlDefaults: Record<ReviewFilterTopicKey, [number, number, number]> = {
  traffic: [24, 6, 72],
  weather: [24, 6, 72],
  crowd: [48, 12, 168],
  service: [72, 24, 336],
  price: [72, 24, 336],
  infra: [168, 72, 720],
  cleanliness: [168, 24, 336],
  food: [168, 24, 336],
  activity: [168, 72, 720],
  atmosphere: [720, 168, 2160],
  other: [48, 24, 168],
};
const lookbackDefaults: Record<ReviewFilterTopicKey, [number, number, number]> = {
  traffic: [3, 1, 6],
  weather: [3, 1, 6],
  crowd: [6, 2, 12],
  service: [6, 2, 12],
  price: [6, 2, 12],
  infra: [12, 3, 24],
  cleanliness: [6, 2, 12],
  food: [6, 2, 12],
  activity: [12, 3, 24],
  atmosphere: [12, 3, 24],
  other: [6, 2, 12],
};
const windowDefaults: Record<ReviewFilterTopicKey, [number, number, number]> = {
  traffic: [7, 1, 14],
  weather: [7, 1, 14],
  crowd: [14, 3, 30],
  service: [14, 3, 45],
  price: [14, 3, 45],
  infra: [30, 7, 90],
  cleanliness: [30, 7, 60],
  food: [30, 7, 60],
  activity: [30, 7, 90],
  atmosphere: [90, 14, 180],
  other: [14, 3, 30],
};
const thresholdDefaults: Record<ReviewFilterTopicKey, [number, number, number]> = {
  traffic: [3, 2, 10],
  weather: [3, 2, 10],
  crowd: [3, 2, 15],
  service: [3, 2, 15],
  price: [3, 2, 15],
  infra: [2, 2, 10],
  cleanliness: [3, 2, 15],
  food: [3, 2, 15],
  activity: [3, 2, 15],
  atmosphere: [2, 2, 10],
  other: [3, 2, 10],
};
const simDefaults: Record<ReviewFilterTopicKey, [number, number, number]> = {
  traffic: [0.62, 0.5, 0.8],
  weather: [0.62, 0.5, 0.8],
  crowd: [0.62, 0.5, 0.8],
  service: [0.62, 0.5, 0.82],
  price: [0.62, 0.5, 0.82],
  infra: [0.58, 0.45, 0.78],
  cleanliness: [0.62, 0.5, 0.82],
  food: [0.62, 0.5, 0.82],
  activity: [0.62, 0.5, 0.82],
  atmosphere: [0.6, 0.45, 0.78],
  other: [0.65, 0.55, 0.85],
};

for (const { key, label } of REVIEW_FILTER_TOPICS) {
  setReviewFilterTopicParam('ttl_hours', key, ...ttlDefaults[key], `Thời hạn hiệu lực theo chủ đề: ${label}`);
  setReviewFilterTopicParam('lookback_multiplier', key, ...lookbackDefaults[key], `Hệ số cửa sổ tra cứu theo chủ đề: ${label}`);
  setReviewFilterTopicParam('window_days', key, ...windowDefaults[key], `Cửa sổ quan sát theo chủ đề: ${label}`);
  setReviewFilterTopicParam('threshold', key, ...thresholdDefaults[key], `Số đánh giá tối thiểu để tổng hợp theo chủ đề: ${label}`);
  setReviewFilterTopicParam('sim_threshold', key, ...simDefaults[key], `Ngưỡng tương đồng nội dung theo chủ đề: ${label}`);
}

@Injectable()
export class AdminAlgorithmSettingsService {
  private readonly logger = new Logger(AdminAlgorithmSettingsService.name);
  private reviewFilterCache:
    | { expiresAt: number; data: ReviewFilterSettingsDto }
    | null = null;

  async getReviewFilterSettings(
    useCache = true,
  ): Promise<ReviewFilterSettingsDto> {
    if (
      useCache &&
      this.reviewFilterCache &&
      this.reviewFilterCache.expiresAt > Date.now()
    ) {
      return this.reviewFilterCache.data;
    }

    const algorithm = await this.ensureAlgorithm(
      REVIEW_FILTER_ALGORITHM_NAME,
      'Review filtering and time-label classification pipeline',
    );
    await this.seedMissingReviewFilterParameters(algorithm.id);
    const params = await this.getParameterMap(algorithm.id);
    const data = this.buildReviewFilterSettingsResponse(algorithm, params);
    this.reviewFilterCache = {
      expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS,
      data,
    };
    return data;
  }

  async getAlgorithmStatuses(): Promise<Record<string, boolean>> {
    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithms')
      .select('name,is_active')
      .in('name', [
        HYBRID_RECOMMENDER_ALGORITHM_NAME,
        REVIEW_FILTER_ALGORITHM_NAME,
        ALGORITHM_NAME,
      ]);

    this.throwIfSupabaseError(error, 'Could not load algorithm statuses');

    return Object.fromEntries(
      (data ?? []).map((row) => [row.name, Boolean(row.is_active)]),
    );
  }

  async updateReviewFilterSettings(
    dto: UpdateReviewFilterSettingsDto,
  ): Promise<ReviewFilterSettingsDto> {
    const algorithm = await this.ensureAlgorithm(
      REVIEW_FILTER_ALGORITHM_NAME,
      'Review filtering and time-label classification pipeline',
    );
    await this.seedMissingReviewFilterParameters(algorithm.id);
    const params = await this.getParameterMap(algorithm.id);
    const changes = Object.entries(dto.parameters ?? {})
      .filter(([name]) => REVIEW_FILTER_DEFAULTS[name])
      .map(([parameterName, rawValue]) => ({
        parameterName,
        newValue: Number(rawValue),
        oldValue: toNumber(params.get(parameterName)?.current_value),
      }))
      .filter((change) => change.newValue !== change.oldValue);

    this.validateReviewFilterChanges(changes, params);

    const timestamp = new Date().toISOString();
    for (const change of changes) {
      const { error } = await supabase
        .schema('ai_config')
        .from('algorithm_parameters')
        .update({ current_value: change.newValue, updated_at: timestamp })
        .eq('algorithm_id', algorithm.id)
        .eq('parameter_name', change.parameterName);

      this.throwIfSupabaseError(
        error,
        `Could not update parameter ${change.parameterName}`,
      );
    }

    if (changes.length > 0) {
      const logChanges = changes.map((change) => ({
        parameter: change.parameterName,
        label: this.reviewFilterParameterLabel(change.parameterName),
        oldValue: change.oldValue,
        newValue: change.newValue,
      }));
      await this.insertLog(algorithm.id, 'success', 'updated', {
        requestedAction: 'review_filter_update',
        message: this.buildChangeLogMessage(logChanges),
        changes: logChanges,
      });
    }

    this.invalidateReviewFilterCache();
    return this.getReviewFilterSettings(false);
  }

  async resetReviewFilterSettings(): Promise<ReviewFilterSettingsDto> {
    const algorithm = await this.ensureAlgorithm(
      REVIEW_FILTER_ALGORITHM_NAME,
      'Review filtering and time-label classification pipeline',
    );
    await this.seedMissingReviewFilterParameters(algorithm.id);
    const params = await this.getParameterMap(algorithm.id);
    const timestamp = new Date().toISOString();
    const changes: Change[] = [];

    for (const [parameterName, row] of params.entries()) {
      if (!REVIEW_FILTER_DEFAULTS[parameterName]) {
        continue;
      }
      const newValue = toNumber(row.default_value);
      const oldValue = toNumber(row.current_value);
      const { error } = await supabase
        .schema('ai_config')
        .from('algorithm_parameters')
        .update({ current_value: newValue, updated_at: timestamp })
        .eq('algorithm_id', algorithm.id)
        .eq('parameter_name', parameterName);

      this.throwIfSupabaseError(
        error,
        `Could not reset parameter ${parameterName}`,
      );

      if (oldValue !== newValue) {
        changes.push({ parameterName, oldValue, newValue });
      }
    }

    await this.insertLog(algorithm.id, 'success', 'reset', {
      requestedAction: 'review_filter_reset',
      message: this.buildResetLogMessage(changes),
      changes: changes.map((change) => ({
        parameter: change.parameterName,
        label: this.reviewFilterParameterLabel(change.parameterName),
        oldValue: change.oldValue,
        newValue: change.newValue,
      })),
    });

    this.invalidateReviewFilterCache();
    return this.getReviewFilterSettings(false);
  }

  getReviewFilterPipelinePayload(settings: ReviewFilterSettingsDto) {
    const value = (name: string, fallback = 0) =>
      Number(settings.parameters[name]?.currentValue ?? fallback);
    const byTopic = (prefix: string, fallback: Record<string, number>) =>
      Object.fromEntries(
        REVIEW_FILTER_TOPICS.map(({ key }) => [
          key,
          value(`${prefix}.${key}`, fallback[key] ?? 0),
        ]),
      );

    const windowDays = byTopic('window_days', {});
    const thresholds = byTopic('threshold', {});
    const simThresholds = byTopic('sim_threshold', {});
    const observationRules = Object.fromEntries(
      REVIEW_FILTER_TOPICS.map(({ key }) => [
        key,
        {
          window_days: windowDays[key],
          threshold: thresholds[key],
          sim_threshold: simThresholds[key],
        },
      ]),
    );

    return {
      topic_other_threshold: value('topic_other_threshold', 0.18),
      classifier_confidence_threshold: value('classifier_confidence_threshold', 0.55),
      classifier_ambiguity_margin: value('classifier_ambiguity_margin', 0.1),
      conflict_score_threshold: value('conflict_score_threshold', 0.65),
      candidate_mode: value('candidate_mode', 0) === 1 ? 'topk' : 'all',
      top_k: Math.round(value('top_k', 5)),
      promotion_mode: value('promotion_mode', 0) === 1 ? 'all' : 'representative',
      ttl_hours_by_topic: byTopic('ttl_hours', {}),
      lookback_multiplier_by_topic: byTopic('lookback_multiplier', {}),
      observation_rules: observationRules,
    };
  }

  async getTwoTowerSettings(): Promise<TwoTowerSettingsDto> {
    const algorithm = await this.getAlgorithm();
    const params = await this.getParameterMap(algorithm.id);

    return this.buildSettingsResponse(algorithm, params);
  }

  async updateTwoTowerSettings(
    dto: UpdateTwoTowerSettingsDto,
  ): Promise<TwoTowerSettingsDto> {
    const algorithm = await this.getAlgorithm();
    const params = await this.getParameterMap(algorithm.id);
    const changes = this.collectChanges(dto, params);

    this.validateChanges(changes, params);

    const logChanges: Array<{
      parameter: string;
      oldValue: number | boolean;
      newValue: number | boolean;
    }> = [];
    const timestamp = new Date().toISOString();

    if (
      typeof dto.isActive === 'boolean' &&
      dto.isActive !== algorithm.is_active
    ) {
      const { error } = await supabase
        .schema('ai_config')
        .from('algorithms')
        .update({ is_active: dto.isActive, updated_at: timestamp })
        .eq('id', algorithm.id);

      this.throwIfSupabaseError(error, 'Could not update algorithm status');
      logChanges.push({
        parameter: 'is_active',
        oldValue: algorithm.is_active,
        newValue: dto.isActive,
      });
    }

    for (const change of changes) {
      const { error } = await supabase
        .schema('ai_config')
        .from('algorithm_parameters')
        .update({ current_value: change.newValue, updated_at: timestamp })
        .eq('algorithm_id', algorithm.id)
        .eq('parameter_name', change.parameterName);

      this.throwIfSupabaseError(
        error,
        `Could not update parameter ${change.parameterName}`,
      );

      logChanges.push({
        parameter: change.parameterName,
        oldValue: this.valueForClient(change.parameterName, change.oldValue),
        newValue: this.valueForClient(change.parameterName, change.newValue),
      });
    }

    if (logChanges.length > 0) {
      await this.insertLog(algorithm.id, 'success', 'updated', {
        source: 'admin_ui',
        changedBy: null,
        changes: logChanges,
      });
    }

    return this.getTwoTowerSettings();
  }

  async resetTwoTowerSettings(): Promise<TwoTowerSettingsDto> {
    const algorithm = await this.getAlgorithm();
    const params = await this.getParameterMap(algorithm.id);
    const timestamp = new Date().toISOString();
    const changes: Array<{
      parameter: string;
      oldValue: number | boolean;
      newValue: number | boolean;
    }> = [];

    const { error: algorithmError } = await supabase
      .schema('ai_config')
      .from('algorithms')
      .update({ is_active: true, updated_at: timestamp })
      .eq('id', algorithm.id);

    this.throwIfSupabaseError(
      algorithmError,
      'Could not reset algorithm status',
    );

    if (!algorithm.is_active) {
      changes.push({
        parameter: 'is_active',
        oldValue: algorithm.is_active,
        newValue: true,
      });
    }

    for (const [parameterName, row] of params.entries()) {
      const defaultValue = toNumber(row.default_value);
      const oldValue = toNumber(row.current_value);
      const { error } = await supabase
        .schema('ai_config')
        .from('algorithm_parameters')
        .update({ current_value: defaultValue, updated_at: timestamp })
        .eq('algorithm_id', algorithm.id)
        .eq('parameter_name', parameterName);

      this.throwIfSupabaseError(
        error,
        `Could not reset parameter ${parameterName}`,
      );

      if (oldValue !== defaultValue) {
        changes.push({
          parameter: parameterName,
          oldValue: this.valueForClient(parameterName, oldValue),
          newValue: this.valueForClient(parameterName, defaultValue),
        });
      }
    }

    await this.insertLog(algorithm.id, 'success', 'reset', {
      action: 'reset_to_default',
      source: 'admin_ui',
      changedBy: null,
      changes,
    });

    return this.getTwoTowerSettings();
  }

  async getTwoTowerLogs(limit = 20): Promise<AlgorithmLogDto[]> {
    const algorithm = await this.getAlgorithm();
    const safeLimit = Math.min(Math.max(limit || 20, 1), 100);
    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithm_logs')
      .select('id,status,action,details,created_at')
      .eq('algorithm_id', algorithm.id)
      .order('created_at', { ascending: false })
      .limit(safeLimit);

    this.throwIfSupabaseError(error, 'Could not load algorithm logs');

    return (data ?? []).map((row) => ({
      id: row.id,
      status: row.status,
      action: row.action,
      details: this.parseDetails(row.details),
      createdAt: row.created_at,
    }));
  }

  private async getAlgorithm(): Promise<AlgorithmRow> {
    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithms')
      .select('id,name,description,is_active,updated_at')
      .eq('name', ALGORITHM_NAME)
      .maybeSingle();

    if (error) {
      this.logger.error(`Could not load Two Tower algorithm: ${error.message}`);
      throw new InternalServerErrorException(
        'Could not load Two Tower algorithm config',
      );
    }

    if (!data) {
      throw new NotFoundException(
        'Two Tower algorithm config has not been seeded',
      );
    }

    return data as AlgorithmRow;
  }

  private async ensureAlgorithm(
    name: string,
    description: string,
  ): Promise<AlgorithmRow> {
    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithms')
      .select('id,name,description,is_active,updated_at')
      .eq('name', name)
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
      .insert({ name, description, is_active: true })
      .select('id,name,description,is_active,updated_at')
      .single();

    this.throwIfSupabaseError(insertError, `Could not seed algorithm ${name}`);
    return inserted as AlgorithmRow;
  }

  private async getParameterMap(
    algorithmId: string,
  ): Promise<Map<string, ParameterRow>> {
    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithm_parameters')
      .select(
        'parameter_name,default_value,current_value,description,min_value,max_value,updated_at',
      )
      .eq('algorithm_id', algorithmId);

    this.throwIfSupabaseError(error, 'Could not load algorithm parameters');

    return new Map(
      (data ?? []).map((row) => [row.parameter_name, row as ParameterRow]),
    );
  }

  private async seedMissingReviewFilterParameters(
    algorithmId: string,
  ): Promise<void> {
    const params = await this.getParameterMap(algorithmId);
    const timestamp = new Date().toISOString();
    const rows = Object.entries(REVIEW_FILTER_DEFAULTS)
      .filter(([name]) => !params.has(name))
      .map(([parameter_name, meta]) => ({
        algorithm_id: algorithmId,
        parameter_name,
        default_value: Number(meta.defaultValue),
        current_value: Number(meta.currentValue),
        min_value: meta.minValue,
        max_value: meta.maxValue,
        description: meta.description,
        updated_at: timestamp,
      }));

    if (!rows.length) {
      return;
    }

    const { error } = await supabase
      .schema('ai_config')
      .from('algorithm_parameters')
      .insert(rows);

    this.throwIfSupabaseError(error, 'Could not seed review filter parameters');
  }

  private buildReviewFilterSettingsResponse(
    algorithm: AlgorithmRow,
    params: Map<string, ParameterRow>,
  ): ReviewFilterSettingsDto {
    const parameters: Record<string, ParameterMetaDto> = {};
    for (const [name, fallback] of Object.entries(REVIEW_FILTER_DEFAULTS)) {
      const row = params.get(name);
      parameters[name] = {
        name,
        defaultValue: toNumber(row?.default_value, Number(fallback.defaultValue)),
        currentValue: toNumber(row?.current_value, Number(fallback.currentValue)),
        minValue: toNumber(row?.min_value, fallback.minValue),
        maxValue: toNumber(row?.max_value, fallback.maxValue),
        description: row?.description ?? fallback.description,
      };
    }

    return {
      algorithm: {
        id: algorithm.id,
        name: REVIEW_FILTER_ALGORITHM_NAME,
        description: algorithm.description,
        isActive: Boolean(algorithm.is_active),
        updatedAt: algorithm.updated_at,
      },
      topics: REVIEW_FILTER_TOPICS,
      parameters,
    };
  }

  private validateReviewFilterChanges(
    changes: Change[],
    params: Map<string, ParameterRow>,
  ): void {
    for (const change of changes) {
      const row = params.get(change.parameterName);
      if (!row) {
        throw new BadRequestException(
          `Tham số ${change.parameterName} chưa được khởi tạo`,
        );
      }
      if (!Number.isFinite(change.newValue)) {
        throw new BadRequestException(
          `Tham số ${change.parameterName} phải là số`,
        );
      }

      const minValue = toNumber(row.min_value);
      const maxValue = toNumber(row.max_value);
      if (change.newValue < minValue || change.newValue > maxValue) {
        throw new BadRequestException(
          `Tham số ${change.parameterName} phải nằm trong khoảng ${minValue} - ${maxValue}`,
        );
      }

      if (
        ['candidate_mode', 'promotion_mode'].includes(change.parameterName) &&
        ![0, 1].includes(change.newValue)
      ) {
        throw new BadRequestException(
          `Tham số ${change.parameterName} chỉ nhận giá trị 0 hoặc 1`,
        );
      }

      if (
        (change.parameterName === 'top_k' ||
          change.parameterName.startsWith('ttl_hours.') ||
          change.parameterName.startsWith('lookback_multiplier.') ||
          change.parameterName.startsWith('window_days.') ||
          change.parameterName.startsWith('threshold.')) &&
        !Number.isInteger(change.newValue)
      ) {
        throw new BadRequestException(
          `Tham số ${change.parameterName} phải là số nguyên`,
        );
      }
    }
  }

  private reviewFilterParameterLabel(parameterName: string): string {
    if (REVIEW_FILTER_PARAM_LABELS[parameterName]) {
      return REVIEW_FILTER_PARAM_LABELS[parameterName];
    }
    const [prefix, topic] = parameterName.split('.');
    const topicLabel =
      REVIEW_FILTER_TOPICS.find((item) => item.key === topic)?.label ?? topic;
    const prefixLabels: Record<string, string> = {
      ttl_hours: 'Thời hạn hiệu lực theo chủ đề',
      lookback_multiplier: 'Hệ số cửa sổ tra cứu theo chủ đề',
      window_days: 'Cửa sổ quan sát theo chủ đề',
      threshold: 'Số đánh giá tối thiểu để tổng hợp theo chủ đề',
      sim_threshold: 'Ngưỡng tương đồng nội dung theo chủ đề',
    };
    return `${prefixLabels[prefix] ?? parameterName}: ${topicLabel}`;
  }

  private invalidateReviewFilterCache(): void {
    this.reviewFilterCache = null;
  }

  private buildSettingsResponse(
    algorithm: AlgorithmRow,
    params: Map<string, ParameterRow>,
  ): TwoTowerSettingsDto {
    const meta = (parameterName: string): ParameterMetaDto => {
      const fallback = DEFAULT_PARAM_DEFINITIONS[parameterName];
      const row = params.get(parameterName);

      if (!row && fallback) {
        this.logger.warn(
          `Missing Two Tower parameter ${parameterName}; returning fallback metadata`,
        );
      }

      const defaultValue = toNumber(row?.default_value, fallback.defaultValue);
      const currentValue = toNumber(
        row?.current_value,
        Number(fallback.currentValue),
      );

      return {
        name: parameterName,
        defaultValue,
        currentValue: this.valueForClient(parameterName, currentValue),
        minValue: toNumber(row?.min_value, fallback.minValue),
        maxValue: toNumber(row?.max_value, fallback.maxValue),
        description: row?.description ?? fallback.description,
      };
    };

    const quotas = {} as Record<IntentKey, Record<SlotKey, ParameterMetaDto>>;
    for (const intent of INTENT_KEYS) {
      quotas[intent] = {} as Record<SlotKey, ParameterMetaDto>;
      for (const slot of SLOT_KEYS) {
        quotas[intent][slot] = meta(quotaParamName(intent, slot));
      }
    }

    return {
      algorithm: {
        id: algorithm.id,
        name: ALGORITHM_NAME,
        description: algorithm.description,
        isActive: Boolean(algorithm.is_active),
        updatedAt: algorithm.updated_at,
      },
      core: {
        defaultTopK: meta(CORE_PARAM_MAP.defaultTopK),
        maxTopK: meta(CORE_PARAM_MAP.maxTopK),
        maxIntents: meta(CORE_PARAM_MAP.maxIntents),
        fetchBufferMultiplier: meta(CORE_PARAM_MAP.fetchBufferMultiplier),
        enableAttractionTravelTypeFilter: meta(
          CORE_PARAM_MAP.enableAttractionTravelTypeFilter,
        ),
        enableDiversityBudget: meta(CORE_PARAM_MAP.enableDiversityBudget),
        moderationBatchIntervalMinutes: meta(
          CORE_PARAM_MAP.moderationBatchIntervalMinutes,
        ),
      },
      quotas,
    };
  }

  private collectChanges(
    dto: UpdateTwoTowerSettingsDto,
    params: Map<string, ParameterRow>,
  ): Change[] {
    const changes: Change[] = [];
    const addChange = (parameterName: string, rawValue: number | boolean) => {
      const row = params.get(parameterName);
      if (!row) {
        throw new BadRequestException(
          `Parameter ${parameterName} has not been seeded`,
        );
      }

      const newValue =
        typeof rawValue === 'boolean' ? (rawValue ? 1 : 0) : rawValue;
      const oldValue = toNumber(row.current_value);
      if (newValue !== oldValue) {
        changes.push({ parameterName, newValue, oldValue });
      }
    };

    for (const [dtoKey, parameterName] of Object.entries(CORE_PARAM_MAP)) {
      const rawValue = dto[dtoKey as keyof UpdateTwoTowerSettingsDto];
      if (rawValue !== undefined) {
        addChange(parameterName, rawValue as number | boolean);
      }
    }

    for (const intent of INTENT_KEYS) {
      const intentQuotas = dto.quotas?.[intent];
      if (!intentQuotas) {
        continue;
      }

      for (const slot of SLOT_KEYS) {
        const value = intentQuotas[slot];
        if (value !== undefined) {
          addChange(quotaParamName(intent, slot), value);
        }
      }
    }

    return changes;
  }

  private validateChanges(
    changes: Change[],
    params: Map<string, ParameterRow>,
  ): void {
    for (const change of changes) {
      const row = params.get(change.parameterName);
      if (!row) {
        throw new BadRequestException(
          `Parameter ${change.parameterName} has not been seeded`,
        );
      }

      if (!Number.isFinite(change.newValue)) {
        throw new BadRequestException(
          `${change.parameterName} must be a number`,
        );
      }

      const minValue = toNumber(row.min_value);
      const maxValue = toNumber(row.max_value);
      if (change.newValue < minValue || change.newValue > maxValue) {
        throw new BadRequestException(
          `${change.parameterName} must be between ${minValue} and ${maxValue}`,
        );
      }

      if (
        BOOLEAN_PARAMS.has(change.parameterName) &&
        ![0, 1].includes(change.newValue)
      ) {
        throw new BadRequestException(
          `${change.parameterName} must be true or false`,
        );
      }

      if (
        INTEGER_PARAMS.has(change.parameterName) &&
        !Number.isInteger(change.newValue)
      ) {
        throw new BadRequestException(
          `${change.parameterName} must be an integer`,
        );
      }
    }

    const nextValue = (parameterName: string) =>
      changes.find((change) => change.parameterName === parameterName)
        ?.newValue ?? toNumber(params.get(parameterName)?.current_value);

    if (
      nextValue(CORE_PARAM_MAP.defaultTopK) > nextValue(CORE_PARAM_MAP.maxTopK)
    ) {
      throw new BadRequestException('default_top_k must be <= max_top_k');
    }

    for (const intent of INTENT_KEYS) {
      const total = SLOT_KEYS.reduce(
        (sum, slot) => sum + nextValue(quotaParamName(intent, slot)),
        0,
      );

      if (total > MAX_INTENT_QUOTA_TOTAL) {
        throw new BadRequestException(
          `Total quota for ${intent} must be <= ${MAX_INTENT_QUOTA_TOTAL}`,
        );
      }
    }
  }

  private valueForClient(
    parameterName: string,
    value: number,
  ): number | boolean {
    if (BOOLEAN_PARAMS.has(parameterName)) {
      return value === 1;
    }

    return value;
  }

  private formatLogValue(value: unknown): string {
    if (typeof value === 'boolean') {
      return value ? 'Bật' : 'Tắt';
    }
    if (typeof value === 'number') {
      return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
    }
    if (value === null || value === undefined) {
      return '-';
    }
    return String(value);
  }

  private buildChangeLogMessage(
    changes: Array<{
      parameter: string;
      oldValue: unknown;
      newValue: unknown;
    }>,
  ): string {
    const details = changes
      .map(
        (change) =>
          `${change.parameter}: ${this.formatLogValue(change.oldValue)} → ${this.formatLogValue(change.newValue)}`,
      )
      .join('; ');

    return `Đã cập nhật ${changes.length} tham số.${details ? ` ${details}` : ''}`;
  }

  private reviewFilterSectionForParameter(parameterName: string): string | null {
    if (
      parameterName === 'topic_other_threshold' ||
      parameterName === 'classifier_confidence_threshold' ||
      parameterName === 'classifier_ambiguity_margin' ||
      parameterName.startsWith('ttl_hours.')
    ) {
      return 'Phân loại đánh giá';
    }
    if (
      parameterName === 'conflict_score_threshold' ||
      parameterName === 'candidate_mode' ||
      parameterName === 'top_k' ||
      parameterName.startsWith('lookback_multiplier.')
    ) {
      return 'Phát hiện xung đột';
    }
    if (
      parameterName === 'promotion_mode' ||
      parameterName.startsWith('window_days.') ||
      parameterName.startsWith('threshold.') ||
      parameterName.startsWith('sim_threshold.')
    ) {
      return 'Quản lý thời gian';
    }
    return null;
  }

  private buildResetLogMessage(changes: Change[]): string {
    const sectionOrder = [
      'Phân loại đánh giá',
      'Phát hiện xung đột',
      'Quản lý thời gian',
    ];
    const sections = sectionOrder.filter((section) =>
      changes.some(
        (change) =>
          this.reviewFilterSectionForParameter(change.parameterName) === section,
      ),
    );

    return sections.length > 0
      ? `Đã khôi phục giá trị mặc định của các tham số [${sections.join(' | ')}]`
      : 'Đã khôi phục giá trị mặc định của các tham số';
  }

  private async insertLog(
    algorithmId: string,
    status: 'success' | 'failed',
    action: 'updated' | 'reset',
    details: Record<string, unknown>,
  ): Promise<void> {
    const statusValue = status === 'failed' ? 'failed' : 'active';
    const actionValue = 'parameter_changed';
    const { error } = await supabase
      .schema('ai_config')
      .from('algorithm_logs')
      .insert({
        algorithm_id: algorithmId,
        status: statusValue,
        action: actionValue,
        details: JSON.stringify({
          requestedAction: action,
          ...details,
        }),
      });

    if (error) {
      this.throwIfSupabaseError(
        error,
        `Could not insert algorithm log with status "${statusValue}" and action "${actionValue}"`,
      );
    }
  }

  private parseDetails(details: string | null): unknown {
    if (!details) {
      return null;
    }

    try {
      return JSON.parse(details);
    } catch {
      return details;
    }
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
