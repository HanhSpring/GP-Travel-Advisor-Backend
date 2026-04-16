import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import axios from 'axios';
import { supabase } from '../../config/supabase';
import { EditActivityDto } from './dto/edit-activity.dto';
import { AddActivityDto } from './dto/add-activity.dto';

// ─── Địa chỉ FastAPI optimizer (đọc từ env hoặc dùng mặc định) ───
const AI_SERVICE_URL = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';

@Injectable()
export class ItineraryService {
  // ════════════════════════════════════════════════════════════════
  // CÁC PHƯƠNG THỨC CŨ (GIỮ NGUYÊN)
  // ════════════════════════════════════════════════════════════════

  /** Lấy danh sách lịch trình của user (dùng Supabase RPC) */
  async getMyItineraries(userId: string) {
    const { data, error } = await supabase
      .schema('travel')
      .rpc('get_my_itineraries', { p_user_id: userId });

    if (error) {
      console.error('[ItineraryService] getMyItineraries error:', error);
      throw error;
    }
    return data;
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
    const { error } = await supabase
      .schema('travel')
      .from('itineraries')
      .update({ is_public: isPublic })
      .eq('id', id);

    if (error) {
      throw new InternalServerErrorException(
        'Lỗi khi cập nhật trạng thái: ' + error.message,
      );
    }
    return true;
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
  async editActivity(itineraryId: string, activityId: string, dto: EditActivityDto) {
    // ─── Bước 1: Kiểm tra bản ghi có tồn tại không ───────────────
    const { data: existing, error: fetchErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('id, itinerary_id, visit_date, arrival_time, duration_minutes, is_locked')
      .eq('id', activityId)
      .eq('itinerary_id', itineraryId)
      .single();

    if (fetchErr || !existing) {
      throw new NotFoundException(`Không tìm thấy hoạt động với id: ${activityId}`);
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
      throw new InternalServerErrorException('Lỗi khi cập nhật hoạt động: ' + updateErr.message);
    }

    // ─── Bước 4: Quyết định có cần re-optimize không ─────────────
    // Chỉ gọi FastAPI khi thay đổi ảnh hưởng đến lịch thời gian.
    // Nếu chỉ sửa userNotes → lưu DB rồi trả về ngay, không gọi FastAPI.
    const needsReOptimize =
      dto.arriveTime !== undefined ||      // Đổi giờ đến → các điểm xung quanh phải dịch chuyển
      dto.durationMinutes !== undefined || // Đổi thời gian tham quan → giờ rời đi thay đổi
      dto.isLocked === false;              // Bỏ ghim → optimizer có thể sắp xếp lại

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
      throw new NotFoundException(`Không tìm thấy hoạt động với id: ${activityId}`);
    }

    // ─── Bước 2: Xóa khỏi DB ─────────────────────────────────────
    const { error: deleteErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .delete()
      .eq('id', activityId);

    if (deleteErr) {
      console.error('[ItineraryService] deleteActivity error:', deleteErr);
      throw new InternalServerErrorException('Lỗi khi xóa hoạt động: ' + deleteErr.message);
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
      throw new NotFoundException(`Không tìm thấy lịch trình với id: ${itineraryId}`);
    }

    // ─── Bước 2: Tính toán visit_date từ dayNumber ────────────────
    const startDate = new Date(itinerary.start_date);
    startDate.setDate(startDate.getDate() + (dto.dayNumber - 1));
    const visitDate = startDate.toISOString().split('T')[0]; // 'YYYY-MM-DD'

    // ─── Bước 3: Lấy thông tin địa điểm từ travel.places ─────────
    const { data: place, error: placeErr } = await supabase
      .schema('travel')
      .from('places')
      .select('id, name, address, image_url, average_rating, estimated_cost, category_id')
      .eq('id', dto.placeId)
      .single();

    if (placeErr || !place) {
      throw new NotFoundException(`Không tìm thấy địa điểm với id: ${dto.placeId}`);
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

    // ─── Bước 5: Xác định thời gian và ghim giờ (nếu user có yêu cầu) ─
    const durationMinutes = dto.durationMinutes ?? 60; // Mặc định 60 phút
    const isLocked = !!dto.preferredTime;

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
        locked_arrive_time: dto.preferredTime ?? null,
        arrival_time: dto.preferredTime ?? null, // Sẽ được optimizer ghi đè nếu không ghim
        added_by: 'user', // Đánh dấu user tự thêm (khác với 'ai' do hệ thống tạo)
      })
      .select()
      .single();

    if (insertErr) {
      console.error('[ItineraryService] addActivity insert error:', insertErr);
      throw new InternalServerErrorException('Lỗi khi thêm hoạt động: ' + insertErr.message);
    }

    // ─── Bước 7: Tối ưu lại ngày để sắp xếp địa điểm mới vào đúng chỗ ─
    return this._reOptimizeDay(itineraryId, visitDate);
  }

  /**
   * THAY THẾ một địa điểm bằng địa điểm khác.
   * Giữ nguyên thứ tự trong ngày và thời gian ghim (nếu có).
   *
   * @param itineraryId   - ID lịch trình cha
   * @param activityId    - ID bản ghi cần thay thế
   * @param newPlaceId    - ID địa điểm mới từ travel.places
   */
  async replaceActivity(itineraryId: string, activityId: string, newPlaceId: string) {
    // ─── Bước 1: Lấy thông tin bản ghi cần thay thế ──────────────
    const { data: existing, error: fetchErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('id, visit_date, sequence_order, is_locked, locked_arrive_time, duration_minutes')
      .eq('id', activityId)
      .eq('itinerary_id', itineraryId)
      .single();

    if (fetchErr || !existing) {
      throw new NotFoundException(`Không tìm thấy hoạt động với id: ${activityId}`);
    }

    // ─── Bước 2: Kiểm tra địa điểm mới có tồn tại không ─────────
    const { data: newPlace, error: placeErr } = await supabase
      .schema('travel')
      .from('places')
      .select('id, estimated_cost')
      .eq('id', newPlaceId)
      .single();

    if (placeErr || !newPlace) {
      throw new NotFoundException(`Không tìm thấy địa điểm với id: ${newPlaceId}`);
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
      console.error('[ItineraryService] replaceActivity update error:', updateErr);
      throw new InternalServerErrorException('Lỗi khi thay thế địa điểm: ' + updateErr.message);
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
      .select(`
        id,
        place_id,
        places:place_id (
          id,
          city_id,
          category_id,
          latitude,
          longitude
        )
      `)
      .eq('id', activityId)
      .eq('itinerary_id', itineraryId)
      .single();

    if (fetchErr || !current) {
      throw new NotFoundException(`Không tìm thấy hoạt động với id: ${activityId}`);
    }

    const currentPlace = (current as any).places;

    // ─── Bước 2: Lấy tất cả place_id đã có trong lịch trình (để loại trừ) ─
    const { data: existingDetails } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('place_id')
      .eq('itinerary_id', itineraryId);

    const excludedPlaceIds = (existingDetails ?? []).map((d: any) => d.place_id);

    // ─── Bước 3: Tìm địa điểm cùng danh mục, cùng thành phố, chưa có trong lịch trình ─
    const { data: suggestions, error: suggestErr } = await supabase
      .schema('travel')
      .from('places')
      .select(`
        id,
        name,
        address,
        image_url,
        average_rating,
        estimated_cost,
        latitude,
        longitude,
        categories:category_id (name)
      `)
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
  private async _reOptimizeDay(itineraryId: string, visitDate: string) {
    // ─── Lấy toàn bộ hoạt động trong ngày (JOIN với places) ──────
    const { data: activities, error: fetchErr } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select(`
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
      `)
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
        activities: activities.map((a: any) => ({
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
        })),
        // Mặc định ngày bắt đầu lúc 08:00, kết thúc lúc 21:00
        day_start_time: '08:00',
        day_end_time: '21:00',
      };

      const response = await axios.post(
        `${AI_SERVICE_URL}/api/v1/itinerary/optimize`,
        optimizePayload,
        { timeout: 10000 }, // 10 giây timeout
      );
      optimizedSchedule = response.data.optimized_activities;
    } catch (aiErr) {
      // AI Service không khả dụng → giữ nguyên thứ tự cũ, không throw lỗi
      console.warn('[ItineraryService] AI optimizer không khả dụng, giữ nguyên thứ tự:', aiErr.message);
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
      .select(`
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
          categories:category_id (name)
        )
      `)
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
        Math.round((visit.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    }

    return {
      success: true,
      message: 'Lịch trình đã được cập nhật và sắp xếp lại',
      affectedDay,
      updatedActivities: list.map((a: any) => ({
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
      })),
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
      Math.cos(this._toRad(lat1)) * Math.cos(this._toRad(lat2)) * Math.sin(dLng / 2) ** 2;
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
}
