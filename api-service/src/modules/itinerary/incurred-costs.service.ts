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
  incurredCosts: Array<{ amount: number; chargedTo: string[] }>,
): CostDistributionResult {
  const totals = new Map<string, number>(memberIds.map((id) => [id, 0]));
  if (memberIds.length === 0) {
    return { totals, childrenShare: 0, childrenAssignedTo: null };
  }

  // Sharing không thay đổi giá: mỗi tài khoản thật gánh đúng basePlanCost
  // (phần của riêng họ — trẻ em KHÔNG được cộng vào đây, xem childrenShare).
  for (const id of memberIds) {
    totals.set(id, (totals.get(id) ?? 0) + basePlanCost);
  }

  const childrenShare =
    childCount > 0 ? childCount * basePlanCost * childPriceRatio : 0;
  const childrenAssignedTo =
    childCount > 0 && totals.has(ownerId) ? ownerId : null;

  for (const cost of incurredCosts) {
    const chargedTo = cost.chargedTo.filter((id) => memberIds.includes(id));
    if (chargedTo.length === 0) {
      // Tài khoản thật chỉ có người lớn trong mô hình này — chia đều, không
      // cần trọng số.
      const perShare = cost.amount / memberIds.length;
      for (const id of memberIds) {
        totals.set(id, (totals.get(id) ?? 0) + perShare);
      }
    } else if (chargedTo.length === 1) {
      totals.set(chargedTo[0], (totals.get(chargedTo[0]) ?? 0) + cost.amount);
    } else {
      const share = cost.amount / chargedTo.length;
      for (const id of chargedTo) {
        totals.set(id, (totals.get(id) ?? 0) + share);
      }
    }
  }
  return { totals, childrenShare, childrenAssignedTo };
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
    if (cost.type === CostType.DIEU_CHINH_GIA) {
      if (!isOwner) {
        throw new ForbiddenException(
          'Chỉ chủ lịch trình mới được sửa/xoá điều chỉnh giá',
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

  /** Toàn bộ itinerary_details id đã ở trạng thái "visited" — dùng cho "chi
   * phí thực tế đã tiêu" (Card 2), khác với validatePlaceId() ở chỗ đây lấy
   * TẤT CẢ id đã đi thay vì kiểm tra 1 địa điểm cụ thể. */
  private async getVisitedDetailIds(itineraryId: string): Promise<Set<string>> {
    const { data: detailRows, error } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('id')
      .eq('itinerary_id', itineraryId);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load itinerary details: ${error.message}`,
      );
    }
    const detailIds = (detailRows ?? []).map((d: any) => d.id);
    if (detailIds.length === 0) return new Set();

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
    return new Set((visits ?? []).map((v: any) => v.itinerary_detail_id));
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

    // currentEffectivePrice = the itinerary_details.estimated_cost for that
    // place (per-adult, see recommendation.service.ts) plus any
    // price_adjustment already applied — shown as a reference when the
    // owner picks type=price_adjustment so they know what they're correcting
    // (mục "hiển thị giá vé của place đó").
    const rawCostByPlace = new Map<string, number>();
    for (const d of details) {
      const placeId = (d as any).place_id as string;
      if (!rawCostByPlace.has(placeId)) {
        rawCostByPlace.set(placeId, Number((d as any).estimated_cost ?? 0));
      }
    }
    const priceAdjustmentDeltas =
      await this.itineraryService.loadPriceAdjustmentDeltasByPlace(
        itineraryId,
      );

    return (places ?? []).map((place: any) => ({
      ...place,
      currentEffectivePrice:
        (rawCostByPlace.get(place.id) ?? 0) +
        (priceAdjustmentDeltas.get(place.id) ?? 0),
    }));
  }

  /** Làm tròn đến đơn vị nghìn (1k) và bắt buộc tối thiểu 1.000đ (âm hoặc
   * dương, theo trị tuyệt đối — price_adjustment vẫn phải là 1 chênh lệch
   * đáng kể, không phải vài trăm đồng). Trả về giá trị đã làm tròn để lưu
   * — không tin vào con số client gửi lên. */
  private normalizeAndValidateAmount(type: CostType, amount: number): number {
    const rounded = Math.round(amount / 1000) * 1000;
    if (type !== CostType.DIEU_CHINH_GIA && rounded <= 0) {
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
    const amount = this.normalizeAndValidateAmount(type, dto.amount);

    const isPriceAdjustment = type === CostType.DIEU_CHINH_GIA;
    if (isPriceAdjustment && dto.userId !== ctx.creatorId) {
      throw new ForbiddenException(
        'Chỉ chủ lịch trình mới được điều chỉnh giá địa điểm',
      );
    }
    if (isPriceAdjustment && !dto.placeId) {
      throw new BadRequestException(
        'Điều chỉnh giá phải gắn với 1 địa điểm cụ thể',
      );
    }

    if (dto.placeId) {
      await this.validatePlaceId(itineraryId, dto.placeId);
    }
    // price_adjustment thay đổi chi phí nền dùng chung — không gán riêng cho
    // ai, nên charged_to luôn bị ép rỗng bất kể client gửi gì.
    const chargedTo = isPriceAdjustment
      ? []
      : this.validateChargedTo(ctx, dto.chargedTo);

    const { data, error } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .insert({
        itinerary_id: itineraryId,
        place_id: dto.placeId ?? null,
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
    filters: { placeId?: string; userId?: string } = {},
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
    const isPriceAdjustment = effectiveType === CostType.DIEU_CHINH_GIA;
    const normalizedAmount =
      dto.amount !== undefined
        ? this.normalizeAndValidateAmount(effectiveType, dto.amount)
        : undefined;
    if (isPriceAdjustment) {
      const effectivePlaceId =
        dto.placeId !== undefined ? dto.placeId : cost.place_id;
      if (!effectivePlaceId) {
        throw new BadRequestException(
          'Điều chỉnh giá phải gắn với 1 địa điểm cụ thể',
        );
      }
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
    // price_adjustment không bao giờ gán riêng cho ai — bỏ qua chargedTo dù
    // client có gửi.
    if (dto.chargedTo !== undefined && !isPriceAdjustment) {
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
  private async computeActualSpending(
    itineraryId: string,
    adhocCosts: Array<{ amount: number; chargedTo: string[]; placeId: string | null }>,
  ): Promise<{
    spentSoFar: number;
    /** Per-adult, chỉ địa điểm/khách sạn ĐÃ ĐI (không gồm xăng xe — khớp
     * spentSoFar). Dùng làm gốc chia cho distributeCosts() ở Card 3. */
    actualBaseCost: number;
    visitedIncurredCosts: Array<{ amount: number; chargedTo: string[] }>;
  }> {
    const visitedDetailIds = await this.getVisitedDetailIds(itineraryId);
    const { placeCost, hotelCost } =
      await this.itineraryService.calculateTripCostBreakdown(
        itineraryId,
        visitedDetailIds,
      );
    const actualBaseCost = placeCost + hotelCost;

    const { data: detailRows, error } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('id, place_id')
      .eq('itinerary_id', itineraryId);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load itinerary details: ${error.message}`,
      );
    }
    const visitedPlaceIds = new Set(
      (detailRows ?? [])
        .filter((d: any) => visitedDetailIds.has(d.id) && d.place_id)
        .map((d: any) => d.place_id as string),
    );

    const visitedIncurredCosts = adhocCosts.filter(
      (cost) => !cost.placeId || visitedPlaceIds.has(cost.placeId),
    );
    const adhocSpent = visitedIncurredCosts.reduce(
      (sum, cost) => sum + cost.amount,
      0,
    );

    return {
      spentSoFar: Math.round(actualBaseCost + adhocSpent),
      actualBaseCost,
      visitedIncurredCosts,
    };
  }

  async computeCostBreakdown(itineraryId: string): Promise<{
    memberTotals: Array<{
      userId: string;
      fullName: string;
      isOwner: boolean;
      total: number;
      childrenShare: number;
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

    const { calculatedTripCost, placeCost, hotelCost, transportCost } =
      await this.itineraryService.calculateTripCostBreakdown(itineraryId);

    const { data: costsData, error } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .select('amount, charged_to, place_id, type')
      .eq('itinerary_id', itineraryId)
      .neq('type', CostType.DIEU_CHINH_GIA);
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
    }));
    const incurredTotal = incurredCosts.reduce((sum, c) => sum + c.amount, 0);

    const { childPriceRatio, transportCostPerKm } =
      await this.tripCostConfig.getConfig();
    const memberIds = profileList.map((p) => p.id);

    // Card 3 "mỗi người phải trả" dùng CHI PHÍ THỰC TẾ (chỉ địa điểm đã đi +
    // chi phí phát sinh gắn với địa điểm đã đi), KHÔNG dùng chi phí kế hoạch
    // tĩnh nữa — khớp đúng triết lý của Card 2 (spentSoFar) để 2 con số không
    // lệch nhau về ý nghĩa.
    const { spentSoFar, actualBaseCost, visitedIncurredCosts } =
      await this.computeActualSpending(itineraryId, incurredCosts);
    const { totals, childrenShare, childrenAssignedTo } = distributeCosts(
      memberIds,
      ctx.creatorId,
      ctx.childCount,
      childPriceRatio,
      actualBaseCost,
      visitedIncurredCosts,
    );

    // Breakdown cho UI "Quản lý chi phí" xổ ra khi bấm vào dòng người
    // lớn/trẻ em (mục "Địa điểm & ăn uống" / "Lưu trú" / "Xăng xe/tự túc").
    // placeCost/hotelCost đã per-adult sẵn (xem itinerary.service.ts) — trẻ
    // em nhân childPriceRatio. transportCost là chi phí xăng xe chia đều
    // theo ĐẦU NGƯỜI THẬT (không phải giá vé), nên dùng CHUNG 1 mức cho cả
    // người lớn và trẻ em, không nhân childPriceRatio.
    const participantCount = Math.max(1, ctx.adultCount + ctx.childCount);
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
      memberTotals: profileList.map((p) => ({
        userId: p.id,
        fullName: p.fullName,
        isOwner: p.isOwner,
        total: Math.round(totals.get(p.id) ?? 0),
        childrenShare:
          p.id === childrenAssignedTo ? Math.round(childrenShare) : 0,
      })),
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
}
