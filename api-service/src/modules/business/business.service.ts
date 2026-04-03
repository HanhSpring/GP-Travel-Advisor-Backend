import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { BusinessProfileDto } from './dto/business-profile.dto';
import { supabase } from '../../config/supabase';
import * as XLSX from 'xlsx';

@Injectable()
export class BusinessService {
  private supabaseUrl = process.env.SUPABASE_URL || '';
  private supabaseAnonKey = process.env.SUPABASE_KEY || '';

  async getVendorPlaces(vendorId: string) {
    const { data, error } = await supabase
      .schema('travel')
      .rpc('get_places_by_vendor', { p_vendor_id: vendorId });

    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  async getPlaceDetail(placeId: string) {
    const { data, error } = await supabase
      .schema('travel')
      .rpc('get_place_detail', { p_place_id: placeId });

    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  async getOrdersByPlace(placeId: string) {
    const { data, error } = await supabase
      .schema('order_sys')
      .rpc('get_orders_by_place', { p_place_id: placeId });

    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  async getOrderDetail(orderId: string) {
    const { data, error } = await supabase
      .schema('order_sys')
      .rpc('get_order_detail', { p_order_id: orderId });

    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  async getPlaceServices(placeId: string) {
    const { data, error } = await supabase
      .schema('travel')
      .rpc('get_place_services_and_menu', { p_place_id: placeId });

    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  async getDashboard(vendorId: string) {
    const { data, error } = await supabase
      .schema('travel')
      .rpc('get_business_dashboard', { p_vendor_id: vendorId });

    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  parseExcel(file: any) {
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    const rows = XLSX.utils.sheet_to_json(sheet);

    return rows.map((r: any) => ({
      name: r['Tên món'],
      price: Number(r['Giá bán']),
      description: r['Mô tả'],
    }));
  }

  validateMenu(menu: any[]) {
    for (const m of menu) {
      if (!m.name) throw new Error('Thiếu tên món');

      if (!m.price || m.price <= 0) throw new Error(`Giá sai: ${m.name}`);
    }
  }

  async createFullPlace(dto: any, file?: any) {
    if (!dto || !dto.name) {
      throw new Error('Thiếu dữ liệu đầu vào');
    }

    let menu: any[] = [];

    if (file) {
      menu = this.parseExcel(file);
      this.validateMenu(menu);
    }

    const { data, error } = await supabase
      .schema('travel')
      .rpc('create_full_place', {
        p_name: dto.name,
        p_address: dto.address,
        p_city: dto.city,
        p_lat: dto.latitude,
        p_lng: dto.longitude,
        p_categories: Array.isArray(dto.categories) ? dto.categories : [],
        p_services: dto.services || [],
        p_menu: menu.length > 0 ? menu : [],
      });

    if (error) {
      console.error(error);
      throw error;
    }

    return {
      message: 'Tạo thành công',
      placeId: data,
    };
  }

  private getSupabaseUserClient(accessToken: string) {
    return createClient(this.supabaseUrl, this.supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  async getBusinessProfile(userId: string, accessToken: string) {
    const userClient = this.getSupabaseUserClient(accessToken);

    const { data, error } = await userClient.rpc('get_business_profile', {
      user_id_param: userId,
    });

    if (error || !data || data.length === 0) {
      throw new NotFoundException('Không tìm thấy thông tin đối tác');
    }

    const profile = data[0];

    return {
      fullName: profile.full_name,
      email: profile.email,
      phone: profile.phone_number,
      dob: profile.date_of_birth,
      identityCard: profile.identity_card,
      address: profile.address,
      avatarUrl: profile.avatar_url,

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
    const supabaseUrl = process.env.SUPABASE_URL as string;
    const supabaseKey = process.env.SUPABASE_KEY as string;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

    const isChangingPassword = updateDto.oldPassword && updateDto.newPassword;
    const isMissingOnePassword =
      (updateDto.oldPassword && !updateDto.newPassword) ||
      (!updateDto.oldPassword && updateDto.newPassword);

    if (isMissingOnePassword) {
      throw new BadRequestException(
        'Vui lòng nhập đầy đủ mật khẩu hiện tại và mật khẩu mới.',
      );
    }

    if (isChangingPassword) {
      const {
        data: { user },
        error: userError,
      } = await userClient.auth.getUser();
      if (userError || !user || !user.email) {
        throw new UnauthorizedException(
          'Không thể xác thực danh tính người dùng.',
        );
      }

      const tempAuthClient = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { error: signInError } =
        await tempAuthClient.auth.signInWithPassword({
          email: user.email,
          password: updateDto.oldPassword!,
        });

      if (signInError) {
        throw new BadRequestException('Mật khẩu hiện tại không chính xác.');
      }

      // 3. Mật khẩu cũ đúng -> Cập nhật mật khẩu mới bằng quyền Admin
      if (!serviceRoleKey) {
        throw new InternalServerErrorException(
          'Server thiếu cấu hình SUPABASE_SERVICE_ROLE_KEY',
        );
      }
      const adminClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { error: updatePassError } =
        await adminClient.auth.admin.updateUserById(userId, {
          password: updateDto.newPassword,
        });

      if (updatePassError) {
        throw new BadRequestException(
          `Lỗi khi đổi mật khẩu: ${updatePassError.message}`,
        );
      }
    }

    const { error: profileError } = await userClient.rpc(
      'update_business_profile',
      {
        user_id_param: userId,
        new_full_name: updateDto.fullName || null,
        new_phone_number: updateDto.phone || null,
        new_identity_card: updateDto.identityCard || null,
        new_dob: updateDto.dob || null,
        new_address: updateDto.address || null,
      },
    );

    if (profileError) {
      throw new BadRequestException(
        `Cập nhật thông tin thất bại: ${profileError.message}`,
      );
    }

    const message = isChangingPassword
      ? 'Cập nhật hồ sơ và đổi mật khẩu thành công.'
      : 'Cập nhật thông tin hồ sơ thành công.';

    return { success: true, message };
  }
}
