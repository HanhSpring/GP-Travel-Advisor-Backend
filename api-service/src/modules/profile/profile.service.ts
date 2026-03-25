// src/profile/profile.service.ts
import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { TouristProfileDto } from './dto/tourist-profile.dto';

@Injectable()
export class ProfileService {
  private supabaseUrl = process.env.SUPABASE_URL || '';
  private supabaseAnonKey = process.env.SUPABASE_KEY || '';

  // Hàm helper tạo client dựa trên token của user gửi lên
  private getSupabaseUserClient(accessToken: string) {
    return createClient(this.supabaseUrl, this.supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    });
  }

  async getTouristProfile(userId: string, accessToken: string) {
    const userClient = this.getSupabaseUserClient(accessToken);

    // Gọi procedure get_tourist_profile
    const { data, error } = await userClient.rpc('get_tourist_profile', {
      user_id_param: userId,
    });

    if (error || !data || data.length === 0) {
      throw new NotFoundException('Không tìm thấy thông tin hồ sơ');
    }

    const profile = data[0]; // RPC trả về mảng kết quả
    return {
      displayName: profile.full_name,
      gender: profile.gender,
      phoneNumber: profile.phone_number,
      email: profile.email,
      travelPreferences: profile.travel_preferences,
    };
  }

  async updateTouristProfile(
    userId: string,
    accessToken: string,
    updateDto: TouristProfileDto,
  ) {
    const userClient = this.getSupabaseUserClient(accessToken);

    const { error } = await userClient.rpc('update_tourist_profile', {
      user_id_param: userId,
      new_full_name: updateDto.displayName,
      new_gender: updateDto.gender,
      // new_phone_number: updateDto.phoneNumber,
      // new_email: updateDto.email,
      new_preferences: updateDto.travelPreferences,
    });

    if (error) {
      console.error('Lỗi RPC Update:', error.message);
      throw new Error('Cập nhật hồ sơ thất bại qua Database Procedure');
    }

    return { message: 'Lưu thay đổi thành công qua Procedure' };
  }
}
