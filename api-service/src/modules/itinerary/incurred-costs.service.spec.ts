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

/** Map tên bảng -> kết quả trả về cho MỌI query nhắm vào bảng đó trong 1 test.
 * Trả về luôn map builder đã tạo cho từng bảng (builder CUỐI CÙNG nếu 1 bảng
 * bị query nhiều lần) để test có thể assert insert()/update() được gọi với
 * đúng payload, ví dụ builders.incurred_costs.insert. */
function mockTables(tables: Record<string, { data: any; error: any }>) {
  const builders: Record<string, any> = {};
  schemaMock.mockImplementation(() => ({
    from: jest.fn((table: string) => {
      const builder = makeBuilder(tables[table] ?? { data: null, error: null });
      builders[table] = builder;
      return builder;
    }),
  }));
  return builders;
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

  it('childrenShare báo riêng cho chủ lịch trình (chưa gán ai), KHÔNG cộng gộp vào total của owner', () => {
    const { totals, childrenShare, childrenShareByMember } = distributeCosts(
      memberIds,
      'owner-1',
      1,
      childPriceRatio,
      basePlanCost,
      [],
    );
    expect(childrenShareByMember.get('owner-1')).toBe(childrenShare);
    expect(childrenShareByMember.has('member-2')).toBe(false);
    expect(childrenShare).toBe(1 * basePlanCost * childPriceRatio);
    // total của owner vẫn chỉ là basePlanCost, không phải basePlanCost + childrenShare.
    expect(totals.get('owner-1')).toBe(basePlanCost);
  });

  it('không có trẻ em thì childrenShare = 0 và childrenShareByMember rỗng', () => {
    const { childrenShare, childrenShareByMember } = distributeCosts(
      memberIds,
      'owner-1',
      0,
      childPriceRatio,
      basePlanCost,
      [],
    );
    expect(childrenShare).toBe(0);
    expect(childrenShareByMember.size).toBe(0);
  });

  it('gán 1 trẻ cho member-2 (còn 1 trẻ chưa gán) chia đúng theo tỉ lệ, phần dư dồn về owner', () => {
    // 2 trẻ em, childrenShare = 2 * basePlanCost * ratio -> mỗi trẻ = 1 suất.
    const { childrenShare, childrenShareByMember } = distributeCosts(
      memberIds,
      'owner-1',
      2,
      childPriceRatio,
      basePlanCost,
      [],
      new Map([['member-2', 1]]),
    );
    const perChild = childrenShare / 2;
    expect(childrenShareByMember.get('member-2')).toBeCloseTo(perChild);
    expect(childrenShareByMember.get('owner-1')).toBeCloseTo(perChild);
  });

  it('gán vượt quá childCount bị CLAMP lại, không cho childrenShareByMember vượt tổng childrenShare', () => {
    const { childrenShare, childrenShareByMember } = distributeCosts(
      memberIds,
      'owner-1',
      1,
      childPriceRatio,
      basePlanCost,
      [],
      new Map([['member-2', 5]]),
    );
    expect(childrenShareByMember.get('member-2')).toBeCloseTo(childrenShare);
    expect(childrenShareByMember.has('owner-1')).toBe(false);
  });

  it('chi phí phát sinh chargedTo=[1 người] chỉ cộng cho đúng người đó', () => {
    const { totals } = distributeCosts(
      memberIds,
      'owner-1',
      0,
      childPriceRatio,
      basePlanCost,
      [{ amount: 50_000, chargedTo: ['member-2'], type: CostType.NUOC_UONG }],
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
      [{ amount: 100_000, chargedTo: [], type: CostType.KHAC }],
    );
    expect(totals.get('owner-1')).toBe(basePlanCost + 50_000);
    expect(totals.get('member-2')).toBe(basePlanCost + 50_000);
  });

  it('chi phí phát sinh chargedTo=[] có trẻ em: chia theo TỔNG NGƯỜI THẬT (tài khoản + trẻ em), phần trẻ em dồn vào childrenShare', () => {
    // 2 tài khoản thật + 2 trẻ em, chi phí 100k "cả nhóm" -> chia đều /4 = 25k
    // mỗi "suất", 2 tài khoản thật nhận 25k mỗi người, 2 trẻ em (50k) dồn vào
    // childrenShare — KHÔNG còn bị chia hết cho 2 tài khoản thật như trước
    // (báo cáo: "hiện tại ko nhân gì hết", bỏ sót hẳn trẻ em).
    const { totals, childrenShare } = distributeCosts(
      memberIds,
      'owner-1',
      2,
      childPriceRatio,
      0,
      [{ amount: 100_000, chargedTo: [], type: CostType.NUOC_UONG }],
    );
    expect(totals.get('owner-1')).toBe(25_000);
    expect(totals.get('member-2')).toBe(25_000);
    expect(childrenShare).toBe(50_000);
  });

  it('chi phí phát sinh chargedTo=[nhiều người] chia đều cho đúng những người đó', () => {
    const threeMembers = ['owner-1', 'member-2', 'member-3'];
    const { totals } = distributeCosts(
      threeMembers,
      'owner-1',
      0,
      childPriceRatio,
      basePlanCost,
      [{ amount: 90_000, chargedTo: ['owner-1', 'member-2'], type: CostType.MUA_SAM }],
    );
    expect(totals.get('owner-1')).toBe(basePlanCost + 45_000);
    expect(totals.get('member-2')).toBe(basePlanCost + 45_000);
    expect(totals.get('member-3')).toBe(basePlanCost);
  });

  it('memberIds rỗng trả về totals rỗng, không lỗi', () => {
    const result = distributeCosts([], 'owner-1', 1, childPriceRatio, basePlanCost, []);
    expect(result.totals.size).toBe(0);
    expect(result.childrenShare).toBe(0);
    expect(result.childrenShareByMember.size).toBe(0);
  });

  it('categoryTotals chia theo đúng CostType cho từng người, không gồm basePlanCost', () => {
    const threeMembers = ['owner-1', 'member-2', 'member-3'];
    const { categoryTotals } = distributeCosts(
      threeMembers,
      'owner-1',
      0,
      childPriceRatio,
      basePlanCost,
      [
        { amount: 90_000, chargedTo: ['owner-1', 'member-2'], type: CostType.MUA_SAM },
        { amount: 30_000, chargedTo: [], type: CostType.NUOC_UONG },
      ],
    );
    // MUA_SAM chia đôi cho owner-1/member-2 (45k mỗi người), NUOC_UONG chia đều 3 người (10k mỗi người).
    expect(categoryTotals.get('owner-1')).toEqual({
      [CostType.MUA_SAM]: 45_000,
      [CostType.NUOC_UONG]: 10_000,
    });
    expect(categoryTotals.get('member-2')).toEqual({
      [CostType.MUA_SAM]: 45_000,
      [CostType.NUOC_UONG]: 10_000,
    });
    // member-3 không nằm trong chargedTo của MUA_SAM nên chỉ có NUOC_UONG.
    expect(categoryTotals.get('member-3')).toEqual({
      [CostType.NUOC_UONG]: 10_000,
    });
  });
});

