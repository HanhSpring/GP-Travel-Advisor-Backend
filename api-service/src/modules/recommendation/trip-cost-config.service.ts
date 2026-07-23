import { Injectable, Logger } from '@nestjs/common';
import { supabase } from '../../config/supabase';

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

export type TransportMode = 'motorbike' | 'car' | 'taxi' | 'truck';
export type CapacityMode = 'motorbike' | 'car';

export interface TripCostConfig {
  childPriceRatio: number;
  /** VND/km fuel cost for ONE vehicle of that mode (self-drive). */
  transportCostPerKm: Record<TransportMode, number>;
  transportCostPerKmDefault: number;
  /** Seats per vehicle, used to compute how many vehicles a group needs. */
  vehicleCapacity: Record<CapacityMode, number>;
  /** VND/ngày/người lớn — mốc sàn dùng thay cho budget=0 khi retry lịch
   * trình bị infeasible vì ngân sách quá thấp, để plan retry vẫn hướng tới
   * rẻ nhất-khả-thi thay vì bỏ qua chi phí hoàn toàn. */
  minDailyBudgetFloor: number;
  /** VND/đêm/người — mốc sàn CHỖ Ở, tách riêng khỏi minDailyBudgetFloor
   * (đó là mốc sàn cho tham quan/ăn uống). Chỉ cộng thêm cho (số ngày - 1)
   * đêm — chuyến 1 ngày (đi về trong ngày) không qua đêm nên không cần mốc
   * này. Khớp FALLBACK_HOTEL_COST_PER_NIGHT/ROOM_CAPACITY bên ai-service
   * (planner.py) — dùng khi 1 khách sạn cụ thể chưa có giá riêng. */
  minHotelNightFloor: number;
}

// Same `ai_config` schema already used by TwoTowerConfigService and the
// admin algorithm-settings module — a new algorithm row, not a new
// integration. Shared between ai-service (Python) and this service so the
// child-price ratio, per-km fuel cost, and vehicle capacity can never drift
// apart between the two.
const ALGORITHM_NAME = 'trip_cost_config';
const ALGORITHM_DESCRIPTION =
  'Tham số chi phí chuyến đi dùng chung ai-service/api-service';

const PARAM_CHILD_PRICE_RATIO = 'child_price_ratio';
// Canonical mode keys shared with ai-service's trip_cost_config_service.py.
// TransportMode.ROAD (create-itinerary.dto.ts) maps onto "car" — the old
// SELF_DRIVE_TRANSPORT_COST_PER_KM already treated ROAD and CAR identically.
const TRANSPORT_MODES: readonly TransportMode[] = [
  'motorbike',
  'car',
  'taxi',
  'truck',
];
// Only motorbike/car are reachable in practice (dto.transportMode only maps
// to these two for self-drive); taxi/truck have no capacity concept here.
const CAPACITY_MODES: readonly CapacityMode[] = ['motorbike', 'car'];
const PARAM_TRANSPORT_PREFIX = 'transport_cost_per_km_';
const PARAM_TRANSPORT_DEFAULT = 'transport_cost_per_km_default';
const PARAM_CAPACITY_PREFIX = 'vehicle_capacity_';
const PARAM_MIN_DAILY_BUDGET_FLOOR = 'min_daily_budget_floor';
const PARAM_MIN_HOTEL_NIGHT_FLOOR = 'min_hotel_night_floor';

