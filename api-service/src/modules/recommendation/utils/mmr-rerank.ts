export interface PlaceCandidate {
  place_id: string;
  place_name: string;
  address: string | null;
  image_url: string | null;
  /** slot_type từ RPC: 'attraction'|'restaurant'|'cafe'|'entertainment'|'accommodation'|'shopping' */
  category: string;
  /** type_name từ types_rows.csv để phân biệt cafe trong Ẩm thực */
  type_name?: string;
  score: number;
}

// Per-day slot quota theo tripIntent — khớp với TRIP_INTENT_OPTIONS trong DTO
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
    entertainment: 2,
    accommodation: 1,
  },
};

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

/**
 * Exact-match map: cả category names (từ categories_rows.csv)
 * lẫn travel_type values (từ training vocab) → slot group.
 * Thứ tự ưu tiên: exact match trước, keyword fallback sau.
 */
const TRAVEL_TYPE_SLOT: Record<string, string> = {
  // ── Category names thực tế trong DB (categories_rows.csv) ──
  'Ẩm thực': 'restaurant',
  'Giải trí & Vui chơi': 'entertainment',
  'Thư giãn & Thể thao': 'entertainment',
  'Văn hóa & Di sản': 'attraction',
  'Lưu trú': 'accommodation',
  'Tham quan & Khám phá': 'attraction',
  'Mua sắm & Dịch vụ': 'shopping',

  // ── Type names cần tách cafe ra khỏi Ẩm thực (types_rows.csv) ──
  'Cafe & Đồ uống': 'cafe',
  'Tiệm bánh & Tráng miệng': 'cafe',
  'Pub/Bar': 'restaurant',

  // ── Training vocab travel_type values (phòng khi travel_type column được dùng) ──
  'Ẩm thực & Bản địa': 'restaurant',
  'Đô thị & Vui chơi': 'entertainment',
  'Khám phá & Sinh thái': 'attraction',
  'Khám phá tổng hợp': 'attraction',
  'Nghỉ dưỡng & Biển': 'attraction',
  'Văn hóa & Lịch sử': 'attraction',
};

/**
 * Chuẩn hóa category/type_name từ DB → slot group.
 * Ưu tiên: type_name (chi tiết hơn) → category name → keyword fallback.
 * Truyền type_name để phân biệt cafe vs restaurant trong category Ẩm thực.
 */
export function normalizeCategory(category: string, typeName?: string): string {
  // Type-level check trước (phân biệt cafe trong category Ẩm thực)
  if (typeName) {
    const typeSlot = TRAVEL_TYPE_SLOT[typeName.trim()];
    if (typeSlot) return typeSlot;
  }

  const trimmed = (category ?? '').trim();
  if (TRAVEL_TYPE_SLOT[trimmed]) return TRAVEL_TYPE_SLOT[trimmed];

  const lower = trimmed.toLowerCase();

  if (
    lower.includes('ẩm thực') ||
    lower.includes('nhà hàng') ||
    lower.includes('quán ăn') ||
    lower.includes('restaurant') ||
    lower.includes('food')
  )
    return 'restaurant';

  if (
    lower.includes('café') ||
    lower.includes('cafe') ||
    lower.includes('cà phê') ||
    lower.includes('coffee')
  )
    return 'cafe';

  if (
    lower.includes('giải trí') ||
    lower.includes('vui chơi') ||
    lower.includes('entertainment') ||
    lower.includes('bar') ||
    lower.includes('pub')
  )
    return 'entertainment';

  if (
    lower.includes('lưu trú') ||
    lower.includes('hotel') ||
    lower.includes('khách sạn') ||
    lower.includes('accommodation') ||
    lower.includes('resort')
  )
    return 'accommodation';

  if (
    lower.includes('mua sắm') ||
    lower.includes('shopping') ||
    lower.includes('dịch vụ')
  )
    return 'shopping';

  return 'attraction';
}

/** Trả về daily quota theo tripIntent */
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

/** Tập các trip_intent hợp lệ trong vocab model v15 */
export const VALID_TRIP_INTENTS = new Set(Object.keys(INTENT_QUOTA));

/**
 * Parse chuỗi comma-separated tripIntent thành mảng các intent hợp lệ.
 * Trim whitespace, bỏ giá trị không thuộc vocab, deduplicate giữ thứ tự.
 */
export function parseTripIntents(tripIntent: string): string[] {
  const seen = new Set<string>();
  return (tripIntent ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => {
      if (!VALID_TRIP_INTENTS.has(v) || seen.has(v)) return false;
      seen.add(v);
      return true;
    });
}

/**
 * Deduplicate candidates theo place_id, giữ bản có score cao nhất.
 * Kết quả sort descending theo score.
 */
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

