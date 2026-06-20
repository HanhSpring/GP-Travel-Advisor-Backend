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
import { UpdateTwoTowerSettingsDto } from './dto/update-two-tower-settings.dto';

const ALGORITHM_NAME = 'two_tower_retrieval' as const;
const MAX_INTENT_QUOTA_TOTAL = 15;

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
    description: 'Interval in minutes between periodic review moderation batch runs',
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

@Injectable()
export class AdminAlgorithmSettingsService {
  private readonly logger = new Logger(AdminAlgorithmSettingsService.name);

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

  private async insertLog(
    algorithmId: string,
    status: 'success' | 'failed',
    action: 'updated' | 'reset',
    details: Record<string, unknown>,
  ): Promise<void> {
    const statusValue = status === 'failed' ? 'failed' : 'active';
    const actionValue = action === 'updated' ? 'updated' : 'parameter_changed';
    const { error } = await supabase
      .schema('ai_config')
      .from('algorithm_logs')
      .insert({
        algorithm_id: algorithmId,
        status: statusValue,
        action: actionValue,
        details: JSON.stringify({
          ...details,
          requestedAction: action,
        }),
      });

    if (error) {
      this.logger.warn(
        `Could not insert algorithm log with status "${statusValue}" and action "${actionValue}": ${error.message}`,
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
