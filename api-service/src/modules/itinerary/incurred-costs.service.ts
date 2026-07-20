import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { supabase } from '../../config/supabase';
import { ItineraryService } from './itinerary.service';
import { TripCostConfigService } from '../recommendation/trip-cost-config.service';
import { CreateIncurredCostDto } from './dto/create-incurred-cost.dto';
import { UpdateIncurredCostDto } from './dto/update-incurred-cost.dto';
import { CostType } from './dto/cost-type.enum';

export interface IncurredCostRow {
  id: string;
  itinerary_id: string;
  place_id: string | null;
  day_number: number | null;
  type: CostType;
  note: string;
  amount: number;
  charged_to: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

interface ItineraryAccessContext {
  creatorId: string;
  status: string;
  adultCount: number;
  childCount: number;
  /** User's original input budget (itineraries.estimated_cost), per adult. */
  userBudget: number;
  /** [creatorId, ...itinerary_members] — real accounts only, owner first. */
  memberIds: string[];
}

export interface CostDistributionResult {
  /** Phần CỦA RIÊNG mỗi thành viên (basePlanCost + chi phí phát sinh) —
   * KHÔNG cộng gộp phần trẻ em vào đây, kể cả với chủ lịch trình. */
  totals: Map<string, number>;
  /** Phần chi phí phát sinh của mỗi thành viên, chia theo CostType (Nước
   * uống/Quà tặng/Mua sắm/Phí gửi xe/Khác) — KHÔNG gồm basePlanCost (basePlanCost
   * hiển thị thành 1 khối riêng ở UI, không phải 1 "mục"). Dùng để hiển thị
   * "mỗi người phải trả" chi tiết theo từng mục thay vì chỉ 1 tổng gộp. */
  categoryTotals: Map<string, Partial<Record<CostType, number>>>;
  /** Tổng chi phí trẻ em (childCount * basePlanCost * childPriceRatio), báo
   * riêng để UI hiển thị thành 1 dòng độc lập, không trộn vào total của ai. */
  childrenShare: number;
  /** Thành viên đang chịu trách nhiệm phần trẻ em ở trên (mặc định = chủ
   * lịch trình), null nếu không có trẻ em hoặc chủ lịch trình không còn
   * trong memberIds. */
  childrenAssignedTo: string | null;
}

/**
 * Chia 1 khoản chi (hoặc chi phí gốc theo kế hoạch) cho các thành viên thật
 * của lịch trình. Không có khái niệm "ai đã ứng tiền trước" (paid_by) — chỉ
 * tính "mỗi người phải gánh tổng bao nhiêu" (mục 1.6-1.7).
 *
 * basePlanCost là tổng chi phí kế hoạch TÍNH THEO 1 NGƯỜI LỚN (xem
 * recommendation.service.ts/itinerary.service.ts) — share lịch trình không
 * làm thay đổi mức giá này: mỗi tài khoản thật (tối đa = số người lớn) luôn
 * gánh đúng basePlanCost, không chia nhỏ theo số tài khoản đang có. Trẻ em
 * không có tài khoản nên mặc định toàn bộ chi phí trẻ em thuộc về chủ lịch
 * trình — nhưng đây là 1 con số RIÊNG (childrenShare), không được cộng gộp
 * thẳng vào total của chủ lịch trình (dễ gây hiểu lầm "sao chủ trả nhiều hơn
 * người khác mà không rõ vì sao"). Chuyển phần trẻ em cho thành viên khác là
 * một tính năng riêng (UI "điều chỉnh giá"), chưa xây dựng ở đây.
 */
export function distributeCosts(
  memberIds: string[],
  ownerId: string,
  childCount: number,
  childPriceRatio: number,
  basePlanCost: number,
  incurredCosts: Array<{ amount: number; chargedTo: string[]; type: CostType }>,
): CostDistributionResult {
  const totals = new Map<string, number>(memberIds.map((id) => [id, 0]));
  const categoryTotals = new Map<string, Partial<Record<CostType, number>>>(
    memberIds.map((id) => [id, {}]),
  );
  if (memberIds.length === 0) {
    return { totals, categoryTotals, childrenShare: 0, childrenAssignedTo: null };
  }

  // Sharing không thay đổi giá: mỗi tài khoản thật gánh đúng basePlanCost
  // (phần của riêng họ — trẻ em KHÔNG được cộng vào đây, xem childrenShare).
  for (const id of memberIds) {
    totals.set(id, (totals.get(id) ?? 0) + basePlanCost);
  }

  // childrenShare gộp CẢ 2 nguồn: phần trẻ em của chi phí kế hoạch (nhân
  // childPriceRatio, như cũ) + phần trẻ em của các khoản phát sinh "cả nhóm"
  // (cộng dồn trong vòng lặp bên dưới — KHÔNG nhân childPriceRatio, vì đây là
  // chi phí thực tế dùng chung — nước uống/quà tặng... — trẻ em dùng y hệt
  // người lớn, không có "giá trẻ em" như vé/khách sạn).
  let childrenShare =
    childCount > 0 ? childCount * basePlanCost * childPriceRatio : 0;
  const childrenAssignedTo =
    childCount > 0 && totals.has(ownerId) ? ownerId : null;

  const addCategoryShare = (id: string, type: CostType, share: number) => {
    const entry = categoryTotals.get(id);
    if (!entry) return;
    entry[type] = (entry[type] ?? 0) + share;
  };

  for (const cost of incurredCosts) {
    const chargedTo = cost.chargedTo.filter((id) => memberIds.includes(id));
    if (chargedTo.length === 0) {
      // "Cả nhóm" — chia đều theo TỔNG SỐ NGƯỜI THẬT (tài khoản thật + trẻ
      // em), không chỉ theo số tài khoản như trước (bỏ sót trẻ em nếu đoàn có
      // trẻ em). Phần trẻ em dồn vào childrenShare, gán chủ lịch trình —
      // giống hệt cách basePlanCost đang làm ở trên.
      const participantSlots = memberIds.length + childCount;
      const perShare = cost.amount / participantSlots;
      for (const id of memberIds) {
        totals.set(id, (totals.get(id) ?? 0) + perShare);
        addCategoryShare(id, cost.type, perShare);
      }
      if (childCount > 0) {
        childrenShare += perShare * childCount;
      }
    } else if (chargedTo.length === 1) {
      totals.set(chargedTo[0], (totals.get(chargedTo[0]) ?? 0) + cost.amount);
      addCategoryShare(chargedTo[0], cost.type, cost.amount);
    } else {
      const share = cost.amount / chargedTo.length;
      for (const id of chargedTo) {
        totals.set(id, (totals.get(id) ?? 0) + share);
        addCategoryShare(id, cost.type, share);
      }
    }
  }
  return { totals, categoryTotals, childrenShare, childrenAssignedTo };
}

@Injectable()
export class IncurredCostsService {
  constructor(
    private readonly itineraryService: ItineraryService,
    private readonly tripCostConfig: TripCostConfigService,
  ) {}

