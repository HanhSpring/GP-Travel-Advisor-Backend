export interface PlaceCandidate {
  place_id: string;
  place_name: string;
  address: string | null;
  image_url: string | null;
  /** slot_type from DB/RPC: attraction | restaurant | cafe | entertainment | accommodation | shopping */
  category: string;
  /** type_name from DB, used only as fallback when slot_type is missing/unknown. */
  type_name?: string;
  score: number;
}

export const INTENT_QUOTA: Record<string, Record<string, number>> = {
  'Khám phá tổng hợp': {
    attraction: 4,
    restaurant: 2,
    cafe: 1,
    entertainment: 1,
    accommodation: 1,
  },
  'Ẩm thực & Bản địa': {
    attraction: 1,
    restaurant: 4,
    cafe: 2,
    entertainment: 0,
    accommodation: 1,
  },
  'Đô thị & Vui chơi': {
    attraction: 2,
    restaurant: 2,
    cafe: 1,
    entertainment: 3,
    accommodation: 1,
  },
  'Khám phá & Sinh thái': {
    attraction: 5,
    restaurant: 2,
    cafe: 0,
    entertainment: 0,
    accommodation: 1,
  },
  'Nghỉ dưỡng & Biển': {
    attraction: 3,
    restaurant: 2,
    cafe: 1,
    entertainment: 1,
    accommodation: 1,
  },
  'Văn hóa & Lịch sử': {
    attraction: 5,
    restaurant: 2,
    cafe: 1,
    entertainment: 1,
    accommodation: 1,
  },
};

// "Khám phá tổng hợp" nghĩa là user KHÔNG chọn loại hình cụ thể — không phải
// một travel_type thật trong DB, nên không được dùng để lọc attraction theo
// p_travel_type (places chỉ được gắn các nhãn cụ thể như "Văn hóa & Di sản",
// "Tham quan & Khám phá"...). Lọc theo đúng chuỗi này sẽ bóp hẹp pool sai mục đích.
const GENERAL_INTENT = 'Khám phá tổng hợp';

const DEFAULT_QUOTA = {
  attraction: 4,
  restaurant: 2,
  cafe: 1,
  entertainment: 1,
  accommodation: 1,
};
export interface RetrievalTuning {
  intentQuota?: Record<string, Record<string, number>>;
  fetchBufferMultiplier?: number;
  enableAttractionTravelTypeFilter?: boolean;
  enableDiversityBudget?: boolean;
}

const KNOWN_SLOT_TYPES = new Set([
  'attraction',
  'restaurant',
  'cafe',
  'entertainment',
  'accommodation',
  'hotel',
  'shopping',
]);

const TRAVEL_TYPE_SLOT: Record<string, string> = {
  'Ẩm thực': 'restaurant',
  'Giải trí & Vui chơi': 'entertainment',
  'Thư giãn & Thể thao': 'entertainment',
  'Văn hóa & Di sản': 'attraction',
  'Lưu trú': 'accommodation',
  'Tham quan & Khám phá': 'attraction',
  'Mua sắm & Dịch vụ': 'shopping',
  'Cafe & Đồ uống': 'cafe',
  'Tiệm bánh & Tráng miệng': 'cafe',
  'Pub/Bar': 'entertainment',
  'Ẩm thực & Bản địa': 'restaurant',
  'Đô thị & Vui chơi': 'entertainment',
  'Khám phá & Sinh thái': 'attraction',
  'Khám phá tổng hợp': 'attraction',
  'Nghỉ dưỡng & Biển': 'attraction',
  'Văn hóa & Lịch sử': 'attraction',
};

export interface SlotFetchPlan {
  slotType: string;
  limit: number;
  travelType?: string;
  dailyTarget?: number;
  reason?: string;
}

export interface PlannerTargets {
  availableMinutes: number;
  dailyQuota: Record<string, number>;
  notes: string[];
}

export function normalizeCategory(category: string, typeName?: string): string {
  const raw = (category ?? '').trim();
  const lower = raw.toLowerCase();
  if (KNOWN_SLOT_TYPES.has(lower)) {
    return lower === 'hotel' ? 'accommodation' : lower;
  }

  if (typeName) {
    const typeSlot = TRAVEL_TYPE_SLOT[typeName.trim()];
    if (typeSlot) return typeSlot;
  }

  if (TRAVEL_TYPE_SLOT[raw]) return TRAVEL_TYPE_SLOT[raw];

  if (
    lower.includes('cafe') ||
    lower.includes('coffee') ||
    lower.includes('cà phê') ||
    lower.includes('trà sữa')
  ) {
    return 'cafe';
  }
  if (
    lower.includes('ẩm thực') ||
    lower.includes('nhà hàng') ||
    lower.includes('quán ăn') ||
    lower.includes('buffet') ||
    lower.includes('restaurant') ||
    lower.includes('food')
  ) {
    return 'restaurant';
  }
  if (
    lower.includes('giải trí') ||
    lower.includes('vui chơi') ||
    lower.includes('entertainment') ||
    lower.includes('bar') ||
    lower.includes('pub') ||
    lower.includes('karaoke') ||
    lower.includes('rạp phim') ||
    lower.includes('spa')
  ) {
    return 'entertainment';
  }
  if (
    lower.includes('lưu trú') ||
    lower.includes('hotel') ||
    lower.includes('khách sạn') ||
    lower.includes('accommodation') ||
    lower.includes('resort') ||
    lower.includes('homestay')
  ) {
    return 'accommodation';
  }
  if (
    lower.includes('mua sắm') ||
    lower.includes('shopping') ||
    lower.includes('dịch vụ')
  ) {
    return 'shopping';
  }
  return 'attraction';
}

