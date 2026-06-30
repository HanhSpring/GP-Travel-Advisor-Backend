import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import { supabase } from '../../config/supabase';
import { EditActivityDto } from './dto/edit-activity.dto';
import { AddActivityDto } from './dto/add-activity.dto';

import { CreateItineraryDto } from './dto/create-itinerary.dto';

// ─── Địa chỉ FastAPI optimizer (đọc từ env hoặc dùng mặc định) ───
const AI_SERVICE_URL = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';

interface ScheduleEntry {
  location_id: string;
  location_name: string;
  arrival_time: string;
  service_start_time: string;
  departure_time: string;
  active_duration_minutes: number;
  estimated_cost?: number;
  travel_minutes: number;
  distance_km: number;
  transport_cost?: number;
  is_return_to_hotel: boolean;
}

interface PlanDay {
  day: number;
  visited_count: number;
  schedule: ScheduleEntry[];
}

export interface AIPlanResult {
  hotel_id?: string;
  hotel_name?: string;
  num_days: number;
  total_visited: number;
  days: PlanDay[];
}

@Injectable()
export class ItineraryService {
  private readonly logger = new Logger(ItineraryService.name);

  // ════════════════════════════════════════════════════════════════
  // ITINERARY CRUD + LIST QUERIES
  // ════════════════════════════════════════════════════════════════

  /**
   * Returns the current user's itinerary list through the Supabase RPC.
   *
   * `query` comes from GET /itinerary/my-itineraries?q=...
   * The RPC currently searches the trip name stored in `itineraries.description`.
   * Keep this in sync with travel.get_my_itineraries(p_user_id, p_query).
   */
  async getMyItineraries(userId: string, query?: string) {
    const trimmedQuery = query?.trim() || null;
    const { data, error } = await supabase
      .schema('travel')
      .rpc('get_my_itineraries', {
        p_user_id: userId,
        p_query: trimmedQuery,
      });

    if (error) {
      console.error('[ItineraryService] getMyItineraries error:', error);
      throw error;
    }
    return this.withEstimatedListCosts(data);
  }

  private async withEstimatedListCosts(payload: any) {
    const itineraries = Array.isArray(payload?.itineraries)
      ? payload.itineraries
      : [];
    const itineraryIds = itineraries
      .map((item: any) => item?.id)
      .filter(
        (id: any): id is string => typeof id === 'string' && id.length > 0,
      );

    if (itineraryIds.length === 0) {
      return payload;
    }

    const { data: detailRows, error } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('itinerary_id, estimated_cost, transport_cost')
      .in('itinerary_id', itineraryIds);

    if (error) {
      this.logger.warn(
        `Cannot enrich itinerary list estimated costs: ${error.message}`,
      );
      return payload;
    }

    const estimatedByItinerary = new Map<string, number>();
    for (const row of detailRows ?? []) {
      const itineraryId = row.itinerary_id;
      if (!itineraryId) continue;
      const current = estimatedByItinerary.get(itineraryId) ?? 0;
      estimatedByItinerary.set(
        itineraryId,
        current +
          Number(row.estimated_cost ?? 0) +
          Number(row.transport_cost ?? 0),
      );
    }

    return {
      ...payload,
      itineraries: itineraries.map((item: any) => {
        const calculatedEstimatedCost = estimatedByItinerary.get(item.id) ?? 0;
        const userBudget = Number(item.estimated_cost ?? 0);
        return {
          ...item,
          estimated_cost:
            calculatedEstimatedCost > 0
              ? Math.round(calculatedEstimatedCost)
              : item.estimated_cost,
          estimatedCost:
            calculatedEstimatedCost > 0
              ? Math.round(calculatedEstimatedCost)
              : item.estimated_cost,
          user_budget: userBudget,
          userBudget,
        };
      }),
    };
  }

  async createGeneratedItinerary(
    dto: CreateItineraryDto,
    plan: AIPlanResult,
  ): Promise<{ id: string; totalDetails: number; status: string }> {
    this.assertPlanIsUsable(plan);

    const [departureName, destinationName] = await Promise.all([
      this.getCityNameOrNull(dto.departureLocationId),
      this.getCityNameOrNull(dto.destinationLocationId),
    ]);

    const itineraryInsert: Record<string, any> = {
      creator_id: dto.userId,
      // [TRIP_NAME_INPUT] Lưu tên chuyến đi user đặt vào cột description
      description: dto.description ?? null,
      start_date: dto.startDate,
      end_date: dto.endDate,
      estimated_cost: dto.budget,
      status: 'pending',
      departure_point: departureName ?? dto.departureLocationId,
      destination: destinationName ?? dto.destinationLocationId,
      is_public: false,
      adult_count: dto.adultCount,
      children_count: dto.childCount ?? 0,
      trip_intent: dto.tripIntent,
      daily_start_time: dto.dailyStartTime ?? '07:00',
      daily_end_time: dto.dailyEndTime ?? '22:00',
    };

    let insertResult = await supabase
      .schema('travel')
      .from('itineraries')
      .insert(itineraryInsert)
      .select('id')
      .single();

    if (insertResult.error && /trip_intent/i.test(insertResult.error.message)) {
      // Backward-compatible fallback for DBs that have not added trip_intent yet.
      delete itineraryInsert.trip_intent;
      insertResult = await supabase
        .schema('travel')
        .from('itineraries')
        .insert(itineraryInsert)
        .select('id')
        .single();
    }

    const { data: itinerary, error: itineraryError } = insertResult;

    if (itineraryError || !itinerary) {
      throw new InternalServerErrorException(
        'Lỗi khi tạo lịch trình: ' + itineraryError?.message,
      );
    }

    const placeCostById = await this.getPlaceEstimatedCostMap(plan);
    const detailRows = plan.days.flatMap((day) => {
      const schedule = Array.isArray(day.schedule) ? day.schedule : [];
      const visitDate = this.addDays(dto.startDate, day.day - 1);
      const hotelRow = this.buildHotelDetailRow(
        (itinerary as any).id,
        plan,
        visitDate,
        dto.dailyStartTime,
        placeCostById.get(plan.hotel_id ?? '') ?? 0,
      );
      const activityRows = schedule
        .filter((entry) => this.shouldPersistScheduleEntry(entry))
        .map((entry, index) => ({
          itinerary_id: (itinerary as any).id,
          place_id: entry.location_id,
          visit_date: visitDate,
          arrival_time: entry.arrival_time,
          departure_time: entry.departure_time,
          duration_minutes: entry.active_duration_minutes,
          estimated_cost:
            entry.estimated_cost ?? placeCostById.get(entry.location_id) ?? 0,
          transport_cost:
            entry.transport_cost ??
            this.estimateSelfDriveTransportCost(
              entry.distance_km,
              dto.transportMode,
            ),
          sequence_order: index + 1,
          is_locked: false,
        }));
      return [hotelRow, ...activityRows];
    });

    if (detailRows.length === 0) {
      await supabase
        .schema('travel')
        .from('itineraries')
        .delete()
        .eq('id', (itinerary as any).id);
      throw new BadRequestException(
        'AI planner did not return any valid places to persist',
      );
    }

    if (detailRows.length > 0) {
      const { error: detailsError } = await supabase
        .schema('travel')
        .from('itinerary_details')
        .insert(detailRows);

      if (detailsError) {
        // Rollback: xóa itinerary nếu insert detail thất bại
        await supabase
          .schema('travel')
          .from('itineraries')
          .delete()
          .eq('id', (itinerary as any).id);
        throw new InternalServerErrorException(
          'Lỗi khi lưu chi tiết lịch trình: ' + detailsError.message,
        );
      }
    }

    return {
      id: (itinerary as any).id as string,
      totalDetails: detailRows.length,
      status: 'pending',
    };
  }