const DEFAULTS: Record<string, number> = {
  [PARAM_CHILD_PRICE_RATIO]: 0.7,
  // Ban đầu 300k (dựa theo chi phí quán ăn quan sát trong log debug 2026-07:
  // ~60k-180k/bữa × 2 bữa) — nhưng không tính tới vé vào cửa/hoạt động có
  // thể rất rẻ (VD Thảo Cầm Viên ~50-60k, Chợ Bến Thành đi dạo miễn phí),
  // khiến 1 chuyến thực tế ~100k/ngày vẫn hợp lý bị từ chối oan. Hạ xuống
  // 150k (2026-07-22, theo yêu cầu chủ dự án) — chừa biên an toàn hơn ví dụ
  // 100k phòng khi có ngày khác đắt hơn trong cùng chuyến, vẫn rẻ hơn hẳn
  // mức 300k cũ. Admin có thể chỉnh qua current_value không cần deploy lại,
  // giống mọi param khác trong file này.
  [PARAM_MIN_DAILY_BUDGET_FLOOR]: 150_000,
  // Khớp FALLBACK_HOTEL_COST_PER_NIGHT (400_000) / ROOM_CAPACITY (2) bên
  // ai-service/planner.py — giá phòng tối thiểu giả định khi 1 khách sạn cụ
  // thể chưa có estimated_cost riêng.
  [PARAM_MIN_HOTEL_NIGHT_FLOOR]: 200_000,
  // Cập nhật theo yêu cầu chủ dự án (2026-07-14): giá xăng xe/ô tô thực tế
  // đã tăng so với mức cấu hình cũ (450/520). Đây là giá cho MỘT xe — nhân
  // số xe cần dùng ở estimateSelfDriveTransportCost(), không nhân theo đầu
  // người trực tiếp.
  transport_cost_per_km_motorbike: 600,
  transport_cost_per_km_car: 1800,
  transport_cost_per_km_taxi: 18000,
  transport_cost_per_km_truck: 20000,
  [PARAM_TRANSPORT_DEFAULT]: 10000,
  vehicle_capacity_motorbike: 2,
  vehicle_capacity_car: 4,
};
const DESCRIPTIONS: Record<string, string> = {
  [PARAM_CHILD_PRICE_RATIO]:
    'Tỷ lệ giá trẻ em so với người lớn (vé/ăn uống và khách sạn)',
  transport_cost_per_km_motorbike: 'VND/km xăng xe máy tự lái (1 xe)',
  transport_cost_per_km_car: 'VND/km xăng ô tô tự lái (1 xe)',
  transport_cost_per_km_taxi: 'VND/km cho taxi',
  transport_cost_per_km_truck: 'VND/km cho xe tải',
  [PARAM_TRANSPORT_DEFAULT]: 'VND/km mặc định khi không rõ phương tiện',
  vehicle_capacity_motorbike: 'Số người tối đa mỗi xe máy',
  vehicle_capacity_car: 'Số người tối đa mỗi ô tô (xe 4 chỗ)',
  [PARAM_MIN_DAILY_BUDGET_FLOOR]:
    'VND/ngày/người lớn — mốc sàn chi phí tối thiểu dùng khi ngân sách nhập vào quá thấp để tạo lịch trình',
  [PARAM_MIN_HOTEL_NIGHT_FLOOR]:
    'VND/đêm/người — mốc sàn chỗ ở tối thiểu, chỉ áp dụng cho chuyến từ 2 ngày trở lên',
};
const MIN_MAX: Partial<Record<string, [number, number]>> = {
  [PARAM_CHILD_PRICE_RATIO]: [0, 1],
  vehicle_capacity_motorbike: [1, 10],
  vehicle_capacity_car: [1, 16],
  [PARAM_MIN_DAILY_BUDGET_FLOOR]: [1, 10_000_000],
  [PARAM_MIN_HOTEL_NIGHT_FLOOR]: [1, 10_000_000],
};

const DEFAULT_CONFIG: TripCostConfig = {
  childPriceRatio: DEFAULTS[PARAM_CHILD_PRICE_RATIO],
  transportCostPerKm: {
    motorbike: DEFAULTS.transport_cost_per_km_motorbike,
    car: DEFAULTS.transport_cost_per_km_car,
    taxi: DEFAULTS.transport_cost_per_km_taxi,
    truck: DEFAULTS.transport_cost_per_km_truck,
  },
  transportCostPerKmDefault: DEFAULTS[PARAM_TRANSPORT_DEFAULT],
  vehicleCapacity: {
    motorbike: DEFAULTS.vehicle_capacity_motorbike,
    car: DEFAULTS.vehicle_capacity_car,
  },
  minDailyBudgetFloor: DEFAULTS[PARAM_MIN_DAILY_BUDGET_FLOOR],
  minHotelNightFloor: DEFAULTS[PARAM_MIN_HOTEL_NIGHT_FLOOR],
};

@Injectable()
export class TripCostConfigService {
  private readonly logger = new Logger(TripCostConfigService.name);
  private cached: TripCostConfig | null = null;
  private cachedAt = 0;
  private readonly cacheTtlMs = 60_000;

  async getConfig(): Promise<TripCostConfig> {
    const now = Date.now();
    if (this.cached && now - this.cachedAt < this.cacheTtlMs) {
      return this.cached;
    }

    try {
      const config = await this.loadFromDb();
      this.cached = config;
      this.cachedAt = now;
      return config;
    } catch (err: any) {
      const message = err?.message ?? String(err);
      this.logger.warn(
        `Failed to load trip cost config, using defaults: ${message}`,
      );
      this.cached = DEFAULT_CONFIG;
      this.cachedAt = now;
      return DEFAULT_CONFIG;
    }
  }

  invalidateCache(): void {
    this.cached = null;
    this.cachedAt = 0;
  }

  /** Số xe cần dùng cho cả đoàn = ceil(số người / sức chứa mỗi xe). Xăng xe
   * là chi phí theo XE, không phải theo NGƯỜI. */
  vehiclesNeeded(headcount: number, mode: CapacityMode, config: TripCostConfig): number {
    const capacity = config.vehicleCapacity[mode] || DEFAULTS[`${PARAM_CAPACITY_PREFIX}${mode}`];
    return Math.max(1, Math.ceil(Math.max(1, headcount) / capacity));
  }

