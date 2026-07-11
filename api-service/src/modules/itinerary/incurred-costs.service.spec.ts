jest.mock('../../config/supabase', () => ({
  supabase: { schema: jest.fn() },
}));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { supabase } from '../../config/supabase';
import { IncurredCostsService, distributeCosts } from './incurred-costs.service';
import { CostType } from './dto/cost-type.enum';

const schemaMock = supabase.schema as jest.Mock;

/**
 * Query builder giả lập vừa chainable (mọi method trả về chính nó) vừa
 * "thenable" (await trực tiếp không cần .single()/.maybeSingle(), giống các
 * query supabase-js thật không gọi .single() ở cuối, ví dụ validatePlaceId).
 */
function makeBuilder(result: { data: any; error: any }) {
  const builder: any = {};
  const chainMethods = [
    'select',
    'eq',
    'neq',
    'in',
    'not',
    'or',
    'order',
    'insert',
    'update',
    'delete',
  ];
  for (const method of chainMethods) {
    builder[method] = jest.fn(() => builder);
  }
  builder.maybeSingle = jest.fn().mockResolvedValue(result);
  builder.single = jest.fn().mockResolvedValue(result);
  builder.then = (resolve: any, reject: any) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

/** Map tên bảng -> kết quả trả về cho MỌI query nhắm vào bảng đó trong 1 test. */
function mockTables(tables: Record<string, { data: any; error: any }>) {
  schemaMock.mockImplementation(() => ({
    from: jest.fn((table: string) =>
      makeBuilder(tables[table] ?? { data: null, error: null }),
    ),
  }));
}

describe('distributeCosts — sharing không được chia nhỏ theo số tài khoản thật', () => {
  // Lịch trình tạo cho 3 người lớn + 1 trẻ em, nhưng chỉ 2 tài khoản thật
  // (owner + 1 member) đã accept share. basePlanCost = chi phí kế hoạch TÍNH
  // THEO 1 NGƯỜI LỚN (đã per-adult từ itinerary.service.ts).
  const memberIds = ['owner-1', 'member-2'];
  const basePlanCost = 500_000;
  const childPriceRatio = 0.7;

  it('mỗi tài khoản thật gánh ĐÚNG basePlanCost — không chia đôi/chia theo memberIds.length', () => {
    const { totals } = distributeCosts(
      memberIds,
      'owner-1',
      1,
      childPriceRatio,
      basePlanCost,
      [],
    );
    expect(totals.get('owner-1')).toBe(basePlanCost);
    expect(totals.get('member-2')).toBe(basePlanCost);
    // Không phải basePlanCost / 2 — đây chính xác là bug đã báo cáo và fix.
    expect(totals.get('owner-1')).not.toBe(basePlanCost / 2);
  });

  it('childrenShare báo riêng cho chủ lịch trình, KHÔNG cộng gộp vào total của owner', () => {
    const { totals, childrenShare, childrenAssignedTo } = distributeCosts(
      memberIds,
      'owner-1',
      1,
      childPriceRatio,
      basePlanCost,
      [],
    );
    expect(childrenAssignedTo).toBe('owner-1');
    expect(childrenShare).toBe(1 * basePlanCost * childPriceRatio);
    // total của owner vẫn chỉ là basePlanCost, không phải basePlanCost + childrenShare.
    expect(totals.get('owner-1')).toBe(basePlanCost);
  });

  it('không có trẻ em thì childrenShare = 0 và childrenAssignedTo = null', () => {
    const { childrenShare, childrenAssignedTo } = distributeCosts(
      memberIds,
      'owner-1',
      0,
      childPriceRatio,
      basePlanCost,
      [],
    );
    expect(childrenShare).toBe(0);
    expect(childrenAssignedTo).toBeNull();
  });

  it('chi phí phát sinh chargedTo=[1 người] chỉ cộng cho đúng người đó', () => {
    const { totals } = distributeCosts(
      memberIds,
      'owner-1',
      0,
      childPriceRatio,
      basePlanCost,
      [{ amount: 50_000, chargedTo: ['member-2'] }],
    );
    expect(totals.get('member-2')).toBe(basePlanCost + 50_000);
    expect(totals.get('owner-1')).toBe(basePlanCost);
  });

  it('chi phí phát sinh chargedTo=[] chia đều cho TẤT CẢ tài khoản thật (không trọng số)', () => {
    const { totals } = distributeCosts(
      memberIds,
      'owner-1',
      0,
      childPriceRatio,
      basePlanCost,
      [{ amount: 100_000, chargedTo: [] }],
    );
    expect(totals.get('owner-1')).toBe(basePlanCost + 50_000);
    expect(totals.get('member-2')).toBe(basePlanCost + 50_000);
  });

  it('chi phí phát sinh chargedTo=[nhiều người] chia đều cho đúng những người đó', () => {
    const threeMembers = ['owner-1', 'member-2', 'member-3'];
    const { totals } = distributeCosts(
      threeMembers,
      'owner-1',
      0,
      childPriceRatio,
      basePlanCost,
      [{ amount: 90_000, chargedTo: ['owner-1', 'member-2'] }],
    );
    expect(totals.get('owner-1')).toBe(basePlanCost + 45_000);
    expect(totals.get('member-2')).toBe(basePlanCost + 45_000);
    expect(totals.get('member-3')).toBe(basePlanCost);
  });

  it('memberIds rỗng trả về totals rỗng, không lỗi', () => {
    const result = distributeCosts([], 'owner-1', 1, childPriceRatio, basePlanCost, []);
    expect(result.totals.size).toBe(0);
    expect(result.childrenShare).toBe(0);
    expect(result.childrenAssignedTo).toBeNull();
  });
});

describe('IncurredCostsService — phân quyền, khoá sau khi hoàn thành, validate số tiền', () => {
  let service: IncurredCostsService;
  let itineraryService: { getItineraryMemberProfiles: jest.Mock };
  let tripCostConfig: { getConfig: jest.Mock };

  const baseItinerary = {
    creator_id: 'owner-1',
    status: 'ongoing',
    adult_count: 3,
    children_count: 1,
    estimated_cost: 1_000_000,
  };

  const memberProfiles = [
    { id: 'owner-1', fullName: 'Chủ', avatarUrl: '', isOwner: true },
    { id: 'member-2', fullName: 'Thành viên 2', avatarUrl: '', isOwner: false },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    itineraryService = {
      getItineraryMemberProfiles: jest.fn().mockResolvedValue(memberProfiles),
    };
    tripCostConfig = {
      getConfig: jest.fn().mockResolvedValue({ childPriceRatio: 0.7 }),
    };
    service = new IncurredCostsService(
      itineraryService as any,
      tripCostConfig as any,
    );
  });

  it('price_adjustment: thành viên không phải chủ lịch trình bị từ chối tạo', async () => {
    mockTables({ itineraries: { data: baseItinerary, error: null } });
    await expect(
      service.createIncurredCost('itin-1', {
        userId: 'member-2',
        type: CostType.DIEU_CHINH_GIA,
        note: 'Sửa giá vé',
        amount: 5000,
        placeId: 'place-1',
      } as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('price_adjustment: bắt buộc phải gắn placeId', async () => {
    mockTables({ itineraries: { data: baseItinerary, error: null } });
    await expect(
      service.createIncurredCost('itin-1', {
        userId: 'owner-1',
        type: CostType.DIEU_CHINH_GIA,
        note: 'Sửa giá vé',
        amount: 5000,
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('số tiền làm tròn xuống dưới 1.000đ bị từ chối', async () => {
    mockTables({ itineraries: { data: baseItinerary, error: null } });
    await expect(
      service.createIncurredCost('itin-1', {
        userId: 'owner-1',
        type: CostType.KHAC,
        note: 'Nước uống',
        amount: 400,
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('lịch trình đã completed thì không cho tạo chi phí mới', async () => {
    mockTables({
      itineraries: {
        data: { ...baseItinerary, status: 'completed' },
        error: null,
      },
    });
    await expect(
      service.createIncurredCost('itin-1', {
        userId: 'owner-1',
        type: CostType.KHAC,
        note: 'Nước uống',
        amount: 20_000,
      } as any),
    ).rejects.toThrow(ConflictException);
  });

  it('không cho gắn chi phí vào địa điểm chưa "đi qua" (chưa có geofence visited)', async () => {
    mockTables({
      itineraries: { data: baseItinerary, error: null },
      itinerary_details: { data: [{ id: 'detail-1' }], error: null },
      geofence_visits: { data: [], error: null },
    });
    await expect(
      service.createIncurredCost('itin-1', {
        userId: 'owner-1',
        type: CostType.KHAC,
        note: 'Mua nước',
        amount: 20_000,
        placeId: 'place-unvisited',
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('chủ lịch trình KHÔNG được sửa chi phí ad-hoc do người khác tạo (không có ngoại lệ owner)', async () => {
    mockTables({
      itineraries: { data: baseItinerary, error: null },
      incurred_costs: {
        data: {
          id: 'cost-1',
          itinerary_id: 'itin-1',
          place_id: null,
          type: CostType.NUOC_UONG,
          note: 'Nước uống',
          amount: 20_000,
          charged_to: [],
          created_by: 'member-2',
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
          updated_by: null,
        },
        error: null,
      },
    });
    await expect(
      service.updateIncurredCost('itin-1', 'cost-1', {
        userId: 'owner-1',
        amount: 30_000,
      } as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('người tạo được sửa chi phí ad-hoc của chính mình', async () => {
    mockTables({
      itineraries: { data: baseItinerary, error: null },
      incurred_costs: {
        data: {
          id: 'cost-1',
          itinerary_id: 'itin-1',
          place_id: null,
          type: CostType.NUOC_UONG,
          note: 'Nước uống',
          amount: 20_000,
          charged_to: [],
          created_by: 'member-2',
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
          updated_by: null,
        },
        error: null,
      },
    });
    await expect(
      service.updateIncurredCost('itin-1', 'cost-1', {
        userId: 'member-2',
        amount: 30_000,
      } as any),
    ).resolves.toBeDefined();
  });

  it('chủ lịch trình được sửa price_adjustment dù không phải chính mình tạo', async () => {
    mockTables({
      itineraries: { data: baseItinerary, error: null },
      incurred_costs: {
        data: {
          id: 'cost-2',
          itinerary_id: 'itin-1',
          place_id: 'place-1',
          type: CostType.DIEU_CHINH_GIA,
          note: 'Điều chỉnh giá',
          amount: -5000,
          charged_to: [],
          created_by: 'owner-1',
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
          updated_by: null,
        },
        error: null,
      },
    });
    await expect(
      service.updateIncurredCost('itin-1', 'cost-2', {
        userId: 'owner-1',
        amount: -8000,
      } as any),
    ).resolves.toBeDefined();
  });

  it('lịch trình đã completed thì không cho sửa/xoá chi phí nữa', async () => {
    mockTables({
      itineraries: {
        data: { ...baseItinerary, status: 'completed' },
        error: null,
      },
    });
    await expect(
      service.deleteIncurredCost('itin-1', 'cost-1', 'owner-1'),
    ).rejects.toThrow(ConflictException);
  });
});
