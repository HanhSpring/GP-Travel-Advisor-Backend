export interface TwoTowerRuntimeConfig {
  isActive: boolean;
  defaultTopK: number;
  maxTopK: number;
  maxIntents: number;
  fetchBufferMultiplier: number;
  enableAttractionTravelTypeFilter: boolean;
  enableDiversityBudget: boolean;
  intentQuota: Record<string, Record<string, number>>;
}

export const TWO_TOWER_ALGORITHM_NAME = 'two_tower_retrieval' as const;

export const TWO_TOWER_PARAM_NAMES = {
  defaultTopK: 'default_top_k',
  maxTopK: 'max_top_k',
  maxIntents: 'max_intents',
  fetchBufferMultiplier: 'fetch_buffer_multiplier',
  enableAttractionTravelTypeFilter: 'enable_attraction_travel_type_filter',
  enableDiversityBudget: 'enable_diversity_budget',
} as const;

export const TWO_TOWER_INTENT_NAMES = {
  general: 'Kh\u00e1m ph\u00e1 t\u1ed5ng h\u1ee3p',
  food: '\u1ea8m th\u1ef1c & B\u1ea3n \u0111\u1ecba',
  urban: '\u0110\u00f4 th\u1ecb & Vui ch\u01a1i',
  nature: 'Kh\u00e1m ph\u00e1 & Sinh th\u00e1i',
  beach: 'Ngh\u1ec9 d\u01b0\u1ee1ng & Bi\u1ec3n',
  culture: 'V\u0103n h\u00f3a & L\u1ecbch s\u1eed',
} as const;

export const TWO_TOWER_INTENT_KEYS = [
  'general',
  'food',
  'urban',
  'nature',
  'beach',
  'culture',
] as const;

export const TWO_TOWER_SLOT_KEYS = [
  'attraction',
  'restaurant',
  'cafe',
  'entertainment',
  'accommodation',
] as const;

export type TwoTowerIntentKey = (typeof TWO_TOWER_INTENT_KEYS)[number];
export type TwoTowerSlotKey = (typeof TWO_TOWER_SLOT_KEYS)[number];

export function twoTowerQuotaParamName(
  intentKey: TwoTowerIntentKey,
  slotKey: TwoTowerSlotKey,
): string {
  return `quota_${intentKey}_${slotKey}`;
}

export const DEFAULT_TWO_TOWER_RUNTIME_CONFIG: TwoTowerRuntimeConfig = {
  isActive: true,
  defaultTopK: 100,
  maxTopK: 200,
  maxIntents: 3,
  fetchBufferMultiplier: 2,
  enableAttractionTravelTypeFilter: true,
  enableDiversityBudget: true,
  intentQuota: {
    [TWO_TOWER_INTENT_NAMES.general]: {
      attraction: 4,
      restaurant: 2,
      cafe: 1,
      entertainment: 1,
      accommodation: 1,
    },
    [TWO_TOWER_INTENT_NAMES.food]: {
      attraction: 1,
      restaurant: 4,
      cafe: 2,
      entertainment: 0,
      accommodation: 1,
    },
    [TWO_TOWER_INTENT_NAMES.urban]: {
      attraction: 2,
      restaurant: 2,
      cafe: 1,
      entertainment: 3,
      accommodation: 1,
    },
    [TWO_TOWER_INTENT_NAMES.nature]: {
      attraction: 5,
      restaurant: 2,
      cafe: 0,
      entertainment: 0,
      accommodation: 1,
    },
    [TWO_TOWER_INTENT_NAMES.beach]: {
      attraction: 3,
      restaurant: 2,
      cafe: 1,
      entertainment: 1,
      accommodation: 1,
    },
    [TWO_TOWER_INTENT_NAMES.culture]: {
      attraction: 5,
      restaurant: 2,
      cafe: 1,
      entertainment: 2,
      accommodation: 1,
    },
  },
};