/**
 * Fetch plan cho 1 slot: gọi recommend_places_by_slot RPC.
 * travelType chỉ truyền cho attraction để filter theo trip_intent.
 */
export interface SlotFetchPlan {
  slotType: string;
  limit: number;
  travelType?: string; // chỉ dùng cho slot attraction
}

/**
 * Trả về fetch plan theo đúng notebook:
 * - Mỗi slot (attraction/restaurant/cafe/entertainment/accommodation) → 1 RPC call riêng
 * - limit = dailyQuota × numDays × 2 (buffer để ANN có lựa chọn)
 * - Attraction filter thêm travelType để khớp trip_intent
 */
export function getStratifiedFetchPlan(
  tripIntent: string,
  numDays: number,
  tuning: RetrievalTuning = {},
): SlotFetchPlan[] {
  const quota = getDailyQuota(tripIntent, tuning);
  const knownIntents = parseTripIntents(tripIntent);
  const plan: SlotFetchPlan[] = [];
  const multiplier = tuning.fetchBufferMultiplier ?? 2;

  for (const [slot, dailyQ] of Object.entries(quota)) {
    if (dailyQ === 0) continue;
    const limit = Math.ceil(dailyQ * numDays * multiplier);
    const entry: SlotFetchPlan = { slotType: slot, limit };
    // Chỉ filter attraction theo travelType khi intent đó có primary slot là 'attraction'.
    // Với "Ẩm thực & Bản địa" (primary=restaurant) hay "Đô thị & Vui chơi" (primary=entertainment),
    // KHÔNG filter → vector search tự tìm attraction phù hợp nhất.
    // Với "Văn hóa & Lịch sử", "Khám phá & Sinh thái", "Nghỉ dưỡng & Biển" (primary=attraction),
    // filter để chỉ lấy attraction có travel_type khớp trong DB.
    if (
      tuning.enableAttractionTravelTypeFilter !== false &&
      slot === 'attraction' &&
      knownIntents.length === 1
    ) {
      const primarySlot = TRAVEL_TYPE_SLOT[knownIntents[0]];
      if (primarySlot === 'attraction') {
        entry.travelType = knownIntents[0];
      }
    }
    plan.push(entry);
  }

  return plan;
}

/**
 * Diversity-aware top-K selection theo 2 phase:
 *
 * Phase 1 — Proportional fill:
 *   Mỗi slot type được cấp budget = max(proportional_share * topK, daily_quota * numDays).
 *   Duyệt danh sách đã sort theo score, thêm vào selected nếu còn budget.
 *
 * Phase 2 — Fill remaining:
 *   Các candidate bị reject ở phase 1 (vượt budget) được thêm vào cho đến khi đủ topK.
 *
 * Kết quả cuối được sort lại theo score descending.
 *
 * candidates: pool lớn (nên >= topK * 3) từ pgvector để đảm bảo đủ từng loại.
 */
export function diversifyTopK(
  candidates: PlaceCandidate[],
  numDays: number,
  tripIntent: string,
  topK: number,
  tuning: RetrievalTuning = {},
): PlaceCandidate[] {
  if (tuning.enableDiversityBudget === false) {
    return [...candidates]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((c) => ({
        ...c,
        category: normalizeCategory(c.category, c.type_name),
      }));
  }

  const dailyQuota = getDailyQuota(tripIntent, tuning);
  const totalDailySlots = Object.values(dailyQuota).reduce((a, b) => a + b, 0);

  // Budget mỗi category: lấy max giữa proportional share và minimum cần thiết
  const budgetPerCat: Record<string, number> = {};
  for (const [cat, q] of Object.entries(dailyQuota)) {
    if (q > 0) {
      const proportional = Math.round((q / totalDailySlots) * topK);
      const minimum = q * numDays;
      budgetPerCat[cat] = Math.max(proportional, minimum);
    }
  }

  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const selected: PlaceCandidate[] = [];
  const slotUsed: Record<string, number> = {};
  const remainder: PlaceCandidate[] = [];

  // Phase 1: fill quota-limited buckets
  for (const c of sorted) {
    const cat = normalizeCategory(c.category, c.type_name);
    const used = slotUsed[cat] ?? 0;
    const budget = budgetPerCat[cat] ?? 0; // shopping / unknown: no reserved budget
    if (budget > 0 && used < budget) {
      slotUsed[cat] = used + 1;
      selected.push({ ...c, category: cat });
    } else {
      remainder.push({
        ...c,
        category: normalizeCategory(c.category, c.type_name),
      });
    }
  }

  // Phase 2: fill up to topK with best-scoring leftovers (already sorted)
  for (const c of remainder) {
    if (selected.length >= topK) break;
    selected.push(c);
  }

  selected.sort((a, b) => b.score - a.score);
  return selected.slice(0, topK);
}
