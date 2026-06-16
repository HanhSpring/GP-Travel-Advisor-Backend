import { Injectable, Logger } from '@nestjs/common';
import { supabase } from '../../config/supabase';
import {
  DEFAULT_TWO_TOWER_RUNTIME_CONFIG,
  TWO_TOWER_ALGORITHM_NAME,
  TWO_TOWER_INTENT_KEYS,
  TWO_TOWER_INTENT_NAMES,
  TWO_TOWER_PARAM_NAMES,
  TWO_TOWER_SLOT_KEYS,
  TwoTowerRuntimeConfig,
  twoTowerQuotaParamName,
} from './two-tower-config.types';

type AlgorithmRow = {
  id: string;
  name: string;
  is_active: boolean | null;
};

type ParameterRow = {
  parameter_name: string;
  default_value: number | string | null;
  current_value: number | string | null;
};

@Injectable()
export class TwoTowerConfigService {
  private readonly logger = new Logger(TwoTowerConfigService.name);
  private cachedConfig: TwoTowerRuntimeConfig | null = null;
  private cachedAt = 0;
  private readonly cacheTtlMs = 60_000;

  async getConfig(): Promise<TwoTowerRuntimeConfig> {
    const now = Date.now();
    if (this.cachedConfig && now - this.cachedAt < this.cacheTtlMs) {
      return this.cachedConfig;
    }

    try {
      const config = await this.loadFromDb();
      this.cachedConfig = config;
      this.cachedAt = now;
      return config;
    } catch (err: any) {
      const message = err?.message ?? String(err);
      this.logger.warn(
        `Failed to load Two Tower config, using defaults: ${message}`,
      );
      this.cachedConfig = DEFAULT_TWO_TOWER_RUNTIME_CONFIG;
      this.cachedAt = now;
      return DEFAULT_TWO_TOWER_RUNTIME_CONFIG;
    }
  }

  invalidateCache(): void {
    this.cachedConfig = null;
    this.cachedAt = 0;
  }

  private async loadFromDb(): Promise<TwoTowerRuntimeConfig> {
    const { data: algorithm, error: algorithmError } = await supabase
      .schema('ai_config')
      .from('algorithms')
      .select('id,name,is_active')
      .eq('name', TWO_TOWER_ALGORITHM_NAME)
      .maybeSingle();

    if (algorithmError) {
      throw new Error(algorithmError.message);
    }
    if (!algorithm) {
      throw new Error('Two Tower algorithm config has not been seeded');
    }

    const { data: rows, error: paramsError } = await supabase
      .schema('ai_config')
      .from('algorithm_parameters')
      .select('parameter_name,default_value,current_value')
      .eq('algorithm_id', (algorithm as AlgorithmRow).id);

    if (paramsError) {
      throw new Error(paramsError.message);
    }

    const params = new Map(
      ((rows ?? []) as ParameterRow[]).map((row) => [row.parameter_name, row]),
    );

    const defaults = DEFAULT_TWO_TOWER_RUNTIME_CONFIG;
    let maxTopK = this.readInteger(
      params,
      TWO_TOWER_PARAM_NAMES.maxTopK,
      defaults.maxTopK,
      50,
      300,
    );
    let defaultTopK = this.readInteger(
      params,
      TWO_TOWER_PARAM_NAMES.defaultTopK,
      defaults.defaultTopK,
      10,
      200,
    );
    maxTopK = Math.max(maxTopK, 50);
    defaultTopK = Math.min(defaultTopK, maxTopK);

    return {
      isActive: Boolean((algorithm as AlgorithmRow).is_active),
      defaultTopK,
      maxTopK,
      maxIntents: this.readInteger(
        params,
        TWO_TOWER_PARAM_NAMES.maxIntents,
        defaults.maxIntents,
        1,
        6,
      ),
      fetchBufferMultiplier: this.readNumber(
        params,
        TWO_TOWER_PARAM_NAMES.fetchBufferMultiplier,
        defaults.fetchBufferMultiplier,
        1,
        5,
      ),
      enableAttractionTravelTypeFilter: this.readBoolean(
        params,
        TWO_TOWER_PARAM_NAMES.enableAttractionTravelTypeFilter,
        defaults.enableAttractionTravelTypeFilter,
      ),
      enableDiversityBudget: this.readBoolean(
        params,
        TWO_TOWER_PARAM_NAMES.enableDiversityBudget,
        defaults.enableDiversityBudget,
      ),
      intentQuota: this.readIntentQuota(params),
    };
  }

  private readIntentQuota(
    params: Map<string, ParameterRow>,
  ): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {};
    const defaults = DEFAULT_TWO_TOWER_RUNTIME_CONFIG.intentQuota;

    for (const intentKey of TWO_TOWER_INTENT_KEYS) {
      const intentName = TWO_TOWER_INTENT_NAMES[intentKey];
      const defaultQuota = defaults[intentName];
      const hasCompleteGroup = TWO_TOWER_SLOT_KEYS.every((slotKey) =>
        params.has(twoTowerQuotaParamName(intentKey, slotKey)),
      );

      if (!hasCompleteGroup) {
        result[intentName] = { ...defaultQuota };
        continue;
      }

      const quota: Record<string, number> = {};
      for (const slotKey of TWO_TOWER_SLOT_KEYS) {
        quota[slotKey] = this.readInteger(
          params,
          twoTowerQuotaParamName(intentKey, slotKey),
          defaultQuota[slotKey],
          0,
          10,
        );
      }
      result[intentName] = this.enforceQuotaTotal(quota);
    }

    return result;
  }

  private readBoolean(
    params: Map<string, ParameterRow>,
    name: string,
    fallback: boolean,
  ): boolean {
    const value = this.readRawNumber(params, name, fallback ? 1 : 0);
    return value >= 0.5;
  }

  private readInteger(
    params: Map<string, ParameterRow>,
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    return Math.round(this.readNumber(params, name, fallback, min, max));
  }

  private readNumber(
    params: Map<string, ParameterRow>,
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    return this.clamp(this.readRawNumber(params, name, fallback), min, max);
  }

  private readRawNumber(
    params: Map<string, ParameterRow>,
    name: string,
    fallback: number,
  ): number {
    const row = params.get(name);
    const preferred = row?.current_value ?? row?.default_value;
    const numeric = Number(preferred);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  private enforceQuotaTotal(
    quota: Record<string, number>,
  ): Record<string, number> {
    const result = { ...quota };
    let total = Object.values(result).reduce((sum, value) => sum + value, 0);

    for (const slot of [...TWO_TOWER_SLOT_KEYS].reverse()) {
      if (total <= 15) {
        break;
      }
      const current = result[slot] ?? 0;
      const reduction = Math.min(current, total - 15);
      result[slot] = current - reduction;
      total -= reduction;
    }

    return result;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
