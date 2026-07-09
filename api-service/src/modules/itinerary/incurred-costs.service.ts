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

export interface IncurredCostRow {
  id: string;
  itinerary_id: string;
  place_id: string | null;
  note: string;
  amount: number;
  charged_to: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface ItineraryAccessContext {
  creatorId: string;
  status: string;
  adultCount: number;
  childCount: number;
  /** [creatorId, ...itinerary_members] — real accounts only, owner first. */
  memberIds: string[];
}

/**
 * Chia 1 khoản chi (hoặc chi phí gốc theo kế hoạch) cho các thành viên thật
 * của lịch trình. Không có khái niệm "ai đã ứng tiền trước" (paid_by) — chỉ
 * tính "mỗi người phải gánh tổng bao nhiêu" (mục 1.6-1.7).
 *
 * Trẻ em không có tài khoản nên không xuất hiện như một người chịu phí riêng
 * — childPriceRatio chỉ ảnh hưởng tới MẪU SỐ khi chia đều cả nhóm (mỗi tài
 * khoản người lớn nhận đúng 1 "phần người lớn" của khoản chia đều đó).
 */
export function distributeCosts(
  memberIds: string[],
  adultCount: number,
  childCount: number,
  childPriceRatio: number,
  basePlanCost: number,
  incurredCosts: Array<{ amount: number; chargedTo: string[] }>,
): Map<string, number> {
  const totals = new Map<string, number>(memberIds.map((id) => [id, 0]));
  if (memberIds.length === 0) return totals;

  const weightedHeadcount = Math.max(
    0.01,
    adultCount + childCount * childPriceRatio,
  );

  // Chi phí gốc theo kế hoạch: chia đều cho các tài khoản thật đang có. Chi
  // phí trẻ em đã được chiết khấu ngay từ lúc ước tính (mục 1.3), không tính
  // trọng số lần 2 ở đây.
  const baseShare = basePlanCost / memberIds.length;
  for (const id of memberIds) totals.set(id, (totals.get(id) ?? 0) + baseShare);

  for (const cost of incurredCosts) {
    const chargedTo = cost.chargedTo.filter((id) => memberIds.includes(id));
    if (chargedTo.length === 0) {
      // Chia đều cả nhóm: mỗi tài khoản thật nhận đúng 1 "phần người lớn".
      const perShare = cost.amount / weightedHeadcount;
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
  return totals;
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
      .select('id, creator_id, status, adult_count, children_count')
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

  private assertCanModify(
    ctx: ItineraryAccessContext,
    cost: IncurredCostRow,
    userId: string,
  ): void {
    const isOwner = ctx.creatorId === userId;
    const isCreator = cost.created_by === userId;
    if (!isOwner && !isCreator) {
      throw new ForbiddenException(
        'Chỉ chủ lịch trình hoặc người tạo khoản chi này mới được sửa/xoá',
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

  /** Danh sách địa điểm đã "visited" trong lịch trình — dùng cho combobox. */
  async getEligiblePlaces(itineraryId: string, userId: string) {
    const ctx = await this.loadAccessContext(itineraryId);
    this.assertCallerIsMember(ctx, userId);

    const { data: detailRows, error } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('id, place_id')
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
    return places ?? [];
  }

  async createIncurredCost(
    itineraryId: string,
    dto: CreateIncurredCostDto,
  ): Promise<IncurredCostRow> {
    const ctx = await this.loadAccessContext(itineraryId);
    this.assertCallerIsMember(ctx, dto.userId);
    this.assertNotLocked(ctx);

    if (dto.placeId) {
      await this.validatePlaceId(itineraryId, dto.placeId);
    }
    const chargedTo = this.validateChargedTo(ctx, dto.chargedTo);

    const { data, error } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .insert({
        itinerary_id: itineraryId,
        place_id: dto.placeId ?? null,
        note: dto.note,
        amount: dto.amount,
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

    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (dto.note !== undefined) update.note = dto.note;
    if (dto.amount !== undefined) update.amount = dto.amount;
    if (dto.placeId !== undefined) {
      if (dto.placeId) {
        await this.validatePlaceId(itineraryId, dto.placeId);
      }
      update.place_id = dto.placeId;
    }
    if (dto.chargedTo !== undefined) {
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
  async computeCostBreakdown(itineraryId: string): Promise<{
    memberTotals: Array<{
      userId: string;
      fullName: string;
      isOwner: boolean;
      total: number;
    }>;
    totalCost: number;
    basePlanCost: number;
    incurredTotal: number;
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

    const { calculatedTripCost } =
      await this.itineraryService.calculateTripCostBreakdown(itineraryId);

    const { data: costsData, error } = await supabase
      .schema('travel')
      .from('incurred_costs')
      .select('amount, charged_to')
      .eq('itinerary_id', itineraryId);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load incurred costs: ${error.message}`,
      );
    }
    const incurredCosts = (costsData ?? []).map((row: any) => ({
      amount: Number(row.amount ?? 0),
      chargedTo: Array.isArray(row.charged_to) ? (row.charged_to as string[]) : [],
    }));
    const incurredTotal = incurredCosts.reduce((sum, c) => sum + c.amount, 0);

    const { childPriceRatio } = await this.tripCostConfig.getConfig();
    const memberIds = profileList.map((p) => p.id);
    const totals = distributeCosts(
      memberIds,
      ctx.adultCount,
      ctx.childCount,
      childPriceRatio,
      calculatedTripCost,
      incurredCosts,
    );

    return {
      memberTotals: profileList.map((p) => ({
        userId: p.id,
        fullName: p.fullName,
        isOwner: p.isOwner,
        total: Math.round(totals.get(p.id) ?? 0),
      })),
      totalCost: Math.round(calculatedTripCost + incurredTotal),
      basePlanCost: Math.round(calculatedTripCost),
      incurredTotal: Math.round(incurredTotal),
    };
  }
}