  /** Tạo lịch trình mới */
  async createItinerary(body: any) {
    const { data, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .insert([body])
      .select();

    if (error) throw error;
    return data;
  }

  /** Lấy lịch trình của user theo creator_id */
  async getMyItinerary(userId: string) {
    const { data, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('*')
      .eq('creator_id', userId);

    if (error) throw error;
    return data;
  }

  /** Bật/Tắt trạng thái công khai của lịch trình */
  async toggleVisibility(id: string, isPublic: boolean) {
    const { data, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .update({ is_public: isPublic })
      .eq('id', id)
      .select('id')
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(
        'Lỗi khi cập nhật trạng thái: ' + error.message,
      );
    }
    if (!data) {
      throw new NotFoundException(`Itinerary not found: ${id}`);
    }
    return true;
  }

  async deleteItinerary(id: string) {
    const { data, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        'Lỗi khi xóa lịch trình: ' + error.message,
      );
    }
    if (!data) {
      throw new NotFoundException(`Itinerary not found: ${id}`);
    }
    return true;
  }

  async updateItinerary(id: string, dto: { description?: string }) {
    const updates: Record<string, any> = {};
    if (dto.description !== undefined) updates.description = dto.description;
    if (!Object.keys(updates).length) return { id };

    const { data, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .update(updates)
      .eq('id', id)
      .select('id, description')
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        'Lỗi khi cập nhật lịch trình: ' + error.message,
      );
    }
    if (!data) {
      throw new NotFoundException(`Itinerary not found: ${id}`);
    }
    return { success: true, ...data };
  }

  // ════════════════════════════════════════════════════════════════
  // TÍNH NĂNG TÙY CHỈNH LỊCH TRÌNH
  // ════════════════════════════════════════════════════════════════

