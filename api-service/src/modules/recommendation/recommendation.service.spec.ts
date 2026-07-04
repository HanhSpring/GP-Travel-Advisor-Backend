import { supabase } from '../../config/supabase';
import { RecommendationService } from './recommendation.service';
import { MlClientService } from './ml-client.service';
import { CreateItineraryDto } from '../itinerary/dto/create-itinerary.dto';
import {
  DEFAULT_TWO_TOWER_RUNTIME_CONFIG,
  TwoTowerRuntimeConfig,
} from './two-tower-config.types';

jest.mock('../../config/supabase', () => ({
  supabase: {
    schema: jest.fn(),
    rpc: jest.fn(),
  },
}));

const schemaMock = supabase.schema as jest.Mock;
const rpcMock = supabase.rpc as jest.Mock;

function activityLogsBuilder(data: any[] | null, error: { message: string } | null = null) {
  const builder: any = {
    select: jest.fn(),
    eq: jest.fn(),
    not: jest.fn(),
    order: jest.fn(),
    limit: jest.fn().mockResolvedValue({ data, error }),
  };
  ['select', 'eq', 'not', 'order'].forEach((key) => {
    builder[key].mockReturnValue(builder);
  });
  return builder;
}

function placesSelectBuilder(data: any[] | null, error: { message: string } | null = null) {
  const builder: any = {
    select: jest.fn(),
    in: jest.fn().mockResolvedValue({ data, error }),
  };
  builder.select.mockReturnValue(builder);
  return builder;
}

function createCacheMock() {
  const store = new Map<string, unknown>();
  return {
    get: jest.fn((key: string) => Promise.resolve(store.get(key))),
    set: jest.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    del: jest.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
  };
}

