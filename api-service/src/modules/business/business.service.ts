import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
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
      .rpc('get_places_by_vendor', { p_vendor_id: vendorId })

    if (error) throw new InternalServerErrorException(error.message)
    return data
  }

  async getPlaceDetail(placeId: string) {
    const { data, error } = await supabase
      .schema('travel')
      .rpc('get_place_detail', { p_place_id: placeId })

    if (error) throw new InternalServerErrorException(error.message)
    return data
  }

  async getOrdersByPlace(placeId: string) {
    const { data, error } = await supabase
      .schema('order_sys')
      .rpc('get_orders_by_place', { p_place_id: placeId })

    if (error) throw new InternalServerErrorException(error.message)
    return data
  }

  async getOrderDetail(orderId: string) {
    const { data, error } = await supabase
      .schema('order_sys')
      .rpc('get_order_detail', { p_order_id: orderId })

    if (error) throw new InternalServerErrorException(error.message)
    return data
  }

  async getPlaceServices(placeId: string) {
    const { data, error } = await supabase
      .schema('travel')
      .rpc('get_place_services_and_menu', { p_place_id: placeId })

    if (error) throw new InternalServerErrorException(error.message)
    return data
  }

  async getDashboard(vendorId: string) {
    const { data, error } = await supabase
      .schema('travel')
      .rpc('get_business_dashboard', { p_vendor_id: vendorId })

    if (error) throw new InternalServerErrorException(error.message)
    return data
  }

  parseExcel(file: any) {

    const workbook = XLSX.read(file.buffer, { type: 'buffer' })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]

    const rows = XLSX.utils.sheet_to_json(sheet)

    return rows.map((r: any) => ({
      name: r['Tên món'],
      price: Number(r['Giá bán']),
      description: r['Mô tả']
    }))
  }

  validateMenu(menu: any[]) {

    for (const m of menu) {
      if (!m.name) throw new Error('Thiếu tên món')

      if (!m.price || m.price <= 0)
        throw new Error(`Giá sai: ${m.name}`)
    }
  }

  async createFullPlace(dto: any, file?: any) {

    if (!dto || !dto.name) {
      throw new Error('Thiếu dữ liệu đầu vào')
    }

    let menu: any[] = []

    if (file) {
      menu = this.parseExcel(file)
      this.validateMenu(menu)
    }

    const { data, error } = await supabase
      .schema('travel')
      .rpc('create_full_place', {
        p_name: dto.name,
        p_address: dto.address,
        p_city: dto.city,
        p_lat: dto.latitude,
        p_lng: dto.longitude,
        p_categories: Array.isArray(dto.categories)
          ? dto.categories
          : [], p_services: dto.services || [],
        p_menu: menu.length > 0 ? menu : []
      })

    if (error) {
      console.error(error)
      throw error
    }

    return {
      message: 'Tạo thành công',
      placeId: data
    }
  }
  
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
