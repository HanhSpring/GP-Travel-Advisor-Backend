import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { BusinessProfileDto } from './dto/business-profile.dto';

@Injectable()
export class BusinessService {
  private supabaseUrl = process.env.SUPABASE_URL || '';
  private supabaseAnonKey = process.env.SUPABASE_KEY || '';

  private getSupabaseUserClient(accessToken: string) {
    return createClient(this.supabaseUrl, this.supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  async getBusinessProfile(userId: string, accessToken: string) {
    const userClient = this.getSupabaseUserClient(accessToken);

    // Gọi RPC version mới nhất
    const { data, error } = await userClient.rpc('get_business_profile', {
      user_id_param: userId,
    });

    if (error || !data || data.length === 0) {
      throw new NotFoundException('Không tìm thấy thông tin đối tác');
    }

    const profile = data[0];

    return {
      // Thông tin cơ bản từ bảng businesses
      fullName: profile.full_name,
      email: profile.email,
      phone: profile.phone_number,
      dob: profile.date_of_birth, // Trả về YYYY-MM-DD
      identityCard: profile.identity_card,
      address: profile.address,

      // Thông tin hệ thống
      isApproved: profile.is_approved,
      joinedAt: profile.created_at,
    };
  }

  async updateProfile(
    userId: string,
    accessToken: string,
    updateDto: BusinessProfileDto,
  ) {
    const userClient = this.getSupabaseUserClient(accessToken);

    const { error } = await userClient.rpc('update_business_profile', {
      user_id_param: userId,
      new_full_name: updateDto.fullName,
      new_phone_number: updateDto.phone,
      new_identity_card: updateDto.identityCard,
      new_dob: updateDto.dob,
      new_address: updateDto.address,
    });

    if (error) {
      throw new BadRequestException(`Cập nhật thất bại: ${error.message}`);
    }

    return { success: true, message: 'Cập nhật thông tin thành công' };
  }
}