  /**
   * CHỈNH SỬA một hoạt động: thay đổi giờ đến, thời gian tham quan, ghi chú.
   *
   * Logic ghim giờ:
   * - Nếu user truyền `arriveTime` → is_locked = true, locked_arrive_time = arriveTime
   * - Nếu user truyền `isLocked = false` → gỡ ghim
   * - Sau khi lưu, gọi FastAPI để tối ưu lại ngày đó
   *
   * @param itineraryId - ID của lịch trình cha
   * @param activityId  - ID bản ghi itinerary_details cần chỉnh sửa
   * @param dto         - Dữ liệu chỉnh sửa
   * @returns Danh sách hoạt động đã sắp xếp lại trong ngày bị ảnh hưởng
   */
  async editActivity(
    itineraryId: string,
    activityId: string,
    dto: EditActivityDto,
  ) {
    // ─── Bước 1: Kiểm tra bản ghi có tồn tại không ───────────────
    const { data: existing, error: fetchErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        'id, itinerary_id, visit_date, arrival_time, duration_minutes, is_locked',
      )
      .eq('id', activityId)
      .eq('itinerary_id', itineraryId)
      .single();

    if (fetchErr || !existing) {
      throw new NotFoundException(
        `Không tìm thấy hoạt động với id: ${activityId}`,
      );
    }

    // ─── Bước 2: Xây dựng object cập nhật ────────────────────────
    const updates: Record<string, any> = {};

    if (dto.arriveTime !== undefined) {
      // User set giờ mới → tự động ghim
      updates.arrival_time = dto.arriveTime;
      updates.locked_arrive_time = dto.arriveTime;
      updates.is_locked = true;
    }

    if (dto.isLocked === false) {
      // User chủ động bỏ ghim
      updates.is_locked = false;
      updates.locked_arrive_time = null;
    }

    if (dto.durationMinutes !== undefined) {
      updates.duration_minutes = dto.durationMinutes;
    }

    if (dto.userNotes !== undefined) {
      updates.user_notes = dto.userNotes;
    }

    // Không có gì để cập nhật
    if (Object.keys(updates).length === 0) {
      throw new BadRequestException('Không có dữ liệu nào để cập nhật');
    }

    // ─── Bước 3: Lưu vào DB ──────────────────────────────────────
    const { error: updateErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .update(updates)
      .eq('id', activityId);

    if (updateErr) {
      console.error('[ItineraryService] editActivity update error:', updateErr);
      throw new InternalServerErrorException(
        'Lỗi khi cập nhật hoạt động: ' + updateErr.message,
      );
    }

    // ─── Bước 4: Quyết định có cần re-optimize không ─────────────
    // Chỉ gọi FastAPI khi thay đổi ảnh hưởng đến lịch thời gian.
    // Nếu chỉ sửa userNotes → lưu DB rồi trả về ngay, không gọi FastAPI.
    const needsReOptimize =
      dto.arriveTime !== undefined || // Đổi giờ đến → các điểm xung quanh phải dịch chuyển
      dto.durationMinutes !== undefined || // Đổi thời gian tham quan → giờ rời đi thay đổi
      dto.isLocked === false; // Bỏ ghim → optimizer có thể sắp xếp lại

    const visitDate: string = existing.visit_date;

    if (!needsReOptimize) {
      return this._buildDayResponse(itineraryId, visitDate, []);
    }

    return this._reOptimizeDay(itineraryId, visitDate);
  }

  /**
   * XÓA một hoạt động khỏi lịch trình.
   * Sau khi xóa, gọi FastAPI tối ưu lại ngày để lấp khoảng trống thời gian.
   *
   * @param itineraryId - ID lịch trình cha
   * @param activityId  - ID bản ghi itinerary_details cần xóa
   */
  async deleteActivity(itineraryId: string, activityId: string) {
    // ─── Bước 1: Lấy thông tin trước khi xóa (cần visit_date để re-optimize) ─
    const { data: existing, error: fetchErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('id, visit_date')
      .eq('id', activityId)
      .eq('itinerary_id', itineraryId)
      .single();

    if (fetchErr || !existing) {
      throw new NotFoundException(
        `Không tìm thấy hoạt động với id: ${activityId}`,
      );
    }

    // ─── Bước 2: Xóa khỏi DB ─────────────────────────────────────
    const { error: deleteErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .delete()
      .eq('id', activityId);

    if (deleteErr) {
      console.error('[ItineraryService] deleteActivity error:', deleteErr);
      throw new InternalServerErrorException(
        'Lỗi khi xóa hoạt động: ' + deleteErr.message,
      );
    }

    // ─── Bước 3: Tối ưu lại ngày bị ảnh hưởng ───────────────────
    const visitDate: string = existing.visit_date;
    return this._reOptimizeDay(itineraryId, visitDate);
  }

  /**
   * THÊM một địa điểm mới vào lịch trình.
   * Hệ thống tự tìm khe thời gian trống phù hợp trong ngày.
   *
   * @param itineraryId - ID lịch trình cha
   * @param dto         - Thông tin địa điểm muốn thêm
   */
  async addActivity(itineraryId: string, dto: AddActivityDto) {
    // ─── Bước 1: Lấy thông tin lịch trình (cần start_date) ───────
    const { data: itinerary, error: itnErr } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('id, start_date, end_date')
      .eq('id', itineraryId)
      .single();

    if (itnErr || !itinerary) {
      throw new NotFoundException(
        `Không tìm thấy lịch trình với id: ${itineraryId}`,
      );
    }

    // ─── Bước 2: Tính toán visit_date từ dayNumber ────────────────
    const startDate = new Date(itinerary.start_date);
    startDate.setDate(startDate.getDate() + (dto.dayNumber - 1));
    const visitDate = startDate.toISOString().split('T')[0]; // 'YYYY-MM-DD'

    // ─── Bước 3: Lấy thông tin địa điểm từ travel.places ─────────
    const { data: place, error: placeErr } = await supabase
      .schema('travel')
      .from('places')
      .select(
        'id, name, address, image_url, average_rating, estimated_cost, category_id, categories(name)',
      )
      .eq('id', dto.placeId)
      .single();

    if (placeErr || !place) {
      throw new NotFoundException(
        `Không tìm thấy địa điểm với id: ${dto.placeId}`,
      );
    }

    // ─── Bước 4: Lấy sequence_order lớn nhất trong ngày đó ───────
    const { data: maxSeqData } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('sequence_order')
      .eq('itinerary_id', itineraryId)
      .eq('visit_date', visitDate)
      .order('sequence_order', { ascending: false })
      .limit(1)
      .single();

    const nextSequence = maxSeqData ? (maxSeqData.sequence_order ?? 0) + 1 : 1;

    // ─── Bước 5: Xác định thời gian và ghim giờ (nếu user có yêu cầu hoặc auto-assign) ─
    const durationMinutes = dto.durationMinutes ?? 60; // Mặc định 60 phút
    let preferredTime = dto.preferredTime;
    let isLocked = !!dto.preferredTime;

    // Tự động gán giờ cho các loại địa điểm đặc thù nếu người dùng chưa chọn giờ
    if (!preferredTime && place.categories && (place.categories as any).name) {
      const catName = ((place.categories as any).name as string).toLowerCase();
      if (catName.includes('bãi biển') || catName.includes('bãi tắm')) {
        // Gán giờ sáng hoặc chiều mát. Ưu tiên 15:30 chiều.
        preferredTime = '15:30:00';
      } else if (catName.includes('chợ đêm') || catName.includes('phố đi bộ')) {
        preferredTime = '19:00:00';
      } else if (catName.includes('khu du lịch sinh thái')) {
        preferredTime = '08:00:00';
      } else if (catName.includes('chùa') || catName.includes('đền')) {
        preferredTime = '08:30:00';
      }

      if (preferredTime) {
        isLocked = true;
      }
    }

    // ─── Bước 6: Chèn bản ghi mới vào itinerary_details ─────────
    const { data: inserted, error: insertErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .insert({
        itinerary_id: itineraryId,
        place_id: dto.placeId,
        visit_date: visitDate,
        duration_minutes: durationMinutes,
        sequence_order: nextSequence,
        estimated_cost: place.estimated_cost ?? 0,
        is_locked: isLocked,
        locked_arrive_time: preferredTime ?? null,
        arrival_time: preferredTime ?? null, // Sẽ được optimizer ghi đè nếu không ghim
        added_by: 'user', // Đánh dấu user tự thêm (khác với 'ai' do hệ thống tạo)
      })
      .select()
      .single();

    if (insertErr) {
      console.error('[ItineraryService] addActivity insert error:', insertErr);
      throw new InternalServerErrorException(
        'Lỗi khi thêm hoạt động: ' + insertErr.message,
      );
    }

    // ─── Bước 7: Tối ưu lại ngày để sắp xếp địa điểm mới vào đúng chỗ ─
    return this._reOptimizeDay(
      itineraryId,
      visitDate,
      inserted.id,
      (dto as any).allowReduceTime,
    );
  }

  /**
   * THAY THẾ một địa điểm bằng địa điểm khác.
   * Giữ nguyên thứ tự trong ngày và thời gian ghim (nếu có).
   *
   * @param itineraryId   - ID lịch trình cha
   * @param activityId    - ID bản ghi cần thay thế
   * @param newPlaceId    - ID địa điểm mới từ travel.places
   */
  async replaceActivity(
    itineraryId: string,
    activityId: string,
    newPlaceId: string,
  ) {
    // ─── Bước 1: Lấy thông tin bản ghi cần thay thế ──────────────
    const { data: existing, error: fetchErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        'id, visit_date, sequence_order, is_locked, locked_arrive_time, duration_minutes',
      )
      .eq('id', activityId)
      .eq('itinerary_id', itineraryId)
      .single();

    if (fetchErr || !existing) {
      throw new NotFoundException(
        `Không tìm thấy hoạt động với id: ${activityId}`,
      );
    }

    // ─── Bước 2: Kiểm tra địa điểm mới có tồn tại không ─────────
    const { data: newPlace, error: placeErr } = await supabase
      .schema('travel')
      .from('places')
      .select('id, estimated_cost')
      .eq('id', newPlaceId)
      .single();

    if (placeErr || !newPlace) {
      throw new NotFoundException(
        `Không tìm thấy địa điểm với id: ${newPlaceId}`,
      );
    }

    // ─── Bước 3: Cập nhật place_id và chi phí mới, giữ nguyên thứ tự & ghim giờ ─
    const { error: updateErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .update({
        place_id: newPlaceId,
        estimated_cost: newPlace.estimated_cost ?? 0,
        // Giữ nguyên: sequence_order, is_locked, locked_arrive_time, duration_minutes
      })
      .eq('id', activityId);

    if (updateErr) {
      console.error(
        '[ItineraryService] replaceActivity update error:',
        updateErr,
      );
      throw new InternalServerErrorException(
        'Lỗi khi thay thế địa điểm: ' + updateErr.message,
      );
    }

    // ─── Bước 4: Tối ưu lại ngày ─────────────────────────────────
    return this._reOptimizeDay(itineraryId, existing.visit_date);
  }

  /**
   * LẤY GỢI Ý địa điểm thay thế cho một hoạt động.
   * Tìm các địa điểm cùng danh mục, cùng thành phố, chưa có trong lịch trình.
   *
   * @param itineraryId - ID lịch trình
   * @param activityId  - ID hoạt động cần tìm gợi ý thay thế
   */
  async getSuggestions(itineraryId: string, activityId: string) {
    // ─── Bước 1: Lấy thông tin địa điểm hiện tại ─────────────────
    const { data: current, error: fetchErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        `
        id,
        place_id,
        places:place_id (
          id,
          city_id,
          category_id,
          latitude,
          longitude
        )
      `,
      )
      .eq('id', activityId)
      .eq('itinerary_id', itineraryId)
      .single();

    if (fetchErr || !current) {
      throw new NotFoundException(
        `Không tìm thấy hoạt động với id: ${activityId}`,
      );
    }

    const currentPlace = (current as any).places;

    // ─── Bước 2: Lấy tất cả place_id đã có trong lịch trình (để loại trừ) ─
    const { data: existingDetails } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('place_id')
      .eq('itinerary_id', itineraryId);

    const excludedPlaceIds = (existingDetails ?? []).map(
      (d: any) => d.place_id,
    );

    // ─── Bước 3: Tìm địa điểm cùng danh mục, cùng thành phố, chưa có trong lịch trình ─
    const { data: suggestions, error: suggestErr } = await supabase
      .schema('travel')
      .from('places')
      .select(
        `
        id,
        name,
        address,
        image_url,
        average_rating,
        estimated_cost,
        latitude,
        longitude,
        categories:category_id (name)
      `,
      )
      .eq('city_id', currentPlace.city_id)
      .eq('category_id', currentPlace.category_id)
      .not('id', 'in', `(${excludedPlaceIds.join(',')})`)
      .order('average_rating', { ascending: false })
      .limit(8);

    if (suggestErr) {
      console.error('[ItineraryService] getSuggestions error:', suggestErr);
      // Trả về mảng rỗng thay vì ném lỗi để UX mượt hơn
      return { suggestions: [] };
    }

    // ─── Bước 4: Format kết quả với ước tính khoảng cách ────────
    const formatted = (suggestions ?? []).map((p: any) => {
      const timeDiff = this._estimateTimeDiff(
        currentPlace.latitude,
        currentPlace.longitude,
        p.latitude,
        p.longitude,
      );

      return {
        id: p.id,
        name: p.name,
        category: p.categories?.name ?? 'Khác',
        address: p.address,
        imageUrl: p.image_url,
        rating: p.average_rating ?? 0,
        estimatedCost: p.estimated_cost ?? 0,
        isFree: (p.estimated_cost ?? 0) === 0,
        timeDiffLabel: timeDiff,
      };
    });

    return { suggestions: formatted };
  }

  // ════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ════════════════════════════════════════════════════════════════

  /**
   * Gọi FastAPI optimizer để sắp xếp lại thứ tự và thời gian các hoạt động trong một ngày.
   *
   * Flow:
   * 1. Lấy toàn bộ hoạt động của ngày đó từ DB (JOIN với places để có tọa độ, giờ mở cửa)
   * 2. Gửi sang FastAPI /api/v1/itinerary/optimize
   * 3. FastAPI trả về schedule đã tối ưu (có thứ tự mới, arrival_time mới)
   * 4. Cập nhật lại vào DB theo kết quả
   * 5. Trả về danh sách hoạt động đã cập nhật cho controller
   *
   * @param itineraryId - ID lịch trình
   * @param visitDate   - Ngày cần tối ưu ('YYYY-MM-DD')
   */
  private async _reOptimizeDay(
    itineraryId: string,
    visitDate: string,
    newActivityId?: string,
    allowReduceTime: boolean = false,
  ) {
    // ─── Lấy thời gian hoạt động của lịch trình ───────────────────
    const { data: itinerary } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('daily_start_time, daily_end_time')
      .eq('id', itineraryId)
      .single();

    const dailyStartTime = itinerary?.daily_start_time || '07:00';
    const dailyEndTime = itinerary?.daily_end_time || '22:00';

    // ─── Lấy toàn bộ hoạt động trong ngày (JOIN với places) ──────
    const { data: activities, error: fetchErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        `
        id,
        place_id,
        arrival_time,
        duration_minutes,
        is_locked,
        locked_arrive_time,
        sequence_order,
        estimated_cost,
        user_notes,
        added_by,
        places:place_id (
          id,
          name,
          address,
          image_url,
          average_rating,
          review_count,
          estimated_cost,
          latitude,
          longitude,
          open_time,
          close_time,
          categories:category_id (name)
        )
      `,
      )
      .eq('itinerary_id', itineraryId)
      .eq('visit_date', visitDate)
      .order('sequence_order', { ascending: true });

    if (fetchErr || !activities || activities.length === 0) {
      // Không còn hoạt động nào → trả về mảng rỗng
      return this._buildDayResponse(itineraryId, visitDate, []);
    }

    // ─── Gọi FastAPI optimizer ────────────────────────────────────
    let optimizedSchedule: any[] | null = null;
    try {
      const optimizePayload = {
        itinerary_id: itineraryId,
        visit_date: visitDate,
        activities: activities
          .filter((a: any) => !this.isStartPointDetail(a))
          .map((a: any) => ({
            id: a.id,
            place_id: a.place_id,
            duration_minutes: a.duration_minutes ?? 60,
            is_locked: a.is_locked ?? false,
            locked_arrive_time: a.locked_arrive_time ?? null,
            lat: a.places?.latitude ?? null,
            lng: a.places?.longitude ?? null,
            open_time: a.places?.open_time ?? '07:00',
            close_time: a.places?.close_time ?? '22:00',
            estimated_cost: a.estimated_cost ?? 0,
            category: a.places?.categories?.name ?? null,
            is_restaurant: this.isRestaurant(a.places?.categories?.name),
            original_arrival_time: a.arrival_time,
            is_new: newActivityId ? a.id === newActivityId : false,
          })),
        day_start_time: dailyStartTime,
        day_end_time: dailyEndTime,
        allow_reduce_time: allowReduceTime,
      };

      const response = await axios.post(
        `${AI_SERVICE_URL}/api/v1/itinerary/optimize`,
        optimizePayload,
        { timeout: 10000 }, // 10 giây timeout
      );
      optimizedSchedule = response.data.optimized_activities;
    } catch (aiErr) {
      // AI Service không khả dụng → giữ nguyên thứ tự cũ, không throw lỗi
      console.warn(
        '[ItineraryService] AI optimizer không khả dụng, giữ nguyên thứ tự:',
        aiErr instanceof Error ? aiErr.message : String(aiErr),
      );
    }

    // ─── Cập nhật DB theo kết quả tối ưu (nếu có) ────────────────
    if (optimizedSchedule && optimizedSchedule.length > 0) {
      // Cập nhật từng hoạt động theo batch (song song)
      await Promise.all(
        optimizedSchedule.map((opt: any) =>
          supabase
            .schema('travel')
            .from('itinerary_details')
            .update({
              arrival_time: opt.arrival_time,
              departure_time: opt.departure_time,
              sequence_order: opt.sequence_order,
            })
            .eq('id', opt.id),
        ),
      );
    }

    // ─── Đọc lại dữ liệu mới nhất từ DB để trả về client ────────
    return this._buildDayResponse(itineraryId, visitDate, activities);
  }

  /**
   * Đọc lại dữ liệu ngày từ DB và format về cấu trúc response cho client.
   */
  private async _buildDayResponse(
    itineraryId: string,
    visitDate: string,
    fallbackActivities: any[],
  ) {
    const { data: updatedActivities } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        `
        id,
        place_id,
        arrival_time,
        departure_time,
        duration_minutes,
        is_locked,
        locked_arrive_time,
        sequence_order,
        estimated_cost,
        user_notes,
        added_by,
        places:place_id (
          id,
          name,
          address,
          image_url,
          average_rating,
          review_count,
          latitude,
          longitude,
          categories:category_id (name)
        )
      `,
      )
      .eq('itinerary_id', itineraryId)
      .eq('visit_date', visitDate)
      .order('sequence_order', { ascending: true });

    const list = updatedActivities ?? fallbackActivities;

    // ─── Tính số ngày trong lịch trình (để lấy dayNumber) ────────
    const { data: itn } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('start_date')
      .eq('id', itineraryId)
      .single();

    let affectedDay = 1;
    if (itn?.start_date) {
      const start = new Date(itn.start_date);
      const visit = new Date(visitDate);
      affectedDay =
        Math.round(
          (visit.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
        ) + 1;
    }

    return {
      success: true,
      message: 'Lịch trình đã được cập nhật và sắp xếp lại',
      affectedDay,
      updatedActivities: list.map((a: any, idx: number) => {
        const nextA: any = list[idx + 1];
        let transportInfo: string | null = null;
        if (nextA) {
          const p1 = a.places;
          const p2 = nextA.places;
          if (
            p1?.latitude != null &&
            p1?.longitude != null &&
            p2?.latitude != null &&
            p2?.longitude != null
          ) {
            const dist = this._haversineKm(
              p1.latitude,
              p1.longitude,
              p2.latitude,
              p2.longitude,
            );
            transportInfo = `${this._transitMinutes(dist)} phút di chuyển`;
          }
        }
        return {
          id: a.id,
          placeId: a.place_id,
          title: a.places?.name ?? '',
          startTime: a.arrival_time ?? '',
          endTime: a.departure_time ?? '',
          address: a.places?.address ?? '',
          imageUrl: a.places?.image_url ?? '',
          estimatedCost: a.estimated_cost ?? 0,
          isFree: (a.estimated_cost ?? 0) === 0,
          durationMinutes: a.duration_minutes ?? 60,
          isLocked: a.is_locked ?? false,
          lockedArriveTime: a.locked_arrive_time ?? null,
          userNotes: a.user_notes ?? null,
          sequenceOrder: a.sequence_order ?? 0,
          rating: a.places?.average_rating ?? 0,
          reviewCount: a.places?.review_count ?? 0,
          category: a.places?.categories?.name ?? null,
          transportInfo,
        };
      }),
    };
  }

  /**
   * Ước tính thời gian di chuyển thêm giữa 2 điểm (dùng công thức Haversine đơn giản).
   * Trả về chuỗi mô tả VD: "+5 phút" hoặc "~Gần đây"
   *
   * @param lat1, lng1 - Tọa độ điểm hiện tại
   * @param lat2, lng2 - Tọa độ điểm gợi ý
   */
  private _estimateTimeDiff(
    lat1: number | null,
    lng1: number | null,
    lat2: number | null,
    lng2: number | null,
  ): string {
    // Nếu thiếu tọa độ → không ước tính được
    if (!lat1 || !lng1 || !lat2 || !lng2) return 'Gần khu vực';

    // Công thức Haversine tính khoảng cách km
    const R = 6371; // Bán kính Trái Đất (km)
    const dLat = this._toRad(lat2 - lat1);
    const dLng = this._toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this._toRad(lat1)) *
        Math.cos(this._toRad(lat2)) *
        Math.sin(dLng / 2) ** 2;
    const distanceKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    // Ước tính thời gian với vận tốc xe máy ~25km/h trong thành phố
    const minutes = Math.round((distanceKm / 25) * 60);

    if (minutes <= 2) return '~Gần đây';
    if (minutes <= 10) return `+${minutes} phút di chuyển`;
    return `+${minutes} phút (~${distanceKm.toFixed(1)}km)`;
  }

  private _toRad(deg: number): number {
    return deg * (Math.PI / 180);
  }

  /** Khoảng cách thẳng Haversine (km) giữa 2 toạ độ. */
  private _haversineKm(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const R = 6371;
    const dLat = this._toRad(lat2 - lat1);
    const dLng = this._toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this._toRad(lat1)) *
        Math.cos(this._toRad(lat2)) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Ước tính thời gian di chuyển xe máy (phút) từ khoảng cách Haversine.
   * Công thức: đường thực tế ≈ dist × 1.3, tốc độ ~30 km/h → dist × 2.0 + 2
   * Ví dụ: 2km → 6 phút (khớp Google Maps), 5km → 12 phút.
   */
  private _transitMinutes(distKm: number): number {
    return Math.max(3, Math.ceil(distKm * 2.0 + 2));
  }

  async updateActivities(id: string, days: any[]) {
    const { data: itinerary } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('start_date')
      .eq('id', id)
      .single();

    if (!itinerary) throw new Error('Itinerary not found');

    const allActivities: Array<{
      id: string;
      placeId?: string;
      dayNumber: number;
      startTime: string;
      endTime: string;
      sequenceOrder: number;
    }> = [];

    for (const day of days) {
      if (day.activities && Array.isArray(day.activities)) {
        day.activities.forEach((act, index) => {
          allActivities.push({
            id: act.id,
            placeId: act.placeId,
            dayNumber: day.dayNumber,
            startTime: act.startTime,
            endTime: act.endTime,
            sequenceOrder: index + 1,
          });
        });
      }
    }

    const { data: currentActs } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('id')
      .eq('itinerary_id', id);

    const incomingIds = allActivities.map((a) => a.id);
    const toDelete = (currentActs || []).filter(
      (a) => !incomingIds.includes(a.id),
    );

    if (toDelete.length > 0) {
      await supabase
        .schema('travel')
        .from('itinerary_details')
        .delete()
        .in(
          'id',
          toDelete.map((a) => a.id),
        );
    }

    await Promise.all(
      allActivities.map(async (act) => {
        const isUUID =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            act.id,
          );

        if (isUUID) {
          const startDate = new Date(itinerary.start_date);
          startDate.setDate(startDate.getDate() + (act.dayNumber - 1));
          const visitDate = startDate.toISOString().split('T')[0];

          const updatePayload: any = {
            arrival_time: act.startTime,
            departure_time: act.endTime,
            visit_date: visitDate,
            sequence_order: act.sequenceOrder,
          };
          if (act.placeId) {
            updatePayload.place_id = act.placeId;
          }

          const { error } = await supabase
            .schema('travel')
            .from('itinerary_details')
            .update(updatePayload)
            .eq('id', act.id);

          if (error) {
            console.warn(
              `[Supabase] Không thể cập nhật activity ${act.id}: ${error.message}`,
            );
          }
        } else {
          if (!act.placeId) return;

          const startDate = new Date(itinerary.start_date);
          startDate.setDate(startDate.getDate() + (act.dayNumber - 1));
          const visitDate = startDate.toISOString().split('T')[0];

          const { error } = await supabase
            .schema('travel')
            .from('itinerary_details')
            .insert({
              itinerary_id: id,
              place_id: act.placeId,
              visit_date: visitDate,
              arrival_time: act.startTime,
              departure_time: act.endTime,
              sequence_order: act.sequenceOrder,
            });

          if (error) {
            console.warn(
              `[Supabase] Không thể thêm mới activity ${act.id}: ${error.message}`,
            );
          }
        }
      }),
    );

    return true;
  }

  async getItineraryDetail(id: string, touristId?: string) {
    const { data: itinerary, error: itinError } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (itinError) {
      this.logger.error(
        `getItineraryDetail itinerary query failed id=${id}: ${itinError.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to load itinerary: ${itinError.message}`,
      );
    }

    if (!itinerary) {
      throw new NotFoundException(`Itinerary not found: ${id}`);
    }

    const { data: details, error: detailError } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(
        `
        id,
        itinerary_id,
        place_id,
        visit_date,
        arrival_time,
        departure_time,
        notes,
        estimated_cost,
        transport_cost,
        actual_cost,
        duration_minutes,
        sequence_order,
        user_notes,
        locked_arrive_time
      `,
      )
      .eq('itinerary_id', id)
      .order('visit_date', { ascending: true })
      .order('arrival_time', { ascending: true, nullsFirst: true });

    if (detailError) {
      this.logger.error(
        `getItineraryDetail details query failed id=${id}: ${detailError.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to load itinerary details: ${detailError.message}`,
      );
    }

    const placeIds = Array.from(
      new Set(
        (details || [])
          .map((detail: any) => detail.place_id)
          .filter(
            (placeId: unknown): placeId is string =>
              typeof placeId === 'string' && placeId.length > 0,
          ),
      ),
    );

    const placesById = new Map<string, any>();
    if (placeIds.length > 0) {
      const { data: places, error: placesError } = await supabase
        .schema('travel')
        .from('places')
        .select(
          `
          id,
          name,
          address,
          image_url,
          latitude,
          longitude,
          average_rating,
          review_count,
          open_hour_compressed,
          types(categories(name))
        `,
        )
        .in('id', placeIds);

      if (placesError) {
        this.logger.error(
          `getItineraryDetail places query failed id=${id}: ${placesError.message}`,
        );
        throw new InternalServerErrorException(
          `Failed to load itinerary places: ${placesError.message}`,
        );
      }

      for (const place of places || []) {
        placesById.set((place as any).id, place);
      }
    }

    // Lấy trạng thái visit thực tế từ geofence_visits cho itinerary này.
    // Priority: visited > skipped > not_visited (default chuaDi)
    const visitStatusByDetailId = new Map<string, string>();
    try {
      const { data: geoVisits } = await supabase
        .schema('tracking')
        .from('geofence_visits')
        .select('itinerary_detail_id, status')
        .eq('itinerary_id', id);

      for (const v of geoVisits || []) {
        const detailId: string = v.itinerary_detail_id;
        const current = visitStatusByDetailId.get(detailId);
        if (v.status === 'visited') {
          visitStatusByDetailId.set(detailId, 'daDi');
        } else if (v.status === 'skipped' && current !== 'daDi') {
          visitStatusByDetailId.set(detailId, 'diQua');
        }
      }
    } catch (_) {
      // Nếu query tracking thất bại thì vẫn trả về dữ liệu bình thường với status mặc định.
    }

    const daysMap = new Map<string, any[]>();
    for (const detail of details || []) {
      const dateStr = detail.visit_date;
      if (!dateStr) {
        this.logger.warn(
          `Skipping itinerary_detail without visit_date id=${detail.id} itinerary=${id}`,
        );
        continue;
      }
      const list = daysMap.get(dateStr) || [];
      list.push({
        ...detail,
        place: placesById.get(detail.place_id) ?? null,
      });
      daysMap.set(dateStr, list);
    }

    const sortedDates = Array.from(daysMap.keys()).sort();

    const days = sortedDates.map((dateStr, index) => {
      const dayNumber = index + 1;
      const activitiesRaw = daysMap.get(dateStr) || [];

      const activities = activitiesRaw.map((act, actIndex) => {
        const place = act.place;
        const images = place?.image_url;
        const imageUrl =
          Array.isArray(images) && images.length > 0
            ? images[0]
            : typeof images === 'string'
              ? images
              : 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=600&q=80';

        // Tính thời gian di chuyển đến địa điểm kế tiếp bằng Haversine.
        // KHÔNG dùng gap thời gian (departure → nextArrival) vì gap đó bao gồm
        // cả thời gian rảnh (VD: hoạt động kết thúc 09:00, chợ đêm bắt đầu 19:00
        // → gap = 10 tiếng nhưng di chuyển thực tế chỉ ~6 phút).
        const nextAct = activitiesRaw[actIndex + 1];
        let transitInfo: string | null = null;
        if (nextAct) {
          const p1 = act.place;
          const p2 = nextAct.place;
          if (
            p1?.latitude != null &&
            p1?.longitude != null &&
            p2?.latitude != null &&
            p2?.longitude != null
          ) {
            const dist = this._haversineKm(
              p1.latitude,
              p1.longitude,
              p2.latitude,
              p2.longitude,
            );
            const mins = this._transitMinutes(dist);
            transitInfo = `${mins} phút di chuyển`;
          } else {
            transitInfo = this._calcTransitLabel(
              act.departure_time || '',
              nextAct.arrival_time || '',
            );
          }
        }

        const typeData = Array.isArray(place?.types)
          ? place.types[0]
          : place?.types;
        const catData = Array.isArray(typeData?.categories)
          ? typeData.categories[0]
          : typeData?.categories;
        const category: string | null = catData?.name ?? null;
        const durationMinutes = act.duration_minutes ?? 0;
        const sequenceOrder = act.sequence_order ?? actIndex + 1;
        const isAccommodation = this.isAccommodationCategory(category);
        const isStartPoint =
          isAccommodation && durationMinutes === 0 && sequenceOrder === 0;

        return {
          id: act.id,
          placeId: act.place_id,
          sequenceOrder,
          startTime: act.arrival_time || '08:00',
          endTime: act.departure_time || '09:00',
          placeName: place?.name || 'Điểm tham quan',
          address: place?.address || '',
          imageUrl: imageUrl,
          priceLabel: act.estimated_cost
            ? `${act.estimated_cost}đ`
            : 'MIỄN PHÍ',
          tags: [],
          transitToNext: transitInfo
            ? {
                durationStr: transitInfo,
                estimatedCost: act.transport_cost || 0,
              }
            : null,
          transport_info: transitInfo,
          title: place?.name || 'Điểm tham quan',
          locationName: place?.name || 'Điểm tham quan',
          estimatedCost: act.estimated_cost || 0,
          price: act.estimated_cost || 0,
          transportCost: act.transport_cost || 0,
          transport_cost: act.transport_cost || 0,
          currency: 'VNĐ',
          isFree: !act.estimated_cost,
          category,
          durationMinutes,
          isAccommodation,
          isStartPoint,
          open_hour_compressed: place?.open_hour_compressed ?? null,
          latitude: place?.latitude,
          longitude: place?.longitude,
          rating: place?.average_rating || 4.5,
          reviewCount: place?.review_count || 100,
          status: visitStatusByDetailId.get(act.id) ?? 'chuaDi',
        };
      });

      const totalDurationMinutes = activities.reduce(
        (sum, activity) => sum + (activity.durationMinutes ?? 0),
        0,
      );
      const totalActivityCost = activities.reduce(
        (sum, activity) => sum + Number(activity.price ?? 0),
        0,
      );
      const totalTransportCost = activities.reduce(
        (sum, activity) => sum + Number(activity.transportCost ?? 0),
        0,
      );
      const totalDuration = this.formatDuration(totalDurationMinutes);
      const activityCount = activities.filter(
        (activity) => !activity.isStartPoint,
      ).length;

      let dateLabel = dateStr;
      try {
        const parts = dateStr.split('-');
        if (parts.length === 3) {
          dateLabel = `${parts[2]}/${parts[1]}`;
        }
      } catch (_) {}

      return {
        dateLabel: dateLabel,
        dayNumber: dayNumber,
        date: dateStr,
        weatherTemp: 30,
        activeTimeStr: totalDuration,
        dayBudget: totalActivityCost + totalTransportCost,
        progressPercent: 0,
        totalDistanceStr: '0km',
        totalTransitTimeStr: '0 phút',
        activities: activities,
        day_number: dayNumber,
        locations_count: activityCount,
        day_budget: totalActivityCost + totalTransportCost,
        place_cost: totalActivityCost,
        transport_cost: totalTransportCost,
        total_duration: totalDuration,
      };
    });

    const startStr = itinerary.start_date || '';
    const endStr = itinerary.end_date || '';
    const isFavorite = touristId
      ? await this.checkFavoriteItinerary(touristId, id)
      : false;

    let diffDays = 1;
    try {
      const diffTime = Math.abs(
        new Date(endStr).getTime() - new Date(startStr).getTime(),
      );
      diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    } catch (_) {}

    const costRows = (details || []).map((detail: any) => {
      const place = placesById.get(detail.place_id);
      const typeData = Array.isArray(place?.types)
        ? place.types[0]
        : place?.types;
      const catData = Array.isArray(typeData?.categories)
        ? typeData.categories[0]
        : typeData?.categories;
      const isHotel = this.isAccommodationCategory(catData?.name);
      return {
        detail,
        isHotel,
        estimatedCost: Number(detail.estimated_cost ?? 0),
        transportCost: Number(detail.transport_cost ?? 0),
      };
    });
    const hotelIds = new Set(
      costRows
        .filter((row) => row.isHotel && row.detail?.place_id)
        .map((row) => row.detail.place_id),
    );
    const hotelDetailsCount = hotelIds.size;
    const nonHotelDetailsCount = Math.max(
      0,
      costRows.filter((row) => !row.isHotel).length,
    );
    const placeCost = costRows
      .filter((row) => !row.isHotel)
      .reduce((sum, row) => sum + row.estimatedCost, 0);
    const hotelCost = costRows
      .filter((row) => row.isHotel)
      .reduce((sum, row) => sum + row.estimatedCost, 0);
    const transportCost = costRows.reduce(
      (sum, row) => sum + row.transportCost,
      0,
    );
    const rideHailingTransportCost =
      transportCost > 0 ? Math.round(transportCost * 2.5) : 0;
    const estimatedTripCost =
      placeCost + hotelCost + transportCost || itinerary.estimated_cost || 0;

    return {
      id: itinerary.id,
      title: itinerary.description || 'Chi tiết lịch trình',
      tripIntent: itinerary.trip_intent ?? null,
      trip_intent: itinerary.trip_intent ?? null,
      dateRangeLabel: `${startStr} - ${endStr}`,
      status: (itinerary.status || 'pending').toUpperCase(),
      isPublic: itinerary.is_public || false,
      is_favorite: isFavorite,
      isFavorite,
      totalBudget: estimatedTripCost,
      userBudget: itinerary.estimated_cost || 0,
      user_budget: itinerary.estimated_cost || 0,
      totalDays: diffDays || days.length || 1,
      totalPlaces: nonHotelDetailsCount,
      hotelsCount: hotelDetailsCount,
      days: days,
      destination: itinerary.destination || '',
      start_date: startStr,
      end_date: endStr,
      dailyStartTime: itinerary.daily_start_time || '07:00',
      dailyEndTime: itinerary.daily_end_time || '22:00',
      daily_start_time: itinerary.daily_start_time || '07:00',
      daily_end_time: itinerary.daily_end_time || '22:00',
      durationDays: diffDays || days.length || 1,
      activitiesCount: nonHotelDetailsCount,
      estimatedBudget: estimatedTripCost,
      estimated_budget: estimatedTripCost,
      spentBudget: itinerary.actual_cost || 0,
      placeCost,
      place_cost: placeCost,
      hotelCost,
      hotel_cost: hotelCost,
      transportCost,
      transport_cost: transportCost,
      rideHailingTransportCost,
      ride_hailing_transport_cost: rideHailingTransportCost,
      centerCoordinate: [10.7769, 106.7009],
      notes: [
        'Chuẩn bị quần áo thoải mái và phù hợp.',
        'Đem theo các giấy tờ tùy thân đầy đủ.',
      ],
      visitedRestaurants: [],
    };
  }

  private async checkFavoriteItinerary(
    touristId: string,
    itineraryId: string,
  ): Promise<boolean> {
    const { data, error } = await supabase
      .schema('travel')
      .from('favorite_itineraries')
      .select('tourist_id')
      .eq('tourist_id', touristId)
      .eq('itinerary_id', itineraryId)
      .maybeSingle<{ tourist_id: string }>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return Boolean(data);
  }

  /**
   * Tính thời gian di chuyển giữa 2 địa điểm dựa trên gap thời gian.
   * @param departureStr - Giờ rời khỏi địa điểm hiện tại "HH:mm" hoặc "HH:mm:ss"
   * @param nextArrivalStr - Giờ đến địa điểm kế tiếp "HH:mm" hoặc "HH:mm:ss"
   * @returns Chuỗi mô tả như "15 phút di chuyển", "1 giờ 10 phút di chuyển", hoặc null nếu dữ liệu không hợp lệ
   */
  private _calcTransitLabel(
    departureStr: string,
    nextArrivalStr: string,
  ): string | null {
    if (!departureStr || !nextArrivalStr) return null;
    try {
      const toMinutes = (t: string): number => {
        const parts = t.split(':').map(Number);
        return parts[0] * 60 + parts[1];
      };
      const gapMins = toMinutes(nextArrivalStr) - toMinutes(departureStr);
      if (gapMins <= 0) return null;
      if (gapMins < 60) return `${gapMins} phút di chuyển`;
      const h = Math.floor(gapMins / 60);
      const m = gapMins % 60;
      return m === 0 ? `${h} giờ di chuyển` : `${h} giờ ${m} phút di chuyển`;
    } catch (_) {
      return null;
    }
  }

  /**
   * Xác định giờ mở/đóng cửa cho một địa điểm.
   * Ưu tiên: openTime/closeTime tường minh → parse openHourCompressed → default.
   *
   * openHourCompressed format (từ DB / Google):
   *   {"Monday":[["07:00:00","22:00:00"]],"Tuesday":[...],...}
   */
  private _resolveOpenClose(
    openTime: string | null | undefined,
    closeTime: string | null | undefined,
    openHourCompressed: string | null | undefined,
    visitDate: string,
  ): { open_time: string; close_time: string } {
    const DEFAULT = { open_time: '07:00', close_time: '22:00' };

    if (openTime && closeTime) {
      return {
        open_time: openTime.slice(0, 5),
        close_time: closeTime.slice(0, 5),
      };
    }

    if (openHourCompressed) {
      try {
        const hours: Record<string, string[][]> =
          JSON.parse(openHourCompressed);
        const DAY_NAMES = [
          'Sunday',
          'Monday',
          'Tuesday',
          'Wednesday',
          'Thursday',
          'Friday',
          'Saturday',
        ];
        const dayName = DAY_NAMES[new Date(visitDate).getDay()];
        const slots = hours[dayName];
        if (Array.isArray(slots) && slots.length > 0) {
          const [open, close] = slots[0];
          if (open && close) {
            return {
              open_time: String(open).slice(0, 5),
              close_time: String(close).slice(0, 5),
            };
          }
        }
      } catch (_) {
        // JSON parse failed — fall through to default
      }
    }

    return DEFAULT;
  }

  private isRestaurant(category: string | null | undefined): boolean {
    if (!category) return false;
    const lower = category.toLowerCase();
    return (
      lower.includes('nhà hàng') ||
      lower.includes('quán ăn') ||
      lower.includes('nhà ăn') ||
      lower.includes('restaurant') ||
      lower.includes('cafe') ||
      lower.includes('cà phê') ||
      lower.includes('quán bar') ||
      lower.includes('bar')
    );
  }
  async optimizeDayRoute(
    activities: any[],
    dailyStartTime?: string,
    dailyEndTime?: string,
    allowReduceTime: boolean = false,
    visitDate?: string,
  ) {
    if (activities.length <= 2) return activities;

    const resolvedVisitDate =
      visitDate ?? new Date().toISOString().split('T')[0];

    try {
      // ─── Chuẩn bị payload cho TSPTW optimizer (đầy đủ ràng buộc) ─
      const payload = {
        itinerary_id: 'client-optimize', // placeholder — không cần lưu DB
        visit_date: resolvedVisitDate,
        day_start_time: dailyStartTime || '07:00',
        day_end_time: dailyEndTime || '22:00',
        activities: activities.map((a: any) => {
          // Tính duration từ startTime/endTime nếu không có sẵn
          const startMin = this.toMinutes(a.startTime || '07:00');
          const endMin = this.toMinutes(a.endTime || '08:00');
          const duration = endMin - startMin > 0 ? endMin - startMin : 60;

          // openTime/closeTime: ưu tiên trường tường minh, rồi parse openHourCompressed
          const { open_time, close_time } = this._resolveOpenClose(
            a.openTime,
            a.closeTime,
            a.openHourCompressed,
            resolvedVisitDate,
          );

          return {
            id: a.id,
            place_id: a.id, // dùng id làm place_id
            duration_minutes: a.durationMinutes ?? duration,
            is_locked: a.isLocked ?? false,
            locked_arrive_time: a.lockedArriveTime ?? null,
            lat: a.latitude ?? null,
            lng: a.longitude ?? null,
            open_time,
            close_time,
            estimated_cost: a.price ?? 0,
            category: a.category ?? null,
            is_restaurant: this.isRestaurant(a.category),
            original_arrival_time: a.startTime ?? null,
            // Flutter đánh dấu activity mới bằng isNew: true → optimizer chèn vào vị trí tối ưu
            is_new: a.isNew ?? false,
          };
        }),
        allow_reduce_time: allowReduceTime,
      };

      const response = await axios.post(
        `${AI_SERVICE_URL}/api/v1/itinerary/optimize`,
        payload,
        { timeout: 10000 },
      );

      const optimized: any[] = response.data?.optimized_activities ?? [];
      if (optimized.length === 0) return activities;

      // Map kết quả TSPTW về format Flutter mong đợi
      return optimized.map((opt: any) => {
        const original = activities.find((a: any) => a.id === opt.id) ?? {};
        return {
          ...original,
          startTime: opt.arrival_time,
          endTime: opt.departure_time,
          transportInfo: opt.transport_to_next ?? original.transportInfo,
        };
      });
    } catch (e: any) {
      // Python AI service trả về 422 khi lịch kín — phải check 422, không phải 400
      if (
        e.response?.status === 422 &&
        e.response?.data?.detail === 'SCHEDULE_FULL'
      ) {
        throw new BadRequestException('SCHEDULE_FULL');
      }
      console.error('optimizeDayRoute failed:', e);
      return activities; // Fallback: giữ nguyên thứ tự cũ
    }
  }

  private toMinutes(t: string): number {
    if (!t) return 0;
    const parts = t.split(':').map(Number);
    return parts[0] * 60 + parts[1];
  }

  private toTimeString(m: number): string {
    const h = Math.floor(m / 60) % 24;
    const min = m % 60;
    return `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
  }

  // ─── Missing helpers (restored after rebase) ─────────────────────

  /** Cắt bỏ phần giây nếu có, chuẩn hoá về "HH:mm" */
  private trimTime(t: string | null | undefined): string {
    if (!t) return '';
    return t.slice(0, 5);
  }

  /** Ném lỗi nếu plan AI trả về không dùng được */
  private assertPlanIsUsable(plan: AIPlanResult): void {
    if (!plan || !Array.isArray(plan.days) || plan.days.length === 0) {
      throw new BadRequestException(
        'AI planner returned an empty or invalid itinerary plan',
      );
    }
    if (!plan.hotel_id || plan.hotel_id === 'demo_hotel') {
      throw new BadRequestException(
        'AI planner did not return a real hotel for this itinerary',
      );
    }
  }

  /** Lấy tên thành phố theo locationId, trả null nếu không tìm thấy */
  private async getCityNameOrNull(locationId: string): Promise<string | null> {
    if (!locationId) return null;
    const { data } = await supabase
      .schema('travel')
      .from('cities')
      .select('name')
      .eq('id', locationId)
      .maybeSingle();
    return (data as any)?.name ?? null;
  }

  /** Trả true nếu entry nên được lưu vào DB (bỏ qua điểm trả về khách sạn) */
  private shouldPersistScheduleEntry(entry: ScheduleEntry): boolean {
    return !entry.is_return_to_hotel && !!entry.location_id;
  }

  private buildHotelDetailRow(
    itineraryId: string,
    plan: AIPlanResult,
    visitDate: string,
    dailyStartTime: string,
    estimatedCost = 0,
  ) {
    const startTime = this.trimTime(dailyStartTime) || '08:00';
    return {
      itinerary_id: itineraryId,
      place_id: plan.hotel_id,
      visit_date: visitDate,
      arrival_time: startTime,
      departure_time: startTime,
      duration_minutes: 0,
      sequence_order: 0,
      estimated_cost: estimatedCost,
      transport_cost: 0,
      is_locked: true,
      notes: 'Hotel/start point selected by GA planner',
    };
  }

  private async getPlaceEstimatedCostMap(
    plan: AIPlanResult,
  ): Promise<Map<string, number>> {
    const ids = new Set<string>();
    if (plan.hotel_id) ids.add(plan.hotel_id);
    for (const day of plan.days || []) {
      for (const entry of day.schedule || []) {
        if (entry?.location_id) ids.add(entry.location_id);
      }
    }
    if (ids.size === 0) return new Map();

    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .select('id, estimated_cost')
      .in('id', Array.from(ids));

    if (error) {
      this.logger.warn(`Cannot load place estimated costs: ${error.message}`);
      return new Map();
    }

    return new Map(
      (data || []).map((row: any) => [row.id, Number(row.estimated_cost ?? 0)]),
    );
  }

  private estimateSelfDriveTransportCost(
    distanceKm: number | null | undefined,
    transportMode?: string,
  ): number {
    const km = Number(distanceKm ?? 0);
    if (!Number.isFinite(km) || km <= 0) return 0;
    const mode = (transportMode ?? '').toUpperCase();
    const costPerKm = mode === 'MOTORBIKE' ? 3000 : 15000;
    return Math.round(km * costPerKm);
  }

  private formatDuration(totalMinutes: number): string {
    if (!totalMinutes || totalMinutes <= 0) return '0 phút';
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `${hours} giờ ${minutes} phút`;
    if (hours > 0) return `${hours} giờ`;
    return `${minutes} phút`;
  }
  private isAccommodationCategory(category?: string | null): boolean {
    const normalized = (category ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    return (
      normalized.includes('luu tru') ||
      normalized.includes('khach san') ||
      normalized.includes('hotel') ||
      normalized.includes('accommodation')
    );
  }

  private isStartPointDetail(detail: any): boolean {
    return (
      (detail?.sequence_order ?? null) === 0 &&
      (detail?.duration_minutes ?? 0) === 0
    );
  }
  /** Cộng thêm N ngày vào chuỗi ngày 'YYYY-MM-DD', trả về chuỗi mới */
  private addDays(dateStr: string, days: number): string {
    const d = new Date(dateStr);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split('T')[0];
  }
}