function getQuotaForIntent(
  intent: string,
  tuning: RetrievalTuning,
): Record<string, number> {
  return tuning.intentQuota?.[intent] ?? INTENT_QUOTA[intent] ?? DEFAULT_QUOTA;
}

export function getDailyQuota(
  tripIntent: string,
  tuning: RetrievalTuning = {},
): Record<string, number> {
  const intents = parseTripIntents(tripIntent);
  if (intents.length === 0) {
    return DEFAULT_QUOTA;
  }
  if (intents.length === 1) {
    return getQuotaForIntent(intents[0], tuning);
  }

  const merged: Record<string, number> = {};
  const slots = new Set<string>();
  for (const intent of intents) {
    for (const slot of Object.keys(getQuotaForIntent(intent, tuning))) {
      slots.add(slot);
    }
  }
  for (const slot of slots) {
    const total = intents.reduce(
      (sum, intent) => sum + (getQuotaForIntent(intent, tuning)[slot] ?? 0),
      0,
    );
    merged[slot] = Math.ceil(total / intents.length);
  }
  return { ...DEFAULT_QUOTA, ...merged };
}

export const VALID_TRIP_INTENTS = new Set(Object.keys(INTENT_QUOTA));

export function parseTripIntents(tripIntent: string): string[] {
  const seen = new Set<string>();
  return (tripIntent ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => {
      if (!VALID_TRIP_INTENTS.has(value) || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

export function dedupeByPlaceIdKeepBestScore(
  candidates: PlaceCandidate[],
): PlaceCandidate[] {
  const byId = new Map<string, PlaceCandidate>();

  for (const candidate of candidates) {
    const existing = byId.get(candidate.place_id);
    if (!existing || candidate.score > existing.score) {
      byId.set(candidate.place_id, candidate);
    }
  }

  return [...byId.values()].sort((a, b) => b.score - a.score);
}

function parseTimeToMinutes(value?: string): number | null {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(value ?? '');
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23) return null;
  return hours * 60 + minutes;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function overlaps(
  start: number,
  end: number,
  windowStart: number,
  windowEnd: number,
): boolean {
  return Math.max(start, windowStart) < Math.min(end, windowEnd);
}

export function getPlannerTargets(
  tripIntent: string,
  dailyStartTime = '08:00',
  dailyEndTime = '21:00',
): PlannerTargets {
  const start = parseTimeToMinutes(dailyStartTime) ?? 480;
  const end = parseTimeToMinutes(dailyEndTime) ?? 1260;
  const availableMinutes = Math.max(0, end - start);
  const baseQuota = getDailyQuota(tripIntent);
  const hasLunchWindow = overlaps(start, end, 11 * 60 + 30, 13 * 60 + 30);
  const restaurantTarget = hasLunchWindow ? 1 : 0;

  // This only sizes the candidate pool. The GA still uses DB visit_duration,
  // Goong travel time, opening hours, and lunch feasibility to build the route.
  const nonFoodAvailable = Math.max(
    0,
    availableMinutes - restaurantTarget * 80,
  );
  const minNonFood = availableMinutes >= 360 ? 2 : 1;
  const nonFoodTarget = clamp(
    Math.floor(nonFoodAvailable / 130),
    minNonFood,
    7,
  );
  const nonFoodSlots = ['attraction', 'cafe', 'entertainment'];
  const baseNonFoodTotal =
    nonFoodSlots.reduce((sum, slot) => sum + (baseQuota[slot] ?? 0), 0) || 1;
  const dailyQuota: Record<string, number> = {
    attraction: 0,
    restaurant: restaurantTarget,
    cafe: 0,
    entertainment: 0,
    accommodation: 1,
  };

  let assigned = 0;
  for (const slot of nonFoodSlots) {
    const value = Math.floor(
      ((baseQuota[slot] ?? 0) / baseNonFoodTotal) * nonFoodTarget,
    );
    dailyQuota[slot] = value;
    assigned += value;
  }
  while (assigned < nonFoodTarget) {
    const slot = [...nonFoodSlots].sort((a, b) => {
      const aFrac =
        ((baseQuota[a] ?? 0) / baseNonFoodTotal) * nonFoodTarget -
        dailyQuota[a];
      const bFrac =
        ((baseQuota[b] ?? 0) / baseNonFoodTotal) * nonFoodTarget -
        dailyQuota[b];
      return bFrac - aFrac;
    })[0];
    dailyQuota[slot] += 1;
    assigned += 1;
  }

  return {
    availableMinutes,
    dailyQuota,
    notes: [
      'quota is time-aware candidate fetching, not a hard GA daily count',
      'restaurant target currently means lunch; cafe is snack/light stop, not meal',
      'hotel/accommodation is fetched as trip-level options, not per-day visits',
    ],
  };
}

export function getStratifiedFetchPlan(
  tripIntent: string,
  numDays: number,
  tuningOrDailyStartTime: RetrievalTuning | string = '08:00',
  dailyEndTime = '21:00',
): SlotFetchPlan[] {
  const tuning =
    typeof tuningOrDailyStartTime === 'string' ? {} : tuningOrDailyStartTime;
  const targets =
    typeof tuningOrDailyStartTime === 'string'
      ? getPlannerTargets(tripIntent, tuningOrDailyStartTime, dailyEndTime)
      : null;
  const quota = targets?.dailyQuota ?? getDailyQuota(tripIntent, tuning);
  const knownIntents = parseTripIntents(tripIntent);
  const plan: SlotFetchPlan[] = [];
  const multiplier = tuning.fetchBufferMultiplier ?? 2;

  for (const [slot, dailyQ] of Object.entries(quota)) {
    if (dailyQ === 0) continue;
    const limit =
      targets && slot === 'accommodation'
        ? 12
        : Math.max(
            Math.ceil(dailyQ * numDays * (targets ? 3 : multiplier)),
            dailyQ * numDays,
          );
    const entry: SlotFetchPlan = {
      slotType: slot,
      limit,
      dailyTarget: dailyQ,
      reason: targets
        ? slot === 'accommodation'
          ? 'trip-level hotel options'
          : 'time-aware target x 3 buffer'
        : undefined,
    };
    if (
      slot === 'attraction' &&
      knownIntents.length === 1 &&
      knownIntents[0] !== GENERAL_INTENT &&
      tuning.enableAttractionTravelTypeFilter !== false
    ) {
      const primarySlot = TRAVEL_TYPE_SLOT[knownIntents[0]];
      if (targets || primarySlot === 'attraction') {
        entry.travelType = knownIntents[0];
      }
    }
    plan.push(entry);
  }
  return plan;
}

export function diversifyTopK(
  candidates: PlaceCandidate[],
  numDays: number,
  tripIntent: string,
  topK: number,
  tuningOrFetchPlan: RetrievalTuning | SlotFetchPlan[] = {},
): PlaceCandidate[] {
  const fetchPlan = Array.isArray(tuningOrFetchPlan)
    ? tuningOrFetchPlan
    : undefined;
  const tuning = Array.isArray(tuningOrFetchPlan) ? {} : tuningOrFetchPlan;

  if (tuning.enableDiversityBudget === false) {
    return [...candidates]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((candidate) => ({
        ...candidate,
        category: normalizeCategory(candidate.category, candidate.type_name),
      }));
  }

  const dailyQuota = fetchPlan
    ? Object.fromEntries(
        fetchPlan.map((plan) => [plan.slotType, plan.dailyTarget ?? 0]),
      )
    : getDailyQuota(tripIntent, tuning);
  const totalDailySlots =
    Object.values(dailyQuota).reduce((a, b) => a + b, 0) || 1;
  const budgetPerCat: Record<string, number> = {};

  for (const [cat, q] of Object.entries(dailyQuota)) {
    if (q <= 0) continue;
    const proportional = Math.round((q / totalDailySlots) * topK);
    const minimum = q * numDays;
    const fetchLimit = fetchPlan?.find(
      (plan) => normalizeCategory(plan.slotType) === cat,
    )?.limit;
    budgetPerCat[cat] = fetchLimit ?? Math.max(proportional, minimum);
  }

  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const selected: PlaceCandidate[] = [];
  const slotUsed: Record<string, number> = {};
  const remainder: PlaceCandidate[] = [];

  for (const candidate of sorted) {
    const cat = normalizeCategory(candidate.category, candidate.type_name);
    const used = slotUsed[cat] ?? 0;
    const budget = budgetPerCat[cat] ?? 0;
    const normalized = { ...candidate, category: cat };
    if (budget > 0 && used < budget) {
      slotUsed[cat] = used + 1;
      selected.push(normalized);
    } else {
      remainder.push(normalized);
    }
  }

  for (const candidate of remainder) {
    if (selected.length >= topK) break;
    selected.push(candidate);
  }

  selected.sort((a, b) => b.score - a.score);
  return selected.slice(0, topK);
}