describe('RecommendationService.getUserHistory', () => {
  let cache: ReturnType<typeof createCacheMock>;
  let service: RecommendationService;

  beforeEach(() => {
    jest.clearAllMocks();
    cache = createCacheMock();
    service = new RecommendationService({} as MlClientService, cache as any);
  });

  it('trả history rỗng cho user cold-start (không có activity_logs nào)', async () => {
    const builder = activityLogsBuilder([]);
    schemaMock.mockReturnValueOnce({ from: () => builder });

    const history = await service.getUserHistory('cold-user');

    expect(history).toEqual({ types: [], vibes: [], bizIds: [] });
    expect(builder.eq).toHaveBeenCalledWith('tourist_id', 'cold-user');
    expect(cache.set).toHaveBeenCalledWith(
      'user_history:cold-user',
      { types: [], vibes: [], bizIds: [] },
      5 * 60 * 1000,
    );
  });

  it('trả history rỗng khi Supabase trả lỗi (fail-safe, không throw)', async () => {
    const builder = activityLogsBuilder(null, { message: 'db down' });
    schemaMock.mockReturnValueOnce({ from: () => builder });

    const history = await service.getUserHistory('any-user');

    expect(history).toEqual({ types: [], vibes: [], bizIds: [] });
  });

  it('map đúng place_id/type/vibes từ activity_logs khi user có lịch sử', async () => {
    const rows = [
      {
        place_id: 'place-1',
        action_type: 'view',
        created_at: '2026-07-04T10:00:00',
        places: {
          type_id: 'type-a',
          vibes: ['Biển', 'Thư giãn'],
          types: { name: 'Resort' },
        },
      },
      {
        place_id: 'place-2',
        action_type: 'click',
        created_at: '2026-07-03T10:00:00',
        places: {
          type_id: 'type-b',
          vibes: ['Biển'],
          types: { name: 'Nhà hàng' },
        },
      },
      // place không kèm places (defensive: place bị xoá/join null) — không được làm crash
      {
        place_id: 'place-3',
        action_type: 'save',
        created_at: '2026-07-02T10:00:00',
        places: null,
      },
    ];
    const builder = activityLogsBuilder(rows);
    schemaMock.mockReturnValueOnce({ from: () => builder });

    const history = await service.getUserHistory('warm-user');

    expect(history.bizIds).toEqual(['place-1', 'place-2', 'place-3']);
    expect(history.types.sort()).toEqual(['Nhà hàng', 'Resort'].sort());
    expect(history.vibes.sort()).toEqual(['Biển', 'Thư giãn'].sort());
    expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(builder.limit).toHaveBeenCalledWith(30);
  });

  it('cache hoạt động: lần gọi thứ 2 cùng userId không query lại Supabase', async () => {
    const rows = [
      {
        place_id: 'place-1',
        action_type: 'view',
        created_at: '2026-07-04T10:00:00',
        places: { type_id: 'type-a', vibes: ['Biển'], types: { name: 'Resort' } },
      },
    ];
    const builder = activityLogsBuilder(rows);
    schemaMock.mockReturnValueOnce({ from: () => builder });

    const first = await service.getUserHistory('warm-user');
    const second = await service.getUserHistory('warm-user');

    expect(schemaMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(cache.get).toHaveBeenCalledWith('user_history:warm-user');
  });

  it('user khác nhau dùng cache key khác nhau (không trộn lịch sử giữa các user)', async () => {
    const builderA = activityLogsBuilder([]);
    const builderB = activityLogsBuilder([]);
    schemaMock
      .mockReturnValueOnce({ from: () => builderA })
      .mockReturnValueOnce({ from: () => builderB });

    await service.getUserHistory('user-a');
    await service.getUserHistory('user-b');

    expect(schemaMock).toHaveBeenCalledTimes(2);
    expect(builderA.eq).toHaveBeenCalledWith('tourist_id', 'user-a');
    expect(builderB.eq).toHaveBeenCalledWith('tourist_id', 'user-b');
  });
});

describe('RecommendationService.getTop20PlaceIdsByCategory / fetchPopularityMeta — Top-20 đúng theo category thật', () => {
  let cache: ReturnType<typeof createCacheMock>;
  let service: RecommendationService;

  beforeEach(() => {
    jest.clearAllMocks();
    cache = createCacheMock();
    service = new RecommendationService({} as MlClientService, cache as any);
  });

  it('getTop20PlaceIdsByCategory gọi ĐÚNG RPC get_place_popularity_stats với p_limit=20 + p_category_name (khớp dashboard)', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ place_id: 'place-1' }, { place_id: 'place-2' }],
      error: null,
    });

    const set = await (service as any).getTop20PlaceIdsByCategory('Nhà hàng');

    expect(rpcMock).toHaveBeenCalledWith('get_place_popularity_stats', {
      p_limit: 20,
      p_mode: 'top',
      p_category_name: 'Nhà hàng',
    });
    expect(set.has('place-1')).toBe(true);
    expect(set.has('place-2')).toBe(true);
  });

  it('getTop20PlaceIdsByCategory cache riêng theo từng category — lần gọi thứ 2 cùng category không query lại RPC', async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ place_id: 'place-1' }], error: null });

    const first = await (service as any).getTop20PlaceIdsByCategory('Nhà hàng');
    const second = await (service as any).getTop20PlaceIdsByCategory('Nhà hàng');

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(cache.set).toHaveBeenCalledWith(
      'place_popularity:top20:Nhà hàng',
      expect.any(Set),
      20 * 60 * 1000,
    );
  });

  it('getTop20PlaceIdsByCategory trả set rỗng (không throw) khi RPC lỗi', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'db down' } });

    const set = await (service as any).getTop20PlaceIdsByCategory('Nhà hàng');

    expect(set.size).toBe(0);
  });

  it('fetchPopularityMeta tra category THẬT qua types(categories(name)) rồi chỉ gọi RPC cho các category khác nhau xuất hiện trong pool', async () => {
    const placesBuilder = placesSelectBuilder([
      { id: 'place-1', average_rating: 4.5, types: { categories: { name: 'Nhà hàng' } } },
      { id: 'place-2', average_rating: 3.0, types: { categories: { name: 'Khách sạn' } } },
      { id: 'place-3', average_rating: 4.0, types: { categories: { name: 'Nhà hàng' } } },
    ]);
    schemaMock.mockReturnValueOnce({ from: () => placesBuilder });
    rpcMock.mockImplementation((_fn: string, params: any) => {
      if (params.p_category_name === 'Nhà hàng') {
        return Promise.resolve({ data: [{ place_id: 'place-1' }], error: null }); // place-3 KHÔNG trong Top 20
      }
      return Promise.resolve({ data: [], error: null }); // 'Khách sạn': place-2 không có ai check-in
    });

    const meta = await (service as any).fetchPopularityMeta(['place-1', 'place-2', 'place-3']);

    // 2 category khác nhau ('Nhà hàng', 'Khách sạn') -> đúng 2 lần gọi RPC, không phải 3 (theo số candidate)
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(meta.get('place-1')).toEqual({ average_rating: 4.5, is_top20_visited: true });
    expect(meta.get('place-2')).toEqual({ average_rating: 3.0, is_top20_visited: false });
    // place-3 cùng category 'Nhà hàng' với place-1 nhưng KHÔNG nằm trong Top 20 trả về
    expect(meta.get('place-3')).toEqual({ average_rating: 4.0, is_top20_visited: false });
  });

  it('fetchPopularityMeta: place không xác định được category (types null) vẫn có average_rating, is_top20_visited=false, không lỗi', async () => {
    const placesBuilder = placesSelectBuilder([
      { id: 'place-1', average_rating: 4.5, types: null },
    ]);
    schemaMock.mockReturnValueOnce({ from: () => placesBuilder });

    const meta = await (service as any).fetchPopularityMeta(['place-1']);

    expect(rpcMock).not.toHaveBeenCalled();
    expect(meta.get('place-1')).toEqual({ average_rating: 4.5, is_top20_visited: false });
  });

  it('fetchPopularityMeta trả map rỗng khi query travel.places lỗi', async () => {
    const placesBuilder = placesSelectBuilder(null, { message: 'db down' });
    schemaMock.mockReturnValueOnce({ from: () => placesBuilder });

    const meta = await (service as any).fetchPopularityMeta(['place-1']);

    expect(meta.size).toBe(0);
  });
});

