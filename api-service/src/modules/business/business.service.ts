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
import { GetOrdersDto } from './dto/get-orders.dto';

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

      // Process paid services from food_items
      if (foodItems && Array.isArray(foodItems)) {
        console.log('🍽️  Processing', foodItems.length, 'food items as paid services')
        foodItems.forEach((item: any) => {
          paidServices.push({
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
        total: freeServices.length + paidServices.length
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
      if (!m.name) throw new BadRequestException('Thiếu tên món')

      if (!m.price || m.price <= 0)
        throw new BadRequestException(`Giá sai: ${m.name}`)
    }
  }

  async createFullPlace(dto: any, file?: any) {

    if (!dto || !dto.name) {
      throw new BadRequestException('Thiếu dữ liệu đầu vào: Tên địa điểm')
    }

    if (!dto.address) {
      throw new BadRequestException('Thiếu dữ liệu đầu vào: Địa chỉ')
    }

    if (!dto.city) {
      throw new BadRequestException('Thiếu dữ liệu đầu vào: Tỉnh/Thành phố')
    }

    if (!dto.categories || dto.categories.length === 0) {
      throw new BadRequestException('Thiếu dữ liệu đầu vào: Danh mục')
    }

    let menu: any[] = []

    // From request body (form items)
    if (dto.menu && Array.isArray(dto.menu) && dto.menu.length > 0) {
      menu = [...dto.menu]
    }

    // From Excel file - MERGE with existing items
    if (file) {
      try {
        const fileMenuItems = this.parseExcel(file)
        menu = [...menu, ...fileMenuItems]
      } catch (error) {
        console.error('Excel parsing error:', error)
        // Don't fail if Excel parsing errors - continue with form items
      }
    }

    // Validate all menu items
    if (menu.length > 0) {
      this.validateMenu(menu)
    }

    const { data, error } = await supabase
      .schema('travel')
      .rpc('create_full_place', {
        p_name: dto.name,
        p_address: dto.address,
        p_city: dto.city,
        p_lat: Number(dto.latitude),
        p_lng: Number(dto.longitude),
        p_categories: Array.isArray(dto.categories)
          ? dto.categories
          : [],
        p_services: Array.isArray(dto.services) ? dto.services : [],
        p_menu: menu.length > 0 ? menu : []
      })

    if (error) {
      console.error('Supabase RPC Error:', error)
      throw new BadRequestException(error.message || 'Lỗi khi tạo địa điểm')
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

  async getFilteredOrders(dto: GetOrdersDto) {
    const { placeId, status, restaurant, page, limit } = dto;

    // Gọi stored procedure từ Supabase
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