  private async ensureAlgorithm(): Promise<AlgorithmRow> {
    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithms')
      .select('id,name,is_active')
      .eq('name', ALGORITHM_NAME)
      .maybeSingle();
    if (error) {
      throw new Error(error.message);
    }
    if (data) {
      return data as AlgorithmRow;
    }

    const { data: inserted, error: insertError } = await supabase
      .schema('ai_config')
      .from('algorithms')
      .insert({
        name: ALGORITHM_NAME,
        description: ALGORITHM_DESCRIPTION,
        is_active: true,
      })
      .select('id,name,is_active')
      .single();
    if (insertError) {
      throw new Error(insertError.message);
    }
    return inserted as AlgorithmRow;
  }

  private async ensureParam(
    algorithmId: string,
    name: string,
  ): Promise<ParameterRow> {
    const { data, error } = await supabase
      .schema('ai_config')
      .from('algorithm_parameters')
      .select('parameter_name,default_value,current_value')
      .eq('algorithm_id', algorithmId)
      .eq('parameter_name', name)
      .maybeSingle();
    if (error) {
      throw new Error(error.message);
    }

    const codeDefault = DEFAULTS[name];

    if (data) {
      const dbDefault = Number(data.default_value);
      // Reconcile: if the code's default changed since this row was seeded
      // (e.g. corrected fuel-price estimate), refresh the DB default, and
      // only follow through on current_value if nobody customized it away
      // from the old default (preserve manual admin overrides).
      if (!Number.isFinite(dbDefault) || Math.abs(dbDefault - codeDefault) > 1e-9) {
        const currentValue = Number(data.current_value);
        const patchBody: Record<string, unknown> = { default_value: codeDefault };
        if (
          !Number.isFinite(currentValue) ||
          (Number.isFinite(dbDefault) && Math.abs(currentValue - dbDefault) < 1e-9)
        ) {
          patchBody.current_value = codeDefault;
        }
        const { data: patched, error: patchError } = await supabase
          .schema('ai_config')
          .from('algorithm_parameters')
          .update(patchBody)
          .eq('algorithm_id', algorithmId)
          .eq('parameter_name', name)
          .select('parameter_name,default_value,current_value')
          .single();
        if (!patchError && patched) {
          return patched as ParameterRow;
        }
      }
      return data as ParameterRow;
    }

    const minMax = MIN_MAX[name];
    const insertBody: Record<string, unknown> = {
      algorithm_id: algorithmId,
      parameter_name: name,
      default_value: codeDefault,
      current_value: codeDefault,
      description: DESCRIPTIONS[name] ?? '',
    };
    if (minMax) {
      insertBody.min_value = minMax[0];
      insertBody.max_value = minMax[1];
    }
    const { data: inserted, error: insertError } = await supabase
      .schema('ai_config')
      .from('algorithm_parameters')
      .insert(insertBody)
      .select('parameter_name,default_value,current_value')
      .single();
    if (insertError) {
      throw new Error(insertError.message);
    }
    return inserted as ParameterRow;
  }

  private async loadFromDb(): Promise<TripCostConfig> {
    const algorithm = await this.ensureAlgorithm();
    const paramNames = [
      PARAM_CHILD_PRICE_RATIO,
      PARAM_TRANSPORT_DEFAULT,
      PARAM_MIN_DAILY_BUDGET_FLOOR,
      PARAM_MIN_HOTEL_NIGHT_FLOOR,
      ...TRANSPORT_MODES.map((mode) => `${PARAM_TRANSPORT_PREFIX}${mode}`),
      ...CAPACITY_MODES.map((mode) => `${PARAM_CAPACITY_PREFIX}${mode}`),
    ];

    const params = new Map<string, ParameterRow>();
    for (const name of paramNames) {
      params.set(name, await this.ensureParam(algorithm.id, name));
    }

    const readNumber = (name: string): number => {
      const row = params.get(name);
      const value = Number(
        row?.current_value ?? row?.default_value ?? DEFAULTS[name],
      );
      return Number.isFinite(value) ? value : DEFAULTS[name];
    };

    return {
      childPriceRatio: readNumber(PARAM_CHILD_PRICE_RATIO),
      transportCostPerKm: {
        motorbike: readNumber(`${PARAM_TRANSPORT_PREFIX}motorbike`),
        car: readNumber(`${PARAM_TRANSPORT_PREFIX}car`),
        taxi: readNumber(`${PARAM_TRANSPORT_PREFIX}taxi`),
        truck: readNumber(`${PARAM_TRANSPORT_PREFIX}truck`),
      },
      transportCostPerKmDefault: readNumber(PARAM_TRANSPORT_DEFAULT),
      vehicleCapacity: {
        motorbike: Math.max(1, Math.round(readNumber(`${PARAM_CAPACITY_PREFIX}motorbike`))),
        car: Math.max(1, Math.round(readNumber(`${PARAM_CAPACITY_PREFIX}car`))),
      },
      minDailyBudgetFloor: readNumber(PARAM_MIN_DAILY_BUDGET_FLOOR),
      minHotelNightFloor: readNumber(PARAM_MIN_HOTEL_NIGHT_FLOOR),
    };
  }
}
