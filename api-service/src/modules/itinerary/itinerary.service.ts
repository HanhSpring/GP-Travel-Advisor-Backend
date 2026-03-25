import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { supabase } from '../../config/supabase';

@Injectable()
export class ItineraryService {

  async getMyItineraries(userId: string) {

    const { data, error } = await supabase
      .schema('travel')
      .rpc('get_my_itineraries', {
        p_user_id: userId
      })

    if (error) {
      console.error("Supabase RPC error:", error)
      throw error
    }

    return data
  }

  async createItinerary(body: any) {
    const { data, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .insert([body])
      .select();

    if (error) throw error;

    return data;
  }

  async getMyItinerary(userId: string) {
    const { data, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('*')
      .eq('creator_id', userId);

    if (error) throw error;

    return data;
  }

  // Gạt công tắc trạng thái công khai
  async toggleVisibility(id: string, isPublic: boolean) {
    const { error } = await supabase
      .schema('travel')
      .from('itineraries')
      .update({ is_public: isPublic }) // Cập nhật cột is_public
      .eq('id', id);

    if (error) {
      throw new InternalServerErrorException(
        'Lỗi khi cập nhật trạng thái: ' + error.message,
      );
    }

    return true;
  }

  // Xóa địa điểm và tái tính toán (Logic AI)
  async deleteActivity(itineraryId: string, activityId: string) {
    // 1. Lệnh xóa mềm hoặc xóa cứng hoạt động trong Database
    // (Tùy thuộc vào việc nhóm bạn tách bảng activities hay lưu chung trong JSONB)
    /* const { error } = await supabase
      .schema('travel')
      .from('itinerary_activities')
      .delete()
      .eq('id', activityId)
      .eq('itinerary_id', itineraryId);
    */

    // 2. Kích hoạt logic Multi-AI Agent để nội suy lại khoảng cách (Dry run)
    console.log(
      `[AI Agent] Đang tính toán lại lộ trình di chuyển cho Itinerary ${itineraryId} sau khi xóa Activity ${activityId}...`,
    );

    // 3. (Tương lai) Nhận kết quả từ AI và Update lại thông tin Transit vào DB

    return true;
  }
}