describe('IncurredCostsService — phân quyền, khoá sau khi hoàn thành, validate số tiền', () => {
  let service: IncurredCostsService;
  let itineraryService: {
    getItineraryMemberProfiles: jest.Mock;
  };
  let tripCostConfig: { getConfig: jest.Mock };

  const baseItinerary = {
    creator_id: 'owner-1',
    status: 'ongoing',
    adult_count: 3,
    children_count: 1,
    estimated_cost: 1_000_000,
    start_date: '2026-02-01',
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

  it('không cho tạo tay type "Điều chỉnh giá" nữa — dùng updatePlaceEffectivePrice() thay thế', async () => {
    mockTables({ itineraries: { data: baseItinerary, error: null } });
    await expect(
      service.createIncurredCost('itin-1', {
        userId: 'owner-1',
        type: CostType.DIEU_CHINH_GIA,
        note: 'Sửa giá vé',
        amount: 5000,
        placeId: 'place-1',
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('updatePlaceEffectivePrice: thành viên không phải chủ lịch trình bị từ chối', async () => {
    mockTables({ itineraries: { data: baseItinerary, error: null } });
    await expect(
      service.updatePlaceEffectivePrice('itin-1', 'place-1', 60_000, 'member-2'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('updatePlaceEffectivePrice: địa điểm chưa visited (chưa có dòng Chi phí kế hoạch) bị từ chối', async () => {
    mockTables({
      itineraries: { data: baseItinerary, error: null },
      incurred_costs: { data: null, error: null },
    });
    await expect(
      service.updatePlaceEffectivePrice('itin-1', 'place-1', 60_000, 'owner-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('updatePlaceEffectivePrice: chủ lịch trình sửa giá thành công khi đã có dòng Chi phí kế hoạch', async () => {
    mockTables({
      itineraries: { data: baseItinerary, error: null },
      incurred_costs: {
        data: {
          id: 'cost-baseline',
          itinerary_id: 'itin-1',
          place_id: 'place-1',
          day_number: null,
          type: CostType.CHI_PHI_KE_HOACH,
          note: 'Chi phí kế hoạch (tự động khi check-in)',
          amount: 50_000,
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
      service.updatePlaceEffectivePrice('itin-1', 'place-1', 60_000, 'owner-1'),
    ).resolves.toBeDefined();
  });

  it('không cho tạo tay type "Chi phí kế hoạch" (chỉ hệ thống tự ghi)', async () => {
    mockTables({ itineraries: { data: baseItinerary, error: null } });
    await expect(
      service.createIncurredCost('itin-1', {
        userId: 'owner-1',
        type: CostType.CHI_PHI_KE_HOACH,
        note: 'Vé vào cổng',
        amount: 50_000,
        placeId: 'place-1',
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('Điều chỉnh xăng xe: thành viên không phải chủ lịch trình bị từ chối tạo', async () => {
    mockTables({ itineraries: { data: baseItinerary, error: null } });
    await expect(
      service.createIncurredCost('itin-1', {
        userId: 'member-2',
        type: CostType.DIEU_CHINH_XANG_XE,
        note: 'Xăng xe tăng giá',
        amount: 50_000,
      } as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('Điều chỉnh xăng xe: không được gắn kèm placeId', async () => {
    mockTables({ itineraries: { data: baseItinerary, error: null } });
    await expect(
      service.createIncurredCost('itin-1', {
        userId: 'owner-1',
        type: CostType.DIEU_CHINH_XANG_XE,
        note: 'Xăng xe tăng giá',
        amount: 50_000,
        placeId: 'place-1',
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('Điều chỉnh xăng xe: amount âm vẫn hợp lệ (delta có thể giảm)', async () => {
    mockTables({
      itineraries: { data: baseItinerary, error: null },
      incurred_costs: {
        data: {
          id: 'cost-xang-xe',
          itinerary_id: 'itin-1',
          place_id: null,
          day_number: null,
          type: CostType.DIEU_CHINH_XANG_XE,
          note: 'Xăng xe giảm',
          amount: -20_000,
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
      service.createIncurredCost('itin-1', {
        userId: 'owner-1',
        type: CostType.DIEU_CHINH_XANG_XE,
        note: 'Xăng xe giảm',
        amount: -20_000,
      } as any),
    ).resolves.toBeDefined();
  });

  it('có placeId thì day_number tự lấy theo ngày viếng thăm thực tế, bỏ qua dayNumber client gửi', async () => {
    const builders = mockTables({
      itineraries: { data: baseItinerary, error: null },
      itinerary_details: {
        data: [{ id: 'detail-1', visit_date: '2026-02-03' }],
        error: null,
      },
      geofence_visits: {
        data: [{ itinerary_detail_id: 'detail-1' }],
        error: null,
      },
      incurred_costs: {
        data: {
          id: 'cost-adhoc',
          itinerary_id: 'itin-1',
          place_id: 'place-1',
          day_number: 3,
          type: CostType.KHAC,
          note: 'Ăn vặt',
          amount: 20_000,
          charged_to: [],
          created_by: 'owner-1',
          created_at: '2026-02-03',
          updated_at: '2026-02-03',
          updated_by: null,
        },
        error: null,
      },
    });
    // baseItinerary.start_date = 2026-02-01, visit_date = 2026-02-03 -> ngày
    // thứ 3. dayNumber: 2 client gửi kèm phải bị BỎ QUA hoàn toàn.
    await service.createIncurredCost('itin-1', {
      userId: 'owner-1',
      type: CostType.KHAC,
      note: 'Ăn vặt',
      amount: 20_000,
      placeId: 'place-1',
      dayNumber: 2,
    } as any);
    expect(builders.incurred_costs.insert).toHaveBeenCalledWith(
      expect.objectContaining({ place_id: 'place-1', day_number: 3 }),
    );
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

  it('người tạo được đính chính 1 dòng "Điều chỉnh giá" cũ (lịch sử, không còn cộng vào tổng nào)', async () => {
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
    // Mọi dòng "Điều chỉnh giá" trước giờ đều do owner tạo (chỉ owner mới
    // tạo được type này) — nên isCreator ở đây trùng owner, không phải
    // owner-only riêng nữa.
    await expect(
      service.updateIncurredCost('itin-1', 'cost-2', {
        userId: 'owner-1',
        amount: -8000,
      } as any),
    ).resolves.toBeDefined();
  });

  it('người KHÔNG PHẢI người tạo dòng "Điều chỉnh giá" cũ thì không sửa được', async () => {
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
        userId: 'member-2',
        amount: -8000,
      } as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('không cho ĐỔI 1 dòng khác SANG type "Điều chỉnh giá" qua update', async () => {
    mockTables({
      itineraries: { data: baseItinerary, error: null },
      incurred_costs: {
        data: {
          id: 'cost-3',
          itinerary_id: 'itin-1',
          place_id: null,
          type: CostType.KHAC,
          note: 'Ăn vặt',
          amount: 20_000,
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
      service.updateIncurredCost('itin-1', 'cost-3', {
        userId: 'owner-1',
        type: CostType.DIEU_CHINH_GIA,
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('update: gắn placeId mới thì day_number tự cập nhật theo ngày viếng thăm, bỏ qua dayNumber client gửi', async () => {
    const builders = mockTables({
      itineraries: { data: baseItinerary, error: null },
      itinerary_details: {
        data: [{ id: 'detail-2', visit_date: '2026-02-04' }],
        error: null,
      },
      geofence_visits: {
        data: [{ itinerary_detail_id: 'detail-2' }],
        error: null,
      },
      incurred_costs: {
        data: {
          id: 'cost-4',
          itinerary_id: 'itin-1',
          place_id: null,
          day_number: 1,
          type: CostType.KHAC,
          note: 'Ăn vặt',
          amount: 20_000,
          charged_to: [],
          created_by: 'owner-1',
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
          updated_by: null,
        },
        error: null,
      },
    });
    // baseItinerary.start_date = 2026-02-01, visit_date của place-2 =
    // 2026-02-04 -> ngày thứ 4. dayNumber: 1 client gửi kèm phải bị BỎ QUA.
    await service.updateIncurredCost('itin-1', 'cost-4', {
      userId: 'owner-1',
      placeId: 'place-2',
      dayNumber: 1,
    } as any);
    expect(builders.incurred_costs.update).toHaveBeenCalledWith(
      expect.objectContaining({ place_id: 'place-2', day_number: 4 }),
    );
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

  it('không ai (kể cả chủ lịch trình) sửa/xoá được "Chi phí kế hoạch"', async () => {
    mockTables({
      itineraries: { data: baseItinerary, error: null },
      incurred_costs: {
        data: {
          id: 'cost-baseline',
          itinerary_id: 'itin-1',
          place_id: 'place-1',
          day_number: null,
          type: CostType.CHI_PHI_KE_HOACH,
          note: 'Chi phí kế hoạch (tự động khi check-in)',
          amount: 50_000,
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
      service.updateIncurredCost('itin-1', 'cost-baseline', {
        userId: 'owner-1',
        amount: 60_000,
      } as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('recordVisitBaselineExpense: idempotent — đã có dòng cho địa điểm này thì không tạo thêm', async () => {
    mockTables({
      itinerary_details: {
        data: { place_id: 'place-1', estimated_cost: 50_000 },
        error: null,
      },
      incurred_costs: {
        data: { id: 'existing-baseline' },
        error: null,
      },
    });
    await expect(
      service.recordVisitBaselineExpense('itin-1', 'detail-1', 'owner-1'),
    ).resolves.toBeUndefined();
  });

  it('recordVisitBaselineExpense: chưa có dòng nào thì tạo mới, không lỗi', async () => {
    mockTables({
      itinerary_details: {
        data: { place_id: 'place-1', estimated_cost: 50_000 },
        error: null,
      },
      incurred_costs: {
        data: null,
        error: null,
      },
    });
    await expect(
      service.recordVisitBaselineExpense('itin-1', 'detail-1', 'owner-1'),
    ).resolves.toBeUndefined();
  });

  it('recordVisitBaselineExpense: không có place_id (điểm ảo) thì bỏ qua', async () => {
    mockTables({
      itinerary_details: {
        data: { place_id: null, estimated_cost: 0 },
        error: null,
      },
    });
    await expect(
      service.recordVisitBaselineExpense('itin-1', 'detail-1', 'owner-1'),
    ).resolves.toBeUndefined();
  });
});
