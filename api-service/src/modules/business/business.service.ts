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
import { randomUUID } from 'crypto';

@Injectable()
export class BusinessService {
  private supabaseUrl = process.env.SUPABASE_URL || '';
  private supabaseAnonKey = process.env.SUPABASE_KEY || '';

  private normalizeText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  private isAccommodationType(
    values: Array<string | null | undefined>,
  ): boolean {
    return values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => this.normalizeText(value))
      .some(
        (value) =>
          value.includes('luu tru') ||
          value.includes('khach san') ||
          value.includes('hotel') ||
          value.includes('accommodation') ||
          value.includes('homestay') ||
          value.includes('resort'),
      );
  }

  private async resolvePlaceType(input: {
    typeId?: string;
    typeName?: string;
    categories?: string[];
  }): Promise<{ typeId?: string; categoryNames: string[] }> {
    const typeId = input.typeId?.trim();
    const typeName = input.typeName?.trim();
    const categories = Array.isArray(input.categories) ? input.categories : [];

    let query = supabase
      .schema('travel')
      .from('types')
      .select('id, name, categories(id, name)')
      .limit(1);

    if (typeId) {
      query = query.eq('id', typeId);
    } else if (typeName) {
      query = query.ilike('name', typeName);
    } else if (categories.length > 0) {
      query = query.ilike('name', categories[0]);
    } else {
      return { categoryNames: [] };
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!data) {
      return { categoryNames: categories };
    }

    const categoryData = (data as any).categories;
    const categoryNames = Array.isArray(categoryData)
      ? categoryData.map((category: any) => category?.name).filter(Boolean)
      : categoryData?.name
        ? [categoryData.name]
        : categories;

    return {
      typeId: (data as any).id,
      categoryNames,
    };
  }

  private extractCreatedPlaceId(data: any): string | null {
    if (!data) return null;
    if (typeof data === 'string') return data;
    if (Array.isArray(data)) return this.extractCreatedPlaceId(data[0]);
    return data.place_id || data.placeId || data.id || null;
  }

  private async resolveCityId(cityName: string): Promise<string> {
    const { data, error } = await supabase
      .schema('travel')
      .from('cities')
      .select('id, name')
      .ilike('name', cityName.trim())
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!data?.id) {
      throw new BadRequestException(`Tinh/thanh khong hop le: ${cityName}`);
    }

    return data.id;
  }

  private async addPlaceServices(
    placeId: string,
    services: Array<{ name: string; description?: string }>,
  ) {
    for (const service of services) {
      const serviceName = service.name?.trim();
      if (!serviceName) continue;

      let serviceId: string | null = null;

      const { data: existingService, error: findError } = await supabase
        .schema('travel')
        .from('services')
        .select('id')
        .ilike('name', serviceName)
        .maybeSingle();

      if (findError) {
        throw new InternalServerErrorException(findError.message);
      }

      serviceId = existingService?.id ?? null;

      if (!serviceId) {
        const { data: createdService, error: createServiceError } =
          await supabase
            .schema('travel')
            .from('services')
            .insert({ id: randomUUID(), name: serviceName, price: null })
            .select('id')
            .single();

        if (createServiceError) {
          throw new BadRequestException(createServiceError.message);
        }

        serviceId = createdService?.id ?? null;
      }

      if (!serviceId) continue;

      const { error: linkError } = await supabase
        .schema('travel')
        .from('place_services')
        .upsert(
          { place_id: placeId, service_id: serviceId },
          { onConflict: 'place_id,service_id' },
        );

      if (linkError) {
        throw new BadRequestException(linkError.message);
      }
    }
  }

  private async addMenuItems(
    placeId: string,
    menu: Array<{
      name: string;
      description?: string;
      price: number;
      image_url?: string;
      img?: string;
    }>,
  ) {
    if (menu.length === 0) return;

    const rows = menu
      .filter((item) => item.name?.trim())
      .map((item) => ({
        id: randomUUID(),
        place_id: placeId,
        name: item.name.trim(),
        description: item.description || null,
        price: Number(item.price),
        image_url: this.normalizeFoodImageUrls(item.image_url || item.img),
      }));

    if (rows.length === 0) return;

    const { error } = await supabase
      .schema('order_sys')
      .from('food_items')
      .insert(rows);

    if (error) {
      throw new BadRequestException(error.message);
    }
  }

  private async addHotelRooms(
    placeId: string,
    rooms: Array<{
      name?: string;
      room_name?: string;
      price?: number | string;
      quantity?: number | string;
      max_occupancy?: number | string;
    }>,
  ) {
    if (rooms.length === 0) return;

    const rows = rooms
      .map((room) => {
        const roomName = (room.name || room.room_name || '').trim();
        const price = Number(room.price);
        const quantity = Number(room.quantity ?? room.max_occupancy);

        return {
          id: randomUUID(),
          place_id: placeId,
          name: roomName,
          price,
          quantity,
        };
      })
      .filter(
        (room) =>
          room.name &&
          Number.isFinite(room.price) &&
          room.price > 0 &&
          Number.isFinite(room.quantity) &&
          room.quantity > 0,
      );

    if (rows.length === 0) return;

    const { error } = await supabase
      .schema('order_sys')
      .from('hotel_rooms')
      .insert(rows);

    if (error) {
      throw new BadRequestException(error.message);
    }
  }

  private normalizeFoodImageUrls(imageUrl?: string) {
    const trimmedUrl = imageUrl?.trim();
    return trimmedUrl ? [trimmedUrl] : [];
  }

  async getVendorPlaces(vendorId: string) {
    const { data, error } = await supabase
      .schema('travel')
      .rpc('get_places_by_vendor', { p_vendor_id: vendorId });

    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  async getPlaceDetail(placeId: string) {
    const { data: place, error } = await supabase
      .schema('travel')
      .from('places')
      .select(
        'id, name, description, address, email, phone, city_id, cities(name), latitude, longitude, open_time, close_time, image_url, is_approved, is_active, average_rating, review_count, type_id, estimated_preparation_time, types(id, name, categories(id, name))',
      )
      .eq('id', placeId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!place) throw new BadRequestException('Không tìm thấy địa điểm');

    const record = place as any;
    const cityData = Array.isArray(record.cities)
      ? record.cities[0]
      : record.cities;
    const typeData = Array.isArray(record.types)
      ? record.types[0]
      : record.types;
    const categoryData = Array.isArray(typeData?.categories)
      ? typeData.categories[0]
      : typeData?.categories;
    const placeImages = Array.isArray(record.image_url)
      ? record.image_url
      : record.image_url
        ? [record.image_url]
        : [];
    return {
      ...record,
      city: cityData?.name ?? '',
      type: typeData?.name ?? categoryData?.name ?? '',
      category: typeData?.name ?? categoryData?.name ?? '',
      images: placeImages,
    };
  }

  async updatePlaceDetail(placeId: string, vendorId: string, dto: any) {
    const normalizedPlaceId = placeId?.trim();
    const normalizedVendorId = vendorId?.trim();

    if (!normalizedPlaceId) {
      throw new BadRequestException('Thiếu dữ liệu: Place ID');
    }

    if (!normalizedVendorId) {
      throw new BadRequestException('Thiếu dữ liệu: Vendor ID');
    }

    const updatePayload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (typeof dto.name === 'string') updatePayload.name = dto.name.trim();
    if (typeof dto.address === 'string')
      updatePayload.address = dto.address.trim();
    if (typeof dto.email === 'string') updatePayload.email = dto.email.trim();
    if (typeof dto.p_email === 'string')
      updatePayload.email = dto.p_email.trim();
    if (typeof dto.phone === 'string') updatePayload.phone = dto.phone.trim();
    if (typeof dto.p_phone === 'string')
      updatePayload.phone = dto.p_phone.trim();
    if (typeof dto.description === 'string')
      updatePayload.description = dto.description;
    if (typeof dto.openTime === 'string')
      updatePayload.open_time = dto.openTime;
    if (typeof dto.closeTime === 'string')
      updatePayload.close_time = dto.closeTime;
    if (typeof dto.open_time === 'string')
      updatePayload.open_time = dto.open_time;
    if (typeof dto.close_time === 'string')
      updatePayload.close_time = dto.close_time;

    const latitude = dto.latitude ?? dto.lat;
    const longitude = dto.longitude ?? dto.lng;
    if (latitude !== undefined && latitude !== '')
      updatePayload.latitude = Number(latitude);
    if (longitude !== undefined && longitude !== '')
      updatePayload.longitude = Number(longitude);

    // is_active is controlled solely by the admin approval flow; vendors cannot set it directly
    updatePayload.is_active = false;

    const imageUrls = dto.imageUrls ?? dto.image_url ?? dto.images;
    if (Array.isArray(imageUrls)) {
      updatePayload.image_url = imageUrls.filter(
        (url): url is string =>
          typeof url === 'string' && url.trim().length > 0,
      );
    }

    const prepTime =
      dto.estimated_preparation_time ?? dto.p_estimated_preparation_time;
    if (prepTime !== undefined) {
      updatePayload.estimated_preparation_time =
        prepTime === null || prepTime === '' ? null : Number(prepTime) || null;
    }

    const cityName = typeof dto.city === 'string' ? dto.city.trim() : '';
    if (cityName) {
      updatePayload.city_id = await this.resolveCityId(cityName);
    }

    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .update(updatePayload)
      .eq('id', normalizedPlaceId)
      .eq('vendor_id', normalizedVendorId)
      .select('id')
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data)
      throw new NotFoundException('Không tìm thấy địa điểm thuộc đối tác này');

    return {
      message: 'Cập nhật địa điểm thành công',
      placeId: data.id,
    };
  }

  async deletePlaceDetail(placeId: string, vendorId: string) {
    const normalizedPlaceId = placeId?.trim();
    const normalizedVendorId = vendorId?.trim();

    if (!normalizedPlaceId) {
      throw new BadRequestException('Thiếu dữ liệu: Place ID');
    }

    if (!normalizedVendorId) {
      throw new BadRequestException('Thiếu dữ liệu: Vendor ID');
    }

    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .update({
        is_deleted: true,
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', normalizedPlaceId)
      .eq('vendor_id', normalizedVendorId)
      .eq('is_deleted', false)
      .select('id')
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data)
      throw new NotFoundException('Không tìm thấy địa điểm thuộc đối tác này');

    return {
      message: 'Xóa địa điểm thành công',
      placeId: data.id,
    };
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
      const { data: placeServices, error: psError } = await supabase
        .schema('travel')
        .from('place_services')
        .select('place_id, service_id')
        .eq('place_id', placeId);

      if (psError) {
        throw new InternalServerErrorException(
          `Loi database: ${psError.message}`,
        );
      }

      const { data: foodItems, error: foodError } = await supabase
        .schema('order_sys')
        .from('food_items')
        .select('id, name, price, description, image_url')
        .eq('place_id', placeId);

      if (foodError) {
        throw new InternalServerErrorException(foodError.message);
      }

      const { data: hotelRooms, error: roomError } = await supabase
        .schema('order_sys')
        .from('hotel_rooms')
        .select('id, name, price, quantity')
        .eq('place_id', placeId);

      if (roomError) {
        console.error('Hotel rooms query error:', roomError.message);
      }

      const freeServices: any[] = [];
      const paidServices: any[] = [];

      if (
        placeServices &&
        Array.isArray(placeServices) &&
        placeServices.length > 0
      ) {
        const serviceIds = placeServices.map((ps: any) => ps.service_id);
        const { data: services, error: sError } = await supabase
          .schema('travel')
          .from('services')
          .select('id, name, price')
          .in('id', serviceIds);

        if (sError) {
          throw new InternalServerErrorException(sError.message);
        }

        if (services && Array.isArray(services)) {
          services.forEach((service: any) => {
            const serviceData = {
              id: service.id,
              name: service.name,
              description: service.description,
              price: service.price,
            };

            if (service.price === null || service.price === undefined) {
              freeServices.push(serviceData);
            } else {
              paidServices.push({
                ...serviceData,
                price:
                  typeof service.price === 'string'
                    ? parseFloat(service.price)
                    : service.price,
              });
            }
          });
        }
      }

      const menuItems = (foodItems ?? []).map((item: any) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        price:
          typeof item.price === 'string' ? parseFloat(item.price) : item.price,
        image_url: Array.isArray(item.image_url)
          ? item.image_url[0]
          : (item.image_url ?? null),
      }));

      const rooms = (roomError ? [] : (hotelRooms ?? [])).map((room: any) => ({
        id: room.id,
        name: room.name,
        price:
          typeof room.price === 'string' ? parseFloat(room.price) : room.price,
        quantity:
          typeof room.quantity === 'string'
            ? parseInt(room.quantity, 10)
            : room.quantity,
      }));

      return {
        freeServices,
        paidServices,
        menuItems,
        rooms,
        total:
          freeServices.length +
          paidServices.length +
          menuItems.length +
          rooms.length,
      };
    } catch (error) {
      console.error('Error in getPlaceServicesByType:', error);
      throw new InternalServerErrorException('Khong the lay du lieu dich vu');
    }
  }
  async getDashboard(vendorId: string) {
    const normalizedVendorId = vendorId?.trim();
    if (!normalizedVendorId) {
      throw new BadRequestException('vendorId is required');
    }

    const { data: places, error: placesError } = await supabase
      .schema('travel')
      .from('places')
      .select('id, average_rating')
      .eq('vendor_id', normalizedVendorId)
      .eq('is_deleted', false);

    if (placesError) {
      throw new InternalServerErrorException(placesError.message);
    }

    const placeRows = (places ?? []) as Array<{
      id: string;
      average_rating: number | string | null;
    }>;
    const placeIds = placeRows.map((place) => place.id);

    if (placeIds.length === 0) {
      return {
        total_places: 0,
        total_orders: 0,
        pending_orders: 0,
        total_food_items: 0,
        average_rating: 0,
      };
    }

    const [foodItemsResult, itineraryDetailsResult] = await Promise.all([
      supabase
        .schema('order_sys')
        .from('food_items')
        .select('id', { count: 'estimated', head: true })
        .in('place_id', placeIds),
      supabase
        .schema('travel')
        .from('itinerary_details')
        .select('id')
        .in('place_id', placeIds),
    ]);

    if (foodItemsResult.error) {
      throw new InternalServerErrorException(foodItemsResult.error.message);
    }

    if (itineraryDetailsResult.error) {
      throw new InternalServerErrorException(
        itineraryDetailsResult.error.message,
      );
    }

    const itineraryDetailIds = (itineraryDetailsResult.data ?? [])
      .map((detail: { id: string | null }) => detail.id)
      .filter((id): id is string => Boolean(id));

    let totalOrders = 0;
    let pendingOrders = 0;
    if (itineraryDetailIds.length > 0) {
      const { data: orders, error: ordersError } = await supabase
        .schema('order_sys')
        .from('orders')
        .select('id, status')
        .in('itinerary_detail_id', itineraryDetailIds);

      if (ordersError) {
        throw new InternalServerErrorException(ordersError.message);
      }

      const orderRows = (orders ?? []) as Array<{ status: string | null }>;
      totalOrders = orderRows.filter(
        (order) => order.status !== 'completed',
      ).length;
      pendingOrders = orderRows.filter(
        (order) => order.status === 'pending',
      ).length;
    }

    const ratings = placeRows
      .map((place) => Number(place.average_rating ?? 0))
      .filter((rating) => Number.isFinite(rating) && rating > 0);
    const averageRating =
      ratings.length > 0
        ? Number(
            (
              ratings.reduce((total, rating) => total + rating, 0) /
              ratings.length
            ).toFixed(1),
          )
        : 0;

    return {
      total_places: placeRows.length,
      total_orders: totalOrders,
      pending_orders: pendingOrders,
      total_food_items: foodItemsResult.count ?? 0,
      average_rating: averageRating,
    };
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
    // 1. Kiểm tra dữ liệu đầu vào (Sửa lại cách truy cập biến theo payload bạn đã gửi)
    // Lưu ý: Vì payload bạn gửi có tiền tố p_, nên ta phải đọc đúng key đó
    const name = dto.p_name || dto.name;
    const address = dto.p_address || dto.address;
    const city = dto.p_city || dto.city;
    const categories = dto.p_categories || dto.categories;
    const vendorId = dto.p_vendor_id || dto.vendorId;
    const email = (dto.p_email || dto.email || '').trim();
    const phone = (dto.p_phone || dto.phone || '').trim();
    const resolvedType = await this.resolvePlaceType({
      typeId: dto.p_type_id || dto.typeId,
      typeName: dto.p_type_name || dto.typeName,
      categories: Array.isArray(categories) ? categories : [],
    });
    const categoryNames = resolvedType.categoryNames;
    const isAccommodation = this.isAccommodationType([
      dto.p_type_name || dto.typeName,
      ...(Array.isArray(categories) ? categories : []),
      ...categoryNames,
    ]);

    if (!name) throw new BadRequestException('Thiếu dữ liệu: Tên địa điểm');
    if (!address) throw new BadRequestException('Thiếu dữ liệu: Địa chỉ');
    if (!city) throw new BadRequestException('Thiếu dữ liệu: Tỉnh/Thành phố');
    if (!categories || categories.length === 0)
      throw new BadRequestException('Thiếu dữ liệu: Danh mục');
    if (!vendorId) throw new BadRequestException('Thiếu dữ liệu: Vendor ID');
    if (!email) throw new BadRequestException('Thieu du lieu: Email lien he');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Email lien he khong dung dinh dang');
    }
    if (!phone) throw new BadRequestException('Thieu du lieu: SDT lien he');
    if (!/^0\d{9}$/.test(phone)) {
      throw new BadRequestException(
        'SDT lien he phai gom dung 10 chu so va bat dau bang so 0',
      );
    }

    let menu: any[] = [];
    // Lấy menu từ form (p_menu)
    if (dto.p_menu && Array.isArray(dto.p_menu)) {
      menu = [...dto.p_menu];
    } else if (dto.menu && Array.isArray(dto.menu)) {
      menu = [...dto.menu];
    }

    const rooms = Array.isArray(dto.p_rooms || dto.rooms)
      ? dto.p_rooms || dto.rooms
      : [];

    // Merge với Excel nếu có
    if (file) {
      try {
        const fileMenuItems = this.parseExcel(file);
        menu = [...menu, ...fileMenuItems];
      } catch (error) {
        console.error('Excel parsing error:', error);
      }
    }

    if (!isAccommodation && menu.length > 0) {
      this.validateMenu(menu);
    }

    // 2. GỌI RPC VỚI ĐẦY ĐỦ 13 THAM SỐ
    if (!resolvedType.typeId) {
      throw new BadRequestException('Loai hinh kinh doanh khong hop le');
    }

    const cityId = await this.resolveCityId(city);
    const images = Array.isArray(dto.p_images || dto.images)
      ? dto.p_images || dto.images
      : [];
    const services = Array.isArray(dto.p_services || dto.services)
      ? dto.p_services || dto.services
      : [];

    const { data: createdPlace, error: createPlaceError } = await supabase
      .schema('travel')
      .from('places')
      .insert({
        id: randomUUID(),
        name,
        address,
        email,
        phone,
        city_id: cityId,
        latitude: Number(dto.p_lat || dto.latitude),
        longitude: Number(dto.p_lng || dto.longitude),
        vendor_id: vendorId,
        type_id: resolvedType.typeId,
        open_time: dto.p_open_time || '08:00',
        close_time: dto.p_close_time || '22:00',
        open_hour_compressed: dto.p_open_hour_compressed || null,
        description: dto.p_description || '',
        image_url: images,
        is_approved: null,
        is_active: false,
        average_rating: 0,
        review_count: 0,
        registered_date: new Date().toISOString().slice(0, 10),
        source: 'business',
        estimated_preparation_time:
          (dto.p_estimated_preparation_time ??
            dto.estimated_preparation_time) != null
            ? Number(
                dto.p_estimated_preparation_time ??
                  dto.estimated_preparation_time,
              ) || null
            : null,
      })
      .select('id')
      .single();

    if (createPlaceError) {
      console.error('Supabase create place error:', createPlaceError);
      throw new BadRequestException(
        createPlaceError.message || 'Loi khi tao dia diem',
      );
    }

    const createdPlaceId = createdPlace?.id;
    if (!createdPlaceId) {
      throw new BadRequestException('Khong lay duoc ID dia diem sau khi tao');
    }

    await this.addPlaceServices(createdPlaceId, services);
    if (isAccommodation) {
      await this.addHotelRooms(createdPlaceId, rooms.length > 0 ? rooms : menu);
    } else {
      await this.addMenuItems(createdPlaceId, menu);
    }

    return {
      message: 'Tao thanh cong',
      placeId: createdPlaceId,
    };

    const { data, error } = await supabase
      .schema('travel')
      .rpc('create_full_place_v2', {
        p_name: name,
        p_address: address,
        p_city: city,
        p_lat: Number(dto.p_lat || dto.latitude),
        p_lng: Number(dto.p_lng || dto.longitude),
        p_vendor_id: vendorId,
        p_categories: categoryNames,
        p_services: Array.isArray(dto.p_services || dto.services)
          ? dto.p_services || dto.services
          : [],
        p_menu: menu,
        // BỔ SUNG CÁC THAM SỐ CÒN THIẾU Ở ĐÂY:
        p_images: Array.isArray(dto.p_images || dto.images)
          ? dto.p_images || dto.images
          : [],
        p_open_time: dto.p_open_time || '08:00',
        p_close_time: dto.p_close_time || '22:00',
        p_open_hour_compressed: dto.p_open_hour_compressed || null,
        p_description: dto.p_description || '',
      });

    if (error) {
      console.error('Supabase RPC Error:', error);
      throw new BadRequestException(error?.message || 'Loi khi tao dia diem');
    }

    const placeId = this.extractCreatedPlaceId(data);
    if (placeId && resolvedType.typeId) {
      const { error: updateTypeError } = await supabase
        .schema('travel')
        .from('places')
        .update({ type_id: resolvedType.typeId })
        .eq('id', placeId);

      if (updateTypeError) {
        console.error('Supabase update type_id error:', updateTypeError);
        throw new BadRequestException(
          updateTypeError?.message || 'Loi khi cap nhat loai hinh dia diem',
        );
      }
    }

    return {
      message: 'Tạo thành công',
      placeId: placeId ?? data,
    };
  }

  // ── Single service / menu-item CRUD ──────────────────────────────────────────

  async addSingleMenuItem(
    placeId: string,
    name: string,
    description: string | null,
    price: number,
  ) {
    const { data, error } = await supabase
      .schema('order_sys')
      .from('food_items')
      .insert({
        id: randomUUID(),
        place_id: placeId,
        name: name.trim(),
        description: description || null,
        price: Number(price),
        image_url: [],
      })
      .select('id, name, price')
      .single();

    if (error) throw new BadRequestException(error.message);
    return { message: 'Thêm dịch vụ thành công', item: data };
  }

  async updateSingleMenuItem(
    itemId: string,
    placeId: string,
    name: string,
    description: string | null,
    price: number,
  ) {
    const { data, error } = await supabase
      .schema('order_sys')
      .from('food_items')
      .update({
        name: name.trim(),
        description: description || null,
        price: Number(price),
      })
      .eq('id', itemId)
      .eq('place_id', placeId)
      .select('id')
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Không tìm thấy dịch vụ');
    return { message: 'Cập nhật dịch vụ thành công' };
  }

  async deleteSingleMenuItem(itemId: string, placeId: string) {
    const { error } = await supabase
      .schema('order_sys')
      .from('food_items')
      .delete()
      .eq('id', itemId)
      .eq('place_id', placeId);

    if (error) throw new BadRequestException(error.message);
    return { message: 'Xóa dịch vụ thành công' };
  }

  async addSingleHotelRoom(
    placeId: string,
    name: string,
    price: number,
    quantity: number,
  ) {
    const { data, error } = await supabase
      .schema('order_sys')
      .from('hotel_rooms')
      .insert({
        id: randomUUID(),
        place_id: placeId,
        name: name.trim(),
        price: Number(price),
        quantity: Number(quantity),
      })
      .select('id, name, price, quantity')
      .single();

    if (error) throw new BadRequestException(error.message);
    return { message: 'Them phong thanh cong', item: data };
  }

  async updateSingleHotelRoom(
    roomId: string,
    placeId: string,
    name: string,
    price: number,
    quantity: number,
  ) {
    const { data, error } = await supabase
      .schema('order_sys')
      .from('hotel_rooms')
      .update({
        name: name.trim(),
        price: Number(price),
        quantity: Number(quantity),
      })
      .eq('id', roomId)
      .eq('place_id', placeId)
      .select('id')
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Khong tim thay phong');
    return { message: 'Cap nhat phong thanh cong' };
  }

  async deleteSingleHotelRoom(roomId: string, placeId: string) {
    const { error } = await supabase
      .schema('order_sys')
      .from('hotel_rooms')
      .delete()
      .eq('id', roomId)
      .eq('place_id', placeId);

    if (error) throw new BadRequestException(error.message);
    return { message: 'Xoa phong thanh cong' };
  }

  async addSingleFreeService(placeId: string, name: string) {
    const serviceName = name.trim();

    const { data: existing, error: findError } = await supabase
      .schema('travel')
      .from('services')
      .select('id')
      .ilike('name', serviceName)
      .maybeSingle();

    if (findError) throw new InternalServerErrorException(findError.message);

    let serviceId: string | null = existing?.id ?? null;

    if (!serviceId) {
      const { data: created, error: createError } = await supabase
        .schema('travel')
        .from('services')
        .insert({ id: randomUUID(), name: serviceName, price: null })
        .select('id')
        .single();

      if (createError) throw new BadRequestException(createError.message);
      serviceId = created?.id ?? null;
    }

    if (!serviceId)
      throw new InternalServerErrorException('Không thể tạo tiện ích');

    const { error: linkError } = await supabase
      .schema('travel')
      .from('place_services')
      .upsert(
        { place_id: placeId, service_id: serviceId },
        { onConflict: 'place_id,service_id' },
      );

    if (linkError) throw new BadRequestException(linkError.message);
    return { message: 'Thêm tiện ích thành công', id: serviceId };
  }

  async updateSingleFreeService(
    placeId: string,
    oldServiceId: string,
    newName: string,
  ) {
    const { error: deleteError } = await supabase
      .schema('travel')
      .from('place_services')
      .delete()
      .eq('place_id', placeId)
      .eq('service_id', oldServiceId);

    if (deleteError) throw new BadRequestException(deleteError.message);
    return this.addSingleFreeService(placeId, newName);
  }

  async deleteSingleFreeService(placeId: string, serviceId: string) {
    const { error } = await supabase
      .schema('travel')
      .from('place_services')
      .delete()
      .eq('place_id', placeId)
      .eq('service_id', serviceId);

    if (error) throw new BadRequestException(error.message);
    return { message: 'Xóa tiện ích thành công' };
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
    const normalizedVendorId = vendorId?.trim();
    if (!normalizedVendorId) {
      throw new BadRequestException('vendorId is required');
    }

    const { data: places, error: placesError } = await supabase
      .schema('travel')
      .from('places')
      .select('id, name')
      .eq('vendor_id', normalizedVendorId)
      .eq('is_deleted', false);

    if (placesError) {
      throw new InternalServerErrorException(placesError.message);
    }

    const placeRows = (places ?? []) as Array<{ id: string; name: string }>;
    const placeIds = placeRows.map((place) => place.id);
    if (placeIds.length === 0) {
      return [];
    }

    const placeNameById = new Map(
      placeRows.map((place) => [place.id, place.name]),
    );

    const { data: foods, error: foodsError } = await supabase
      .schema('order_sys')
      .from('food_items')
      .select('id, name, price, place_id')
      .in('place_id', placeIds);

    if (foodsError) {
      throw new InternalServerErrorException(foodsError.message);
    }

    const foodRows = (foods ?? []) as Array<{
      id: string;
      name: string;
      price: number | string | null;
      place_id: string | null;
    }>;
    const foodIds = foodRows.map((food) => food.id);
    if (foodIds.length === 0) {
      return [];
    }

    const { data: orderItems, error: orderItemsError } = await supabase
      .schema('order_sys')
      .from('order_items')
      .select('food_item_id')
      .in('food_item_id', foodIds);

    if (orderItemsError) {
      throw new InternalServerErrorException(orderItemsError.message);
    }

    const orderCountByFoodId = new Map<string, number>();
    for (const item of (orderItems ?? []) as Array<{
      food_item_id: string | null;
    }>) {
      if (!item.food_item_id) continue;
      orderCountByFoodId.set(
        item.food_item_id,
        (orderCountByFoodId.get(item.food_item_id) ?? 0) + 1,
      );
    }

    return foodRows
      .map((food) => ({
        food_id: food.id,
        food_name: food.name,
        place_name: food.place_id
          ? (placeNameById.get(food.place_id) ?? '')
          : '',
        price: food.price,
        order_count: orderCountByFoodId.get(food.id) ?? 0,
      }))
      .sort((a, b) => b.order_count - a.order_count);
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
    if (!data)
      throw new NotFoundException(`Không tìm thấy đơn hàng: ${orderId}`);

    return { message: 'Cập nhật trạng thái thành công', order: data };
  }

  async getFilteredOrdersForVendor(dto: GetOrdersDto, vendorId: string) {
    const normalizedVendorId = vendorId?.trim();
    if (!normalizedVendorId) {
      throw new BadRequestException('vendorId is required');
    }

    const safePage =
      Number.isFinite(Number(dto.page)) && Number(dto.page) > 0
        ? Math.floor(Number(dto.page))
        : 1;
    const safeLimit =
      Number.isFinite(Number(dto.limit)) && Number(dto.limit) > 0
        ? Math.min(Math.floor(Number(dto.limit)), 100)
        : 10;
    const offset = (safePage - 1) * safeLimit;
    const status = dto.status && dto.status !== 'all' ? dto.status : null;
    const restaurant =
      dto.restaurant && dto.restaurant !== 'all' ? dto.restaurant : null;
    const placeId =
      dto.placeId && dto.placeId !== 'all' ? dto.placeId.trim() : null;

    let placeQuery = supabase
      .schema('travel')
      .from('places')
      .select('id, name')
      .eq('vendor_id', normalizedVendorId)
      .eq('is_deleted', false);

    if (placeId) placeQuery = placeQuery.eq('id', placeId);
    if (restaurant) placeQuery = placeQuery.eq('name', restaurant);

    const { data: places, error: placesError } = await placeQuery;
    if (placesError) {
      throw new InternalServerErrorException(placesError.message);
    }

    const placeRows = (places ?? []) as Array<{ id: string; name: string }>;
    if (placeRows.length === 0) {
      return { data: [], total: 0, page: safePage, limit: safeLimit };
    }

    const placeNameById = new Map(
      placeRows.map((place) => [place.id, place.name]),
    );
    const { data: details, error: detailsError } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('id, place_id')
      .in(
        'place_id',
        placeRows.map((place) => place.id),
      );

    if (detailsError) {
      throw new InternalServerErrorException(detailsError.message);
    }

    const detailRows = (details ?? []) as Array<{
      id: string;
      place_id: string | null;
    }>;
    if (detailRows.length === 0) {
      return { data: [], total: 0, page: safePage, limit: safeLimit };
    }

    const placeIdByDetailId = new Map(
      detailRows.map((detail) => [detail.id, detail.place_id]),
    );
    let ordersQuery = supabase
      .schema('order_sys')
      .from('orders')
      .select(
        'id, ordered_at, total_amount, status, tourist_id, itinerary_detail_id',
        { count: 'exact' },
      )
      .in(
        'itinerary_detail_id',
        detailRows.map((detail) => detail.id),
      );

    if (status) ordersQuery = ordersQuery.eq('status', status);

    const {
      data: orders,
      error: ordersError,
      count,
    } = await ordersQuery
      .order('ordered_at', { ascending: false })
      .range(offset, offset + safeLimit - 1);

    if (ordersError) {
      throw new InternalServerErrorException(ordersError.message);
    }

    const orderRows = (orders ?? []) as Array<{
      id: string;
      ordered_at: string | null;
      total_amount: number | string | null;
      status: string | null;
      tourist_id: string | null;
      itinerary_detail_id: string | null;
    }>;
    if (orderRows.length === 0) {
      return { data: [], total: count ?? 0, page: safePage, limit: safeLimit };
    }

    const touristIds = Array.from(
      new Set(
        orderRows
          .map((order) => order.tourist_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const orderIds = orderRows.map((order) => order.id);
    const [usersResult, orderItemsResult] = await Promise.all([
      touristIds.length > 0
        ? supabase
            .from('users')
            .select('id, full_name, email')
            .in('id', touristIds)
        : Promise.resolve({ data: [], error: null }),
      supabase
        .schema('order_sys')
        .from('order_items')
        .select('order_id, food_item_id')
        .in('order_id', orderIds),
    ]);

    if (usersResult.error) {
      throw new InternalServerErrorException(usersResult.error.message);
    }
    if (orderItemsResult.error) {
      throw new InternalServerErrorException(orderItemsResult.error.message);
    }

    const userNameById = new Map(
      (
        (usersResult.data ?? []) as Array<{
          id: string;
          full_name: string | null;
          email: string | null;
        }>
      ).map((user) => [user.id, user.full_name || user.email || '']),
    );
    const orderItemRows = (orderItemsResult.data ?? []) as Array<{
      order_id: string | null;
      food_item_id: string | null;
    }>;
    const foodIds = Array.from(
      new Set(
        orderItemRows
          .map((item) => item.food_item_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    const foodNameById = new Map<string, string>();
    if (foodIds.length > 0) {
      const { data: foods, error: foodsError } = await supabase
        .schema('order_sys')
        .from('food_items')
        .select('id, name')
        .in('id', foodIds);
      if (foodsError) {
        throw new InternalServerErrorException(foodsError.message);
      }
      for (const food of (foods ?? []) as Array<{ id: string; name: string }>) {
        foodNameById.set(food.id, food.name);
      }
    }

    const foodNamesByOrderId = new Map<string, string[]>();
    for (const item of orderItemRows) {
      if (!item.order_id || !item.food_item_id) continue;
      const foodName = foodNameById.get(item.food_item_id);
      if (!foodName) continue;
      const names = foodNamesByOrderId.get(item.order_id) ?? [];
      names.push(foodName);
      foodNamesByOrderId.set(item.order_id, names);
    }

    const total = count ?? orderRows.length;
    return {
      data: orderRows.map((order) => {
        const orderPlaceId = order.itinerary_detail_id
          ? placeIdByDetailId.get(order.itinerary_detail_id)
          : null;
        return {
          order_id: order.id,
          place_id: orderPlaceId,
          place_name: orderPlaceId
            ? (placeNameById.get(orderPlaceId) ?? '')
            : '',
          customer_name: order.tourist_id
            ? (userNameById.get(order.tourist_id) ?? '')
            : '',
          foods: (foodNamesByOrderId.get(order.id) ?? []).join(', '),
          status: order.status,
          ordered_time: order.ordered_at,
          total_amount: order.total_amount,
          total_count: total,
        };
      }),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  async getFilteredOrders(dto: GetOrdersDto) {
    const { placeId, status, restaurant, page, limit } = dto;

    // Gọi stored procedure từ Supabase
    const { data, error } = await supabase.rpc('get_orders', {
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