  private async loadAccessContext(
    itineraryId: string,
  ): Promise<ItineraryAccessContext> {
    const { data: itinerary, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .select(
        'id, creator_id, status, adult_count, children_count, estimated_cost',
      )
      .eq('id', itineraryId)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load itinerary: ${error.message}`,
      );
    }
    if (!itinerary) {
      throw new NotFoundException(`Itinerary not found: ${itineraryId}`);
    }

    const profiles = await this.itineraryService.getItineraryMemberProfiles(
      itineraryId,
      (itinerary as any).creator_id,
    );
    const memberIds =
      profiles.length > 0
        ? profiles.map((p) => p.id)
        : [(itinerary as any).creator_id];

    return {
      creatorId: (itinerary as any).creator_id,
      status: ((itinerary as any).status ?? '').toLowerCase(),
      adultCount: Math.max(0, Number((itinerary as any).adult_count ?? 0)),
      childCount: Math.max(0, Number((itinerary as any).children_count ?? 0)),
      userBudget: Math.max(0, Number((itinerary as any).estimated_cost ?? 0)),
      memberIds,
    };
  }

  private assertCallerIsMember(
    ctx: ItineraryAccessContext,
    userId: string,
  ): void {
    if (!ctx.memberIds.includes(userId)) {
      throw new ForbiddenException(
        'Bạn không phải thành viên của lịch trình này',
      );
    }
  }

  private assertNotLocked(ctx: ItineraryAccessContext): void {
    if (ctx.status === 'completed') {
      throw new ConflictException({
        code: 'ITINERARY_LOCKED',
        message:
          'Lịch trình đã hoàn thành, không thể chỉnh sửa chi phí phát sinh nữa',
      });
    }
  }

  /**
   * price_adjustment thay đổi chi phí nền dùng chung cho cả nhóm nên chỉ chủ
   * lịch trình được sửa/xoá (không có ngoại lệ creator, vì chỉ owner mới tạo
   * được type này ngay từ đầu). Các type khác (chi phí phát sinh cá nhân)
   * thì ngược lại — chỉ đúng người tạo mới được sửa/xoá, kể cả chủ lịch
   * trình cũng không có quyền ghi đè khoản chi của người khác.
   */
  private assertCanModify(
    ctx: ItineraryAccessContext,
    cost: IncurredCostRow,
    userId: string,
  ): void {
    const isOwner = ctx.creatorId === userId;
    const isCreator = cost.created_by === userId;
    // "Chi phí kế hoạch": hệ thống tự ghi khi check-in — sửa giá 1 địa điểm
    // giờ đi qua updatePlaceEffectivePrice() (cập nhật thẳng lên dòng này),
    // không ai được sửa/xoá tay dòng này cả, kể cả chủ lịch trình.
    if (cost.type === CostType.CHI_PHI_KE_HOACH) {
      throw new ForbiddenException(
        'Chi phí kế hoạch do hệ thống tự ghi, không thể sửa/xoá tay — muốn sửa giá địa điểm, dùng chức năng "Sửa giá"',
      );
    }
    // "Điều chỉnh giá": không tạo MỚI được nữa (xem createIncurredCost), chỉ
    // còn là dữ liệu LỊCH SỬ của các dòng đã có — nhưng người dùng vẫn có
    // thể đã nhập sai lúc trước, nên vẫn cho sửa/xoá để đính chính, CHỈ cập
    // nhật ngay trên dòng incurred_costs này (không còn cộng dồn vào bất kỳ
    // tổng nào khác — xem computeActualSpending). Áp dụng đúng quy tắc như
    // các chi phí ad-hoc khác (chỉ người TẠO mới sửa/xoá được) — không cần
    // owner-only riêng nữa vì mọi dòng loại này trước giờ đều do owner tạo
    // (chỉ owner mới tạo được type này), nên isCreator ở đây thực chất luôn
    // trùng với owner — chỉ đổi LÝ DO cho dễ hiểu hơn, không đổi ai có quyền.
    if (cost.type === CostType.DIEU_CHINH_XANG_XE) {
      if (!isOwner) {
        throw new ForbiddenException(
          'Chỉ chủ lịch trình mới được sửa/xoá điều chỉnh xăng xe',
        );
      }
      return;
    }
    if (!isCreator) {
      throw new ForbiddenException(
        'Chỉ người tạo khoản chi này mới được sửa/xoá',
      );
    }
  }

  private validateChargedTo(
    ctx: ItineraryAccessContext,
    chargedTo?: string[],
  ): string[] {
    const list = (chargedTo ?? []).filter(
      (id) => typeof id === 'string' && id.length > 0,
    );
    const unique = [...new Set(list)];
    const invalid = unique.filter((id) => !ctx.memberIds.includes(id));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Người được chọn không phải thành viên lịch trình này: ${invalid.join(', ')}`,
      );
    }
    return unique;
  }