describe('RecommendationService.planItinerary — nối config xuống retrieveCandidates', () => {
  let cache: ReturnType<typeof createCacheMock>;
  let mlClient: { planItinerary: jest.Mock };
  let service: RecommendationService;

  const dto = {
    userId: 'user-1',
    tripType: 'ROUND_TRIP',
    departureLocationId: 'city-a',
    destinationLocationId: 'city-b',
    transportMode: 'CAR',
    startDate: '2026-07-10',
    endDate: '2026-07-11',
    dailyStartTime: '08:00',
    dailyEndTime: '21:00',
    tripIntent: 'Ẩm thực & Bản địa',
    adultCount: 2,
    childCount: 0,
    budget: 5000000,
    foodPreferences: [],
  } as unknown as CreateItineraryDto;

  // Giả lập config admin đã đổi qua ai_config.algorithm_parameters (VD quota_food_restaurant).
  const adminEditedConfig: TwoTowerRuntimeConfig = {
    ...DEFAULT_TWO_TOWER_RUNTIME_CONFIG,
    intentQuota: {
      ...DEFAULT_TWO_TOWER_RUNTIME_CONFIG.intentQuota,
      'Ẩm thực & Bản địa': {
        ...DEFAULT_TWO_TOWER_RUNTIME_CONFIG.intentQuota['Ẩm thực & Bản địa'],
        restaurant: 7,
      },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    cache = createCacheMock();
    mlClient = { planItinerary: jest.fn().mockResolvedValue({ days: [] }) };
    service = new RecommendationService(mlClient as any, cache as any);

    jest.spyOn(service, 'retrieveCandidates').mockResolvedValue({
      destination_name: 'Đà Lạt',
      city_id: 'city-b',
      total_candidates: 1,
      candidates: [
        {
          place_id: 'place-1',
          place_name: 'Hotel A',
          address: 'addr',
          image_url: null,
          category: 'accommodation',
          cosine_score: 0.9,
          predict_ranking: null,
        },
      ],
    } as any);

    (service as any).fetchPlannerPlaceDetails = jest.fn().mockResolvedValue([
      {
        id: 'place-1',
        place_id: 'place-1',
        place_type: 'hotel',
        estimated_cost: 500_000,
        retrieval_score: 0.9,
        average_rating: 4.5,
      },
      { id: 'place-2', place_id: 'place-2', place_type: 'attraction' },
    ]);
    (service as any).logItineraryRunJson = jest.fn();
  });

  it('truyền đúng config (đọc từ TwoTowerConfigService ở tầng controller) xuống retrieveCandidates', async () => {
    await service.planItinerary(dto, 60, 'scheduler_v2', adminEditedConfig);

    expect(service.retrieveCandidates).toHaveBeenCalledWith(
      dto,
      60,
      adminEditedConfig,
    );
  });

  it('dùng DEFAULT_TWO_TOWER_RUNTIME_CONFIG nếu không truyền config (an toàn ngược)', async () => {
    await service.planItinerary(dto, 60);

    expect(service.retrieveCandidates).toHaveBeenCalledWith(
      dto,
      60,
      DEFAULT_TWO_TOWER_RUNTIME_CONFIG,
    );
  });
});
