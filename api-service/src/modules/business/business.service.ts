import { AppConfig } from '../../config/app.config';
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
import { GetOrdersDto } from './dto/get-orders.dto';

@Injectable()
export class BusinessService {
  private supabaseUrl = AppConfig.SUPABASE_URL;
  private supabaseAnonKey = AppConfig.SUPABASE_KEY;

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
      .rpc('get_orders_by_place', { p_vendor_id: placeId });

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

  async getPlaceServicesByType(placeId: string) {
    try {
      console.log('📍 Fetching services for placeId:', placeId)
      
      // Step 1: Get all place_services for this place (free services)
      const { data: placeServices, error: psError } = await supabase
        .schema('travel')
        .from('place_services')
        .select('place_id, service_id')
        .eq('place_id', placeId)

      console.log('📊 Place services query - error:', psError)
      console.log('📊 Place services query - data:', placeServices)

      if (psError) {
        console.error('❌ Error fetching place_services:', psError.message)
        throw new InternalServerErrorException(`Lỗi database: ${psError.message}`)
      }

      // Step 2: Get food items for paid services
      const { data: foodItems, error: foodError } = await supabase
        .schema('order_sys')
        .from('food_items')
        .select('id, name, price, description')
        .eq('place_id', placeId)

      console.log('🍽️  Food items query - error:', foodError)
      console.log('🍽️  Food items query - data:', foodItems)

      // Try to get free and paid services
      const freeServices: any[] = []
      const paidServices: any[] = []

      // Process free services from place_services
      if (placeServices && Array.isArray(placeServices) && placeServices.length > 0) {
        const serviceIds = placeServices.map((ps: any) => ps.service_id)
        console.log('🔍 Fetching services with IDs:', serviceIds)

        // Fetch the services with their prices
        const { data: services, error: sError } = await supabase
          .schema('travel')
          .from('services')
          .select('id, name, price')
          .in('id', serviceIds)

        console.log('📊 Services query - error:', sError)
        console.log('📊 Services query - data:', services)

        if (!sError && services && Array.isArray(services)) {
          services.forEach((service: any) => {
            const serviceData = {
              id: service.id,
              name: service.name,
              description: service.description,
              price: service.price
            }

            // Group by whether price is null (free) or has value (paid)
            if (service.price === null || service.price === undefined) {
              freeServices.push(serviceData)
            } else {
              paidServices.push({
                ...serviceData,
                price: typeof service.price === 'string' ? parseFloat(service.price) : service.price
              })
            }
          })
        }
      }

      // Process food items separately (for restaurant menu section)
      const menuItems: any[] = []
      if (foodItems && Array.isArray(foodItems)) {
        console.log('🍽️  Processing', foodItems.length, 'food items as menu')
        foodItems.forEach((item: any) => {
          menuItems.push({
            id: item.id,
            name: item.name,
            description: item.description,
            price: typeof item.price === 'string' ? parseFloat(item.price) : item.price
          })
        })
      }

      const result = {
        freeServices,
        paidServices,
        menuItems,
        total: freeServices.length + paidServices.length + menuItems.length
      }

      console.log('✅ Services fetched successfully:', result)
      return result
    } catch (error) {
      console.error('❌ Error in getPlaceServicesByType:', error)
      throw new InternalServerErrorException('Không thể lấy dữ liệu dịch vụ')
    }
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
      if (!m.name) throw new BadRequestException('Thiếu tên món');

      if (!m.price || m.price <= 0)
        throw new BadRequestException(`Giá sai: ${m.name}`);
    }
  }

  async createFullPlace(dto: any, file?: any) {
    if (!dto || !dto.name) {
      throw new BadRequestException('Thiếu dữ liệu đầu vào: Tên địa điểm');
    }

    if (!dto.address) {
      throw new BadRequestException('Thiếu dữ liệu đầu vào: Địa chỉ');
    }

    if (!dto.city) {
      throw new BadRequestException('Thiếu dữ liệu đầu vào: Tỉnh/Thành phố');
    }

    if (!dto.categories || dto.categories.length === 0) {
      throw new BadRequestException('Thiếu dữ liệu đầu vào: Danh mục');
    }

    if (!dto.vendorId) {
      throw new BadRequestException('Thiếu dữ liệu đầu vào: Vendor ID');
    }

    let menu: any[] = [];

    // From request body (form items)
    if (dto.menu && Array.isArray(dto.menu) && dto.menu.length > 0) {
      menu = [...dto.menu]
    }

    // From Excel file - MERGE with existing items
    if (file) {
      try {
        const fileMenuItems = this.parseExcel(file);
        menu = [...menu, ...fileMenuItems];
      } catch (error) {
        console.error('Excel parsing error:', error);
        // Don't fail if Excel parsing errors - continue with form items
      }
    }

    // Validate all menu items
    if (menu.length > 0) {
      this.validateMenu(menu);
    }

    const { data, error } = await supabase
      .schema('travel')
      .rpc('create_full_place', {
        p_name: dto.name,
        p_address: dto.address,
        p_city: dto.city,
        p_lat: Number(dto.latitude),
        p_lng: Number(dto.longitude),
        p_vendor_id: dto.vendorId,
        p_categories: Array.isArray(dto.categories) ? dto.categories : [],
        p_services: Array.isArray(dto.services) ? dto.services : [],
        p_menu: menu.length > 0 ? menu : [],
      });

    if (error) {
      console.error('Supabase RPC Error:', error);
      throw new BadRequestException(error.message || 'Lỗi khi tạo địa điểm');
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
    const supabaseUrl = AppConfig.SUPABASE_URL;
    const supabaseKey = AppConfig.SUPABASE_KEY;

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

      if (!supabaseKey) {
        throw new InternalServerErrorException(
          'Server thiếu cấu hình SUPABASE_KEY',
        );
      }
      const adminClient = createClient(supabaseUrl, supabaseKey, {
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

  async getFoodPerformance(vendorId: string) {
    const { data, error } = await supabase
      .schema('order_sys')
      .rpc('get_food_performance', { p_vendor_id: vendorId });

    if (error) throw new InternalServerErrorException(error.message);
    return data ?? [];
  }

  async updateOrderStatus(orderId: string, status: string) {
    const { data, error } = await supabase
      .schema('order_sys')
      .from('orders')
      .update({ status })
      .eq('id', orderId)
      .select('id, status')
      .single();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException(`Không tìm thấy đơn hàng: ${orderId}`);

    return { message: 'Cập nhật trạng thái thành công', order: data };
  }

  async getFilteredOrders(dto: GetOrdersDto) {
    const { placeId, status, restaurant, page, limit } = dto;

    const { data, error } = await supabase
      .schema('order_sys')
      .rpc('get_orders', {
        p_place_id: placeId,
        p_status: status || 'all',
        p_restaurant: restaurant || 'all',
        p_page: page || 1,
        p_limit: limit || 10,
      });

    if (error) throw new InternalServerErrorException(error.message);

    return {
      data: data || [],
      total: data && data.length > 0 ? Number(data[0].total_count) : 0,
      page: page || 1,
      limit: limit || 10,
    };
  }
}