  /** Địa điểm phải thuộc lịch trình này VÀ đã ở trạng thái visited. */
  private async validatePlaceId(
    itineraryId: string,
    placeId: string,
  ): Promise<void> {
    const { data: detailRows, error } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('id')
      .eq('itinerary_id', itineraryId)
      .eq('place_id', placeId);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to validate place: ${error.message}`,
      );
    }
    if (!detailRows || detailRows.length === 0) {
      throw new BadRequestException('Địa điểm này không thuộc lịch trình');
    }

    const detailIds = detailRows.map((d: any) => d.id);
    const { data: visits, error: visitError } = await supabase
      .schema('tracking')
      .from('geofence_visits')
      .select('itinerary_detail_id')
      .in('itinerary_detail_id', detailIds)
      .or('status.eq.visited,checked_in_at.not.is.null');
    if (visitError) {
      throw new InternalServerErrorException(
        `Failed to validate visit status: ${visitError.message}`,
      );
    }
    if (!visits || visits.length === 0) {
      throw new BadRequestException(
        'Chỉ có thể gắn chi phí vào địa điểm đã đi (trạng thái đã đi)',
      );
    }
  }

  /** Ngày phải nằm trong khoảng [1, số ngày chuyến] — không gate theo trạng
   * thái visit/status (khác validatePlaceId): user có thể gắn 1 khoản chi
   * vào ngày bất kỳ, kể cả ngày chưa tới. */
  private async validateDayNumber(
    itineraryId: string,
    dayNumber: number,
  ): Promise<void> {
    const { data: itinerary, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('start_date, end_date')
      .eq('id', itineraryId)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to validate day number: ${error.message}`,
      );
    }
    const startDate = (itinerary as any)?.start_date;
    const endDate = (itinerary as any)?.end_date;
    if (!startDate || !endDate) {
      throw new BadRequestException('Lịch trình chưa có ngày bắt đầu/kết thúc');
    }
    const numDays =
      Math.round(
        (new Date(endDate).getTime() - new Date(startDate).getTime()) /
          86_400_000,
      ) + 1;
    if (dayNumber < 1 || dayNumber > numDays) {
      throw new BadRequestException(
        `Ngày phải nằm trong khoảng 1-${numDays}`,
      );
    }
  }

  /**
   * Ghi 1 dòng "Chi phí kế hoạch" TỰ ĐỘNG khi 1 itinerary_detail (địa điểm
   * HOẶC khách sạn — cùng 1 luồng, không phân biệt) được đánh dấu "đã đi".
   * Gọi từ ItineraryTrackingService ngay sau khi geofence_visits được ghi
   * visited (handleEvent()/checkIn()). Idempotent: gọi lại nhiều lần cho
   * cùng 1 địa điểm (dwell-event bắn lại, check-in lại) không tạo trùng.
   *
   * amount tính THEO 1 NGƯỜI LỚN (giống ý nghĩa basePlanCost hiện tại) —
   * KHÔNG nhân theo adultCount — vì computeActualSpending() vẫn truyền tổng
   * này thẳng vào distributeCosts() làm basePlanCost (mỗi tài khoản thật
   * gánh đúng basePlanCost, không chia nhỏ), y hệt cách basePlanCost hoạt
   * động từ trước — chỉ khác nguồn giờ là SUM trên dữ liệu đã lưu thay vì
   * tính tươi từ places/itinerary_details mỗi lần.
   */
  async recordVisitBaselineExpense(
    itineraryId: string,
    itineraryDetailId: string,
    touristId: string,
  ): Promise<void> {
    const { data: detail, error } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('place_id, estimated_cost, visit_date')
      .eq('id', itineraryDetailId)
      .eq('itinerary_id', itineraryId)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load itinerary detail: ${error.message}`,
      );
    }
    const placeId = (detail as any)?.place_id;
    if (!placeId) return; // Không có place_id (vd điểm ảo start point) — bỏ qua.

    // day_number = ngày thứ N thật sự visited — để computeDayCostBreakdown()
    // lọc thẳng theo cột này thay vì suy ngược qua visit_date mỗi lần đọc.
    let dayNumber: number | null = null;
    const visitDate = (detail as any)?.visit_date;
    if (visitDate) {
      const { data: itinerary } = await supabase
        .schema('travel')
        .from('itineraries')
        .select('start_date')
        .eq('id', itineraryId)
        .maybeSingle();
      const startDate = (itinerary as any)?.start_date;
      if (startDate) {
        dayNumber =
          Math.round(
            (new Date(visitDate).getTime() - new Date(startDate).getTime()) /
              86_400_000,
          ) + 1;
      }
    }

    const { data: existing, error: existingError } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .select('id')
      .eq('itinerary_id', itineraryId)
      .eq('place_id', placeId)
      .eq('type', CostType.CHI_PHI_KE_HOACH)
      .maybeSingle();
    if (existingError) {
      throw new InternalServerErrorException(
        `Failed to check existing baseline expense: ${existingError.message}`,
      );
    }
    if (existing) return; // Đã ghi rồi — idempotent.

    // Lưu ĐÚNG estimated_cost gốc tại thời điểm check-in — đây là giá
    // "hiệu lực" đầu tiên. Muốn sửa giá sau này (owner) thì gọi
    // updatePlaceEffectivePrice() để cập nhật THẲNG lên dòng này (không có
    // delta/dòng "Điều chỉnh giá" riêng nữa).
    const amount = Math.max(0, Number((detail as any).estimated_cost ?? 0));
    if (amount <= 0) return; // Địa điểm miễn phí — không cần ghi dòng 0đ.

    const { error: insertError } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .insert({
        itinerary_id: itineraryId,
        place_id: placeId,
        day_number: dayNumber,
        type: CostType.CHI_PHI_KE_HOACH,
        note: 'Chi phí kế hoạch (tự động khi check-in)',
        amount: Math.round(amount / 1000) * 1000,
        charged_to: [],
        created_by: touristId,
      });
    if (insertError) {
      throw new InternalServerErrorException(
        `Failed to record baseline expense: ${insertError.message}`,
      );
    }
  }

  /** Danh sách địa điểm đã "visited" trong lịch trình — dùng cho combobox. */
  async getEligiblePlaces(itineraryId: string, userId: string) {
    const ctx = await this.loadAccessContext(itineraryId);
    this.assertCallerIsMember(ctx, userId);

    const { data: detailRows, error } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('id, place_id, estimated_cost')
      .eq('itinerary_id', itineraryId)
      .not('place_id', 'is', null);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load itinerary details: ${error.message}`,
      );
    }
    const details = detailRows ?? [];
    if (details.length === 0) return [];

    const detailIds = details.map((d: any) => d.id);
    const { data: visits, error: visitError } = await supabase
      .schema('tracking')
      .from('geofence_visits')
      .select('itinerary_detail_id')
      .in('itinerary_detail_id', detailIds)
      .or('status.eq.visited,checked_in_at.not.is.null');
    if (visitError) {
      throw new InternalServerErrorException(
        `Failed to load visit status: ${visitError.message}`,
      );
    }
    const visitedDetailIds = new Set(
      (visits ?? []).map((v: any) => v.itinerary_detail_id),
    );

    const visitedPlaceIds = [
      ...new Set(
        details
          .filter((d: any) => visitedDetailIds.has(d.id))
          .map((d: any) => d.place_id),
      ),
    ];
    if (visitedPlaceIds.length === 0) return [];

    const { data: places, error: placesError } = await supabase
      .schema('travel')
      .from('places')
      .select('id, name, address')
      .in('id', visitedPlaceIds);
    if (placesError) {
      throw new InternalServerErrorException(
        `Failed to load places: ${placesError.message}`,
      );
    }

    // currentEffectivePrice = giá HIỆU LỰC hiện tại của địa điểm — ưu tiên
    // đọc từ dòng "Chi phí kế hoạch" đã lưu (giá trị này CHÍNH LÀ nguồn sửa
    // trực tiếp qua updatePlaceEffectivePrice(), nên luôn phản ánh đúng giá
    // mới nhất), rơi về estimated_cost gốc nếu vì lý do gì đó chưa có dòng
    // baseline (không nên xảy ra với địa điểm đã visited, nhưng phòng hờ).
    const rawCostByPlace = new Map<string, number>();
    for (const d of details) {
      const placeId = (d as any).place_id as string;
      if (!rawCostByPlace.has(placeId)) {
        rawCostByPlace.set(placeId, Number((d as any).estimated_cost ?? 0));
      }
    }
    const { data: baselineRows, error: baselineError } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .select('place_id, amount')
      .eq('itinerary_id', itineraryId)
      .eq('type', CostType.CHI_PHI_KE_HOACH)
      .in('place_id', visitedPlaceIds);
    if (baselineError) {
      throw new InternalServerErrorException(
        `Failed to load baseline expenses: ${baselineError.message}`,
      );
    }
    const baselineAmountByPlace = new Map<string, number>();
    for (const row of baselineRows ?? []) {
      baselineAmountByPlace.set(
        (row as any).place_id,
        Number((row as any).amount ?? 0),
      );
    }

    return (places ?? []).map((place: any) => ({
      ...place,
      currentEffectivePrice:
        baselineAmountByPlace.get(place.id) ??
        rawCostByPlace.get(place.id) ??
        0,
    }));
  }

  /** Làm tròn đến đơn vị nghìn (1k) và bắt buộc tối thiểu 1.000đ (âm hoặc
   * dương, theo trị tuyệt đối — transport_adjustment vẫn phải là 1 chênh
   * lệch đáng kể, không phải vài trăm đồng). Trả về giá trị đã làm tròn để
   * lưu — không tin vào con số client gửi lên. */
  private normalizeAndValidateAmount(type: CostType, amount: number): number {
    const rounded = Math.round(amount / 1000) * 1000;
    // DIEU_CHINH_GIA không tạo mới được nữa nhưng vẫn có thể ĐÍNH CHÍNH 1
    // dòng cũ đã có — giữ nguyên bản chất "delta có thể âm" của nó lúc sửa.
    const canBeNegative =
      type === CostType.DIEU_CHINH_XANG_XE || type === CostType.DIEU_CHINH_GIA;
    if (!canBeNegative && rounded <= 0) {
      throw new BadRequestException('Số tiền phải lớn hơn 0');
    }
    if (Math.abs(rounded) < 1000) {
      throw new BadRequestException('Số tiền phải từ 1.000đ trở lên');
    }
    return rounded;
  }

  async createIncurredCost(
    itineraryId: string,
    dto: CreateIncurredCostDto,
  ): Promise<IncurredCostRow> {
    const ctx = await this.loadAccessContext(itineraryId);
    this.assertCallerIsMember(ctx, dto.userId);
    this.assertNotLocked(ctx);

    const type = dto.type ?? CostType.KHAC;
    if (type === CostType.CHI_PHI_KE_HOACH) {
      throw new BadRequestException(
        'Chi phí kế hoạch được hệ thống tự ghi khi check-in, không tạo tay được',
      );
    }
    if (type === CostType.DIEU_CHINH_GIA) {
      throw new BadRequestException(
        'Điều chỉnh giá không tạo dòng mới nữa — dùng chức năng "Sửa giá" trên địa điểm để cập nhật thẳng',
      );
    }
    const amount = this.normalizeAndValidateAmount(type, dto.amount);

    const isTransportAdjustment = type === CostType.DIEU_CHINH_XANG_XE;
    if (isTransportAdjustment && dto.userId !== ctx.creatorId) {
      throw new ForbiddenException(
        'Chỉ chủ lịch trình mới được điều chỉnh xăng xe',
      );
    }
    if (isTransportAdjustment && (dto.placeId || dto.dayNumber)) {
      throw new BadRequestException(
        'Điều chỉnh xăng xe áp dụng cho cả chuyến, không gắn địa điểm/ngày cụ thể',
      );
    }
    if (dto.placeId && dto.dayNumber) {
      throw new BadRequestException(
        'Chỉ được gắn khoản chi theo địa điểm HOẶC theo ngày, không cả hai',
      );
    }

    if (dto.placeId) {
      await this.validatePlaceId(itineraryId, dto.placeId);
    }
    if (dto.dayNumber) {
      await this.validateDayNumber(itineraryId, dto.dayNumber);
    }
    // transport_adjustment thay đổi chi phí nền dùng chung — không gán riêng
    // cho ai, nên charged_to luôn bị ép rỗng bất kể client gửi gì.
    const chargedTo = isTransportAdjustment
      ? []
      : this.validateChargedTo(ctx, dto.chargedTo);

    const { data, error } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .insert({
        itinerary_id: itineraryId,
        place_id: dto.placeId ?? null,
        day_number: dto.dayNumber ?? null,
        type,
        note: dto.note,
        amount,
        charged_to: chargedTo,
        created_by: dto.userId,
      })
      .select('*')
      .single();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to create incurred cost: ${error.message}`,
      );
    }
    return data as IncurredCostRow;
  }

  async listIncurredCosts(
    itineraryId: string,
    userId: string,
    filters: { placeId?: string; dayNumber?: number; userId?: string } = {},
  ): Promise<IncurredCostRow[]> {
    const ctx = await this.loadAccessContext(itineraryId);
    this.assertCallerIsMember(ctx, userId);

    let query = supabase
      .schema('travel')
      .from('incurred_costs')
      .select('*')
      .eq('itinerary_id', itineraryId)
      .order('created_at', { ascending: false });
    if (filters.placeId) {
      query = query.eq('place_id', filters.placeId);
    }
    if (filters.dayNumber) {
      query = query.eq('day_number', filters.dayNumber);
    }
    const { data, error } = await query;
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load incurred costs: ${error.message}`,
      );
    }
    let rows = (data ?? []) as IncurredCostRow[];
    if (filters.userId) {
      rows = rows.filter((row) => {
        const chargedTo = Array.isArray(row.charged_to) ? row.charged_to : [];
        return chargedTo.length === 0 || chargedTo.includes(filters.userId!);
      });
    }
    return rows;
  }

  private async loadCostOrThrow(
    itineraryId: string,
    costId: string,
  ): Promise<IncurredCostRow> {
    const { data, error } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .select('*')
      .eq('id', costId)
      .eq('itinerary_id', itineraryId)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load incurred cost: ${error.message}`,
      );
    }
    if (!data) {
      throw new NotFoundException('Không tìm thấy khoản chi phí');
    }
    return data as IncurredCostRow;
  }

  async updateIncurredCost(
    itineraryId: string,
    costId: string,
    dto: UpdateIncurredCostDto,
  ): Promise<IncurredCostRow> {
    const ctx = await this.loadAccessContext(itineraryId);
    this.assertCallerIsMember(ctx, dto.userId);
    this.assertNotLocked(ctx);
    const cost = await this.loadCostOrThrow(itineraryId, costId);
    this.assertCanModify(ctx, cost, dto.userId);

    const effectiveType = dto.type ?? cost.type;
    if (effectiveType === CostType.CHI_PHI_KE_HOACH) {
      throw new BadRequestException(
        'Chi phí kế hoạch được hệ thống tự ghi, không đổi type sang loại này được',
      );
    }
    // Chỉ chặn CHUYỂN 1 dòng khác SANG "Điều chỉnh giá" (dto.type set rõ
    // ràng) — không chặn sửa note/amount của 1 dòng "Điều chỉnh giá" ĐÃ CÓ
    // sẵn (dto.type bỏ trống, effectiveType trùng cost.type có sẵn): dòng cũ
    // vẫn có thể bị nhập sai lúc trước, cho phép đính chính (chỉ cập nhật
    // ngay trên dòng này, không còn cộng dồn vào tổng nào khác nữa).
    if (dto.type === CostType.DIEU_CHINH_GIA) {
      throw new BadRequestException(
        'Điều chỉnh giá không còn tạo/đổi type sang loại này nữa — dùng chức năng "Sửa giá" trên địa điểm',
      );
    }
    const isTransportAdjustment =
      effectiveType === CostType.DIEU_CHINH_XANG_XE;
    // "Điều chỉnh giá" (dòng cũ) vốn luôn là chi phí CHUNG, không gán riêng
    // cho ai — giữ nguyên tính chất đó khi đính chính, dù giờ nó chỉ còn là
    // dữ liệu lịch sử.
    const isPriceAdjustment = effectiveType === CostType.DIEU_CHINH_GIA;
    const normalizedAmount =
      dto.amount !== undefined
        ? this.normalizeAndValidateAmount(effectiveType, dto.amount)
        : undefined;
    const effectivePlaceId =
      dto.placeId !== undefined ? dto.placeId : cost.place_id;
    const effectiveDayNumber =
      dto.dayNumber !== undefined ? dto.dayNumber : cost.day_number;
    if (isTransportAdjustment && (effectivePlaceId || effectiveDayNumber)) {
      throw new BadRequestException(
        'Điều chỉnh xăng xe áp dụng cho cả chuyến, không gắn địa điểm/ngày cụ thể',
      );
    }
    if (isPriceAdjustment && !effectivePlaceId) {
      throw new BadRequestException(
        'Điều chỉnh giá phải gắn với 1 địa điểm cụ thể',
      );
    }
    if (effectivePlaceId && effectiveDayNumber) {
      throw new BadRequestException(
        'Chỉ được gắn khoản chi theo địa điểm HOẶC theo ngày, không cả hai',
      );
    }

    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      updated_by: dto.userId,
    };
    if (dto.type !== undefined) update.type = dto.type;
    if (dto.note !== undefined) update.note = dto.note;
    if (normalizedAmount !== undefined) update.amount = normalizedAmount;
    if (dto.placeId !== undefined) {
      if (dto.placeId) {
        await this.validatePlaceId(itineraryId, dto.placeId);
      }
      update.place_id = dto.placeId;
    }
    if (dto.dayNumber !== undefined) {
      if (dto.dayNumber) {
        await this.validateDayNumber(itineraryId, dto.dayNumber);
      }
      update.day_number = dto.dayNumber;
    }
    // transport_adjustment/price_adjustment không bao giờ gán riêng cho ai
    // — bỏ qua chargedTo dù client có gửi.
    if (
      dto.chargedTo !== undefined &&
      !isTransportAdjustment &&
      !isPriceAdjustment
    ) {
      update.charged_to = this.validateChargedTo(ctx, dto.chargedTo);
    }

    const { data, error } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .update(update)
      .eq('id', costId)
      .select('*')
      .single();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to update incurred cost: ${error.message}`,
      );
    }
    return data as IncurredCostRow;
  }

  /**
   * "Sửa giá" 1 địa điểm ĐÃ VISITED — cập nhật THẲNG lên dòng "Chi phí kế
   * hoạch" (amount = giá mới, tuyệt đối, không phải delta) thay vì tạo 1
   * dòng "Điều chỉnh giá" riêng như trước. Chỉ chủ lịch trình được sửa —
   * giống hệt quyền của "Điều chỉnh giá" cũ.
   */
  async updatePlaceEffectivePrice(
    itineraryId: string,
    placeId: string,
    amount: number,
    userId: string,
  ): Promise<IncurredCostRow> {
    const ctx = await this.loadAccessContext(itineraryId);
    this.assertCallerIsMember(ctx, userId);
    this.assertNotLocked(ctx);
    if (userId !== ctx.creatorId) {
      throw new ForbiddenException('Chỉ chủ lịch trình mới được sửa giá địa điểm');
    }

    const { data: baseline, error } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .select('*')
      .eq('itinerary_id', itineraryId)
      .eq('place_id', placeId)
      .eq('type', CostType.CHI_PHI_KE_HOACH)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load baseline expense: ${error.message}`,
      );
    }
    if (!baseline) {
      throw new BadRequestException(
        'Địa điểm này chưa được ghi nhận đã đi, chưa có gì để sửa giá',
      );
    }

    const normalizedAmount = this.normalizeAndValidateAmount(
      CostType.CHI_PHI_KE_HOACH,
      amount,
    );
    const { data, error: updateError } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .update({
        amount: normalizedAmount,
        updated_at: new Date().toISOString(),
        updated_by: userId,
      })
      .eq('id', (baseline as any).id)
      .select('*')
      .single();
    if (updateError) {
      throw new InternalServerErrorException(
        `Failed to update place price: ${updateError.message}`,
      );
    }
    return data as IncurredCostRow;
  }

  async deleteIncurredCost(
    itineraryId: string,
    costId: string,
    userId: string,
  ): Promise<{ success: true }> {
    const ctx = await this.loadAccessContext(itineraryId);
    this.assertCallerIsMember(ctx, userId);
    this.assertNotLocked(ctx);
    const cost = await this.loadCostOrThrow(itineraryId, costId);
    this.assertCanModify(ctx, cost, userId);

    const { error } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .delete()
      .eq('id', costId);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to delete incurred cost: ${error.message}`,
      );
    }
    return { success: true };
  }

  /**
   * "Mỗi người phải trả tổng bao nhiêu" (mục 1.7) — chi phí gốc theo kế
   * hoạch + toàn bộ incurred_costs, chia theo distributeCosts(). Dùng cả cho
   * xem trước (member đang xem tiến độ giữa chuyến) lẫn khi lịch trình
   * chuyển "completed" (itinerary-tracking.service.ts hook vào đây).
   */
  /**
   * Nguồn "chi phí thực tế" DÙNG CHUNG cho Card 2 (spentSoFar) và Card 3 (mỗi
   * người phải trả) — không cộng thẳng toàn bộ incurred_costs/kế hoạch, mà
   * chỉ tính giá hiệu lực (đã gồm price_adjustment) của những ĐỊA ĐIỂM ĐÃ ĐI
   * (khách sạn tính đủ 100% ngay khi dòng khách sạn được đánh dấu đã đi/check-in
   * — không có giá/đêm riêng trong schema nên không thể chia theo số đêm thực
   * tế đã qua), cộng với chi phí phát sinh gắn với 1 địa điểm đã đi (hoặc
   * không gắn địa điểm nào). Chi phí phát sinh gắn với 1 địa điểm CHƯA đi thì
   * không tính — validatePlaceId() vốn đã chặn việc tạo mới trường hợp này,
   * tình huống này chỉ có thể xảy ra nếu status visit bị đổi lại sau khi đã
   * tạo cost.
   */
  /**
   * "Chi phí thực tế" DÙNG CHUNG cho Card 2 (spentSoFar) và Card 3 (mỗi
   * người phải trả) — actualBaseCost giờ là 1 phép SUM đơn giản trên các
   * dòng "Chi phí kế hoạch" đã lưu (xem recordVisitBaselineExpense()), thay
   * vì tính tươi từ places/itinerary_details + lọc theo geofence_visits như
   * trước. Dòng "Chi phí kế hoạch" chỉ tồn tại cho địa điểm/khách sạn ĐÃ
   * CHECK-IN (ghi 1 lần, idempotent theo place_id) nên bản thân sự tồn tại
   * của dòng đã là "đã tiêu" — không cần lọc lại theo visited status ở đây
   * nữa, kể cả cho adhocCosts (trước đây phải lọc phòng hờ trường hợp visit
   * status bị đổi lại sau khi đã tạo cost — nay 1 khi đã ghi nhận thì tính,
   * đúng tinh thần "1 nguồn dữ liệu duy nhất").
   */
  private async computeActualSpending(
    itineraryId: string,
    adhocCosts: Array<{
      amount: number;
      chargedTo: string[];
      placeId: string | null;
      type: CostType;
    }>,
  ): Promise<{
    /** Per-adult, tổng các dòng "Chi phí kế hoạch" đã ghi (địa
     * điểm+khách sạn đã check-in, không gồm xăng xe). Dùng làm gốc chia cho
     * distributeCosts() ở Card 3 — KHÔNG nhân theo adultCount/childCount ở
     * đây, vì distributeCosts() tự nhân theo từng tài khoản thật + trẻ em.
     * Muốn ra tổng CẢ NHÓM (Card 2 spentSoFar) thì nhân ở tầng gọi
     * (computeCostBreakdown), xem groupActualBaseCost ở đó. */
    actualBaseCost: number;
    visitedIncurredCosts: Array<{ amount: number; chargedTo: string[]; type: CostType }>;
  }> {
    const { data: baselineRows, error } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .select('amount, place_id')
      .eq('itinerary_id', itineraryId)
      .eq('type', CostType.CHI_PHI_KE_HOACH);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load baseline expenses: ${error.message}`,
      );
    }
    // amount trên dòng baseline CHÍNH LÀ giá hiệu lực hiện tại — sửa giá đi
    // qua updatePlaceEffectivePrice() (cập nhật thẳng lên dòng này), không
    // còn "Điều chỉnh giá" dạng delta cộng dồn riêng nữa.
    const actualBaseCost = (baselineRows ?? []).reduce(
      (sum, row: any) => sum + Number(row.amount ?? 0),
      0,
    );

    return {
      actualBaseCost,
      visitedIncurredCosts: adhocCosts,
    };
  }

  async computeCostBreakdown(itineraryId: string): Promise<{
    memberTotals: Array<{
      userId: string;
      fullName: string;
      isOwner: boolean;
      total: number;
      childrenShare: number;
      /** Phần chi phí phát sinh của riêng người này, chia theo mục (Nước
       * uống/Quà tặng/Mua sắm/Phí gửi xe/Khác) — KHÔNG gồm basePlanCost, vì
       * basePlanCost hiển thị thành 1 khối riêng ("Chi phí kế hoạch") ở UI. */
      categoryBreakdown: Partial<Record<CostType, number>>;
    }>;
    totalCost: number;
    basePlanCost: number;
    incurredTotal: number;
    childrenShare: number;
    spentSoFar: number;
    estimatedCostForGroup: number;
    estimatedCostPerAdult: number;
    estimatedCostPerChild: number;
    payableLimitForGroup: number;
    payableLimitPerAdult: number;
    payableLimitPerChild: number;
    // Tổng cả nhóm đã gồm 10% dự trù, làm tròn đến hàng trăm nghìn — dùng để
    // hiển thị con số "to nhất" và làm ngưỡng so sánh cảnh báo vượt ngân sách
    // (thay cho việc mỗi màn tự làm tròn/suy dự trù một kiểu khác nhau).
    reserveCost: number;
    roundedGroupTotal: number;
    contingencyCost: number;
    roundedCostPerAdult: number;
    roundedCostPerChild: number;
    placeCostPerAdult: number;
    placeCostPerChild: number;
    hotelCostPerAdult: number;
    hotelCostPerChild: number;
    transportPerAdult: number;
    // Minh bạch cho UI: hiển thị rõ "Địa điểm/Lưu trú trẻ em = người lớn ×
    // childPriceRatio" thay vì chỉ hiện số trẻ em không rõ căn cứ.
    childPriceRatio: number;
    // Minh bạch cho UI: mức giá/km hiện đang dùng để tính transportPerAdult,
    // để user hiểu con số đó từ đâu ra thay vì thấy "thấp" mà không rõ căn cứ.
    transportRatePerKm: { motorbike: number; car: number };
    adultCount: number;
    childCount: number;
  }> {
    const ctx = await this.loadAccessContext(itineraryId);
    const profiles = await this.itineraryService.getItineraryMemberProfiles(
      itineraryId,
      ctx.creatorId,
    );
    const profileList =
      profiles.length > 0
        ? profiles
        : [
            {
              id: ctx.creatorId,
              fullName: '',
              avatarUrl: '',
              isOwner: true,
            },
          ];

    // Đọc chi phí ước tính ĐÓNG BĂNG (itinerary_cost_estimates) thay vì tính
    // tươi calculateTripCostBreakdown() — placeCost/hotelCost/transportCost
    // RAW đã lấy sẵn, tự suy lại calculatedTripCost RAW (chưa reserve) trong
    // bộ nhớ bằng perAdultTripTotal() (không cần đọc DB thêm).
    const { placeCost, hotelCost, transportCost } =
      await this.itineraryService.getCachedCostBreakdown(itineraryId);
    const participantCount = Math.max(1, ctx.adultCount + ctx.childCount);
    const calculatedTripCost = this.itineraryService.perAdultTripTotal(
      placeCost,
      hotelCost,
      transportCost,
      participantCount,
    );

    const { data: costsData, error } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .select('amount, charged_to, place_id, type')
      .eq('itinerary_id', itineraryId)
      .neq('type', CostType.DIEU_CHINH_GIA)
      // Chi phí kế hoạch đã cộng vào actualBaseCost (computeActualSpending)
      // — tính lại ở đây sẽ double-count. Điều chỉnh xăng xe KHÔNG còn ảnh
      // hưởng gì đến chi phí ước tính đóng băng nữa (chỉ tồn tại như 1 dòng
      // "đã chi" riêng) — vẫn loại khỏi tổng ad-hoc ở đây để không hiện trùng
      // như 1 khoản cá nhân.
      .neq('type', CostType.CHI_PHI_KE_HOACH)
      .neq('type', CostType.DIEU_CHINH_XANG_XE);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load incurred costs: ${error.message}`,
      );
    }
    // price_adjustment rows are excluded above — those are already folded
    // into calculatedTripCost (shared base cost), not a personal charge, so
    // counting them again here would double-charge everyone.
    const incurredCosts = (costsData ?? []).map((row: any) => ({
      amount: Number(row.amount ?? 0),
      chargedTo: Array.isArray(row.charged_to) ? (row.charged_to as string[]) : [],
      placeId: row.place_id ?? null,
      type: row.type as CostType,
    }));
    const incurredTotal = incurredCosts.reduce((sum, c) => sum + c.amount, 0);

    const { childPriceRatio, transportCostPerKm } =
      await this.tripCostConfig.getConfig();
    const memberIds = profileList.map((p) => p.id);

    // Card 3 "mỗi người phải trả" dùng CHI PHÍ THỰC TẾ (chỉ địa điểm đã đi +
    // chi phí phát sinh gắn với địa điểm đã đi), KHÔNG dùng chi phí kế hoạch
    // tĩnh nữa — khớp đúng triết lý của Card 2 (spentSoFar) để 2 con số không
    // lệch nhau về ý nghĩa.
    const { actualBaseCost, visitedIncurredCosts } =
      await this.computeActualSpending(itineraryId, incurredCosts);
    const { totals, categoryTotals, childrenShare, childrenAssignedTo } = distributeCosts(
      memberIds,
      ctx.creatorId,
      ctx.childCount,
      childPriceRatio,
      actualBaseCost,
      visitedIncurredCosts,
    );

    // spentSoFar (Card 2 — tổng CẢ NHÓM đã tiêu) phải nhân theo số người,
    // giống hệt cách estimatedCostForGroup nhân bên dưới — actualBaseCost là
    // per-adult (dùng riêng cho distributeCosts() ở trên, KHÔNG được nhân ở
    // đó vì distributeCosts tự nhân theo từng tài khoản thật + trẻ em).
    // adhocSpent (tổng các khoản incurredCosts khác) đã là số tuyệt đối thật
    // sự đã chi, không nhân thêm — giống cách estimatedCostForGroup cũng
    // không nhân incurredTotal.
    const adhocSpent = visitedIncurredCosts.reduce(
      (sum, cost) => sum + cost.amount,
      0,
    );
    const groupActualBaseCost =
      actualBaseCost * ctx.adultCount + actualBaseCost * childPriceRatio * ctx.childCount;
    const spentSoFar = Math.round(groupActualBaseCost + adhocSpent);

    // Breakdown cho UI "Quản lý chi phí" xổ ra khi bấm vào dòng người
    // lớn/trẻ em (mục "Địa điểm & ăn uống" / "Lưu trú" / "Xăng xe/tự túc").
    // placeCost/hotelCost đã per-adult sẵn (xem itinerary.service.ts) — trẻ
    // em nhân childPriceRatio. transportCost là chi phí xăng xe chia đều
    // theo ĐẦU NGƯỜI THẬT (không phải giá vé), nên dùng CHUNG 1 mức cho cả
    // người lớn và trẻ em, không nhân childPriceRatio.
    const transportPerAdult =
      Math.round(transportCost / participantCount / 1000) * 1000;
    // FIX: chi phí trẻ em phải cộng ĐÚNG 3 thành phần được hiển thị (địa điểm
    // × ratio + khách sạn × ratio + xăng xe KHÔNG nhân ratio) — trước đây
    // dùng calculatedTripCost × ratio, tức là nhân ratio luôn cả phần xăng xe
    // bên trong calculatedTripCost, trái với transportPerAdult hiển thị (dùng
    // chung, không nhân ratio). Chênh lệch đó lộ ra thành số "phí dự trù" vô
    // lý ở dòng trẻ em vì phí dự trù được suy ra bằng phép trừ, hấp thụ luôn
    // phần sai số này.
    const childBaseCost =
      placeCost * childPriceRatio + hotelCost * childPriceRatio + transportPerAdult;

    // Same "group total" formula used throughout (see
    // itinerary.service.ts's estimatedCostForGroup) — applied to both the
    // estimated cost and the user's payable limit. Computed fresh every
    // time, never stored, never divided back.
    const estimatedCostForGroup = Math.round(
      calculatedTripCost * ctx.adultCount + childBaseCost * ctx.childCount,
    );
    const payableLimitForGroup = Math.round(
      ctx.userBudget * ctx.adultCount +
        ctx.userBudget * childPriceRatio * ctx.childCount,
    );
    // Dự trù 10% áp dụng cho TỪNG NGƯỜI, làm tròn đến hàng trăm nghìn — quy
    // ước DÙNG CHUNG cho cả người lớn và trẻ em (không phải làm tròn tổng
    // nhóm rồi chia ngược): mỗi người làm tròn xong mới nhân số người để ra
    // roundedGroupTotal, để tổng nhóm luôn khớp bội số 100.000 gọn gàng.
    const reserveRate = 0.1;
    const roundedCostPerAdult =
      Math.round((calculatedTripCost * (1 + reserveRate)) / 100000) * 100000;
    const roundedCostPerChild =
      ctx.childCount > 0
        ? Math.round((childBaseCost * (1 + reserveRate)) / 100000) * 100000
        : 0;
    const roundedGroupTotal =
      roundedCostPerAdult * ctx.adultCount +
      roundedCostPerChild * ctx.childCount;
    const contingencyCost = roundedGroupTotal - estimatedCostForGroup;
    // reserveCost dùng LẠI đúng contingencyCost (thay vì tự tính riêng
    // estimatedCostForGroup × 10%) — 2 công thức trước đây ra 2 con số "dự
    // trù" khác nhau ở 2 chỗ hiển thị khác nhau trong app, gây lệch số y hệt
    // lỗi ở trên.
    const reserveCost = contingencyCost;

    return {
      memberTotals: profileList.map((p) => {
        const rawCategoryTotals = categoryTotals.get(p.id) ?? {};
        const roundedCategoryTotals: Partial<Record<CostType, number>> = {};
        for (const [type, amount] of Object.entries(rawCategoryTotals)) {
          roundedCategoryTotals[type as CostType] = Math.round(amount ?? 0);
        }
        return {
          userId: p.id,
          fullName: p.fullName,
          isOwner: p.isOwner,
          total: Math.round(totals.get(p.id) ?? 0),
          childrenShare:
            p.id === childrenAssignedTo ? Math.round(childrenShare) : 0,
          categoryBreakdown: roundedCategoryTotals,
        };
      }),
      totalCost: Math.round(calculatedTripCost + incurredTotal),
      basePlanCost: Math.round(calculatedTripCost),
      incurredTotal: Math.round(incurredTotal),
      childrenShare: Math.round(childrenShare),
      spentSoFar,
      estimatedCostForGroup,
      estimatedCostPerAdult: Math.round(calculatedTripCost),
      estimatedCostPerChild: Math.round(childBaseCost),
      payableLimitForGroup,
      payableLimitPerAdult: Math.round(ctx.userBudget),
      payableLimitPerChild: Math.round(ctx.userBudget * childPriceRatio),
      reserveCost,
      roundedGroupTotal,
      contingencyCost,
      roundedCostPerAdult,
      roundedCostPerChild,
      placeCostPerAdult: Math.round(placeCost),
      placeCostPerChild: Math.round(placeCost * childPriceRatio),
      hotelCostPerAdult: Math.round(hotelCost),
      hotelCostPerChild: Math.round(hotelCost * childPriceRatio),
      transportPerAdult,
      childPriceRatio,
      transportRatePerKm: {
        motorbike: transportCostPerKm.motorbike,
        car: transportCostPerKm.car,
      },
      adultCount: ctx.adultCount,
      childCount: ctx.childCount,
    };
  }

  /**
   * "Chi tiết ngày N" trong Sổ chi tiêu — mỗi người phải trả bao nhiêu CHỈ
   * TÍNH CHO NGÀY NÀY (khác computeCostBreakdown, tính cho cả chuyến). Tái
   * dùng đúng distributeCosts() có sẵn (hàm thuần), chỉ khác input là
   * basePlanCost/incurredCosts đã lọc theo ngày. Xăng xe KHÔNG chia theo
   * ngày (điều chỉnh 1 lần/cả chuyến — xem DIEU_CHINH_XANG_XE), nên trả về
   * riêng như số tham khảo của CẢ CHUYẾN, không cộng vào basePlanCost ngày.
   */
  async computeDayCostBreakdown(
    itineraryId: string,
    dayNumber: number,
  ): Promise<{
    memberTotals: Array<{
      userId: string;
      fullName: string;
      isOwner: boolean;
      total: number;
      childrenShare: number;
      categoryBreakdown: Partial<Record<CostType, number>>;
    }>;
    dayBasePlanCost: number;
    childrenShare: number;
    transportPerAdultWholeTrip: number;
  }> {
    const ctx = await this.loadAccessContext(itineraryId);
    await this.validateDayNumber(itineraryId, dayNumber);

    const { data: itinerary, error: itineraryError } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('start_date')
      .eq('id', itineraryId)
      .maybeSingle();
    if (itineraryError) {
      throw new InternalServerErrorException(
        `Failed to load itinerary: ${itineraryError.message}`,
      );
    }
    const startDate = new Date((itinerary as any)?.start_date);
    startDate.setDate(startDate.getDate() + (dayNumber - 1));
    const visitDateStr = startDate.toISOString().slice(0, 10);

    const { data: dayDetails, error: dayDetailsError } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('place_id, detail_type')
      .eq('itinerary_id', itineraryId)
      .eq('visit_date', visitDateStr);
    if (dayDetailsError) {
      throw new InternalServerErrorException(
        `Failed to load day details: ${dayDetailsError.message}`,
      );
    }
    // Khách sạn không thuộc riêng ngày nào — đã tính vào actualBaseCost 1
    // lần duy nhất ở computeCostBreakdown, không lặp lại ở đây.
    const dayPlaceIds = [
      ...new Set(
        (dayDetails ?? [])
          .filter((d: any) => d.detail_type !== 'HOTEL' && d.place_id)
          .map((d: any) => d.place_id as string),
      ),
    ];

    const profiles = await this.itineraryService.getItineraryMemberProfiles(
      itineraryId,
      ctx.creatorId,
    );
    const profileList =
      profiles.length > 0
        ? profiles
        : [{ id: ctx.creatorId, fullName: '', avatarUrl: '', isOwner: true }];
    const memberIds = profileList.map((p) => p.id);
    const { childPriceRatio } = await this.tripCostConfig.getConfig();

    let dayBasePlanCost = 0;
    let dayIncurredCosts: Array<{
      amount: number;
      chargedTo: string[];
      type: CostType;
    }> = [];

    if (dayPlaceIds.length > 0) {
      // Lọc thẳng theo day_number (ghi tại thời điểm check-in, xem
      // recordVisitBaselineExpense()) thay vì chỉ dựa vào visit_date hiện tại
      // của itinerary_details — chính xác hơn nếu lịch trình bị đổi ngày sau
      // khi đã check-in. dayPlaceIds vẫn giữ để loại khách sạn ra (không
      // thuộc riêng ngày nào) và phòng hờ dữ liệu cũ/backfill thiếu
      // day_number (fallback qua place_id).
      const { data: baselineRows, error: baselineError } = await supabase
        .schema('travel')
        .from('incurred_costs')
        .select('amount, place_id')
        .eq('itinerary_id', itineraryId)
        .eq('type', CostType.CHI_PHI_KE_HOACH)
        .eq('day_number', dayNumber)
        .in('place_id', dayPlaceIds);
      if (baselineError) {
        throw new InternalServerErrorException(
          `Failed to load day baseline expenses: ${baselineError.message}`,
        );
      }
      // amount trên dòng baseline đã là giá hiệu lực hiện tại (sửa qua
      // updatePlaceEffectivePrice) — không còn delta riêng để cộng thêm.
      dayBasePlanCost = (baselineRows ?? []).reduce(
        (sum, row: any) => sum + Number(row.amount ?? 0),
        0,
      );
    }

    const { data: adhocRows, error: adhocError } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .select('amount, charged_to, place_id, day_number, type')
      .eq('itinerary_id', itineraryId)
      .neq('type', CostType.DIEU_CHINH_GIA)
      .neq('type', CostType.CHI_PHI_KE_HOACH)
      .neq('type', CostType.DIEU_CHINH_XANG_XE);
    if (adhocError) {
      throw new InternalServerErrorException(
        `Failed to load day incurred costs: ${adhocError.message}`,
      );
    }
    dayIncurredCosts = (adhocRows ?? [])
      .filter(
        (row: any) =>
          row.day_number === dayNumber ||
          (row.place_id && dayPlaceIds.includes(row.place_id)),
      )
      .map((row: any) => ({
        amount: Number(row.amount ?? 0),
        chargedTo: Array.isArray(row.charged_to) ? row.charged_to : [],
        type: row.type as CostType,
      }));

    const { totals, categoryTotals, childrenShare, childrenAssignedTo } =
      distributeCosts(
        memberIds,
        ctx.creatorId,
        ctx.childCount,
        childPriceRatio,
        dayBasePlanCost,
        dayIncurredCosts,
      );

    // Đọc từ bảng chi phí ước tính đóng băng — transport_cost giờ là số
    // THUẦN từ khoảng cách thật, không còn cộng "Điều chỉnh xăng xe" (khoản
    // đó chỉ tồn tại trong incurred_costs, thuộc luồng "đã chi").
    const { transportCost } =
      await this.itineraryService.getCachedCostBreakdown(itineraryId);
    const participantCount = Math.max(1, ctx.adultCount + ctx.childCount);
    const transportPerAdultWholeTrip =
      Math.round(transportCost / participantCount / 1000) * 1000;

    return {
      memberTotals: profileList.map((p) => {
        const rawCategoryTotals = categoryTotals.get(p.id) ?? {};
        const roundedCategoryTotals: Partial<Record<CostType, number>> = {};
        for (const [type, amount] of Object.entries(rawCategoryTotals)) {
          roundedCategoryTotals[type as CostType] = Math.round(amount ?? 0);
        }
        return {
          userId: p.id,
          fullName: p.fullName,
          isOwner: p.isOwner,
          total: Math.round(totals.get(p.id) ?? 0),
          childrenShare:
            p.id === childrenAssignedTo ? Math.round(childrenShare) : 0,
          categoryBreakdown: roundedCategoryTotals,
        };
      }),
      dayBasePlanCost: Math.round(dayBasePlanCost),
      childrenShare: Math.round(childrenShare),
      transportPerAdultWholeTrip,
    };
  }
}
