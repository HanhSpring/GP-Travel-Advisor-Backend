import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { supabase } from '../../../config/supabase';
import { CreateOrderDto } from './dto/create-order.dto';

interface PlaceRow {
  id: string;
  name: string;
  address: string | null;
  city_id: string | null;
  cities:
    | {
        name: string | null;
      }
    | {
        name: string | null;
      }[]
    | null;
  average_rating: number | null;
  review_count: number | null;
}

interface FoodItemRow {
  id: string;
  name: string | null;
  description: string | null;
  price: number | null;
  place_id: string;
}

interface CreateOrderFoodItemRow {
  id: string;
  place_id: string;
  name: string | null;
  price: number | null;
  is_active?: boolean | null;
}

interface ItineraryOwnerRow {
  id: string;
  creator_id: string;
}

interface ItineraryDetailRow {
  id: string;
  place_id: string;
  visit_date: string | null;
  arrival_time: string | null;
}

interface PlaceCategoryRow {
  place_id: string;
  category_id: string;
}

interface CategoryRow {
  id: string;
  name: string;
}

interface OrderRow {
  id: string;
  total_amount: number | null;
}

type FoodCategory = 'all' | 'main' | 'drink';

@Injectable()
export class OrdersService {
  constructor() {}

  private readonly validOrderStatuses = [
    'pending',
    'processing',
    'completed',
    'cancelled',
  ] as const;

  private normalizeText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  private isOrderEligibleCategory(category: string): boolean {
    const normalized = this.normalizeText(category);
    return (
      normalized.includes('cafe') ||
      normalized.includes('ca phe') ||
      normalized.includes('restaurant') ||
      normalized.includes('nha hang')
    );
  }

  private getOrderActionSecret(): string {
    return (
      process.env.ORDER_ACTION_SECRET ||
      process.env.SUPABASE_KEY ||
      'dev-order-action-secret'
    );
  }

  private base64UrlEncode(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
  }

  private base64UrlDecode(value: string): string {
    return Buffer.from(value, 'base64url').toString('utf8');
  }

  private signOrderActionPayload(payload: string): string {
    return createHmac('sha256', this.getOrderActionSecret())
      .update(payload)
      .digest('base64url');
  }

  private createOrderActionToken(orderId: string): string {
    const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 3;
    const payload = this.base64UrlEncode(JSON.stringify({ orderId, expiresAt }));
    return `${payload}.${this.signOrderActionPayload(payload)}`;
  }

  private verifyOrderActionToken(token: string): { orderId: string } {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) {
      throw new BadRequestException('Token xử lý đơn không hợp lệ');
    }

    const expectedSignature = this.signOrderActionPayload(payload);
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      throw new BadRequestException('Token xử lý đơn không hợp lệ');
    }

    const data = JSON.parse(this.base64UrlDecode(payload)) as {
      orderId?: string;
      expiresAt?: number;
    };

    if (!data.orderId || !data.expiresAt || Date.now() > data.expiresAt) {
      throw new BadRequestException('Token xử lý đơn đã hết hạn');
    }

    return { orderId: data.orderId };
  }

  private getApiBaseUrl(): string {
    const port = process.env.API_SERVICE_PORT || '3000';
    return (
      process.env.API_PUBLIC_URL ||
      process.env.BACKEND_URL ||
      `http://localhost:${port}`
    ).replace(/\/$/, '');
  }

  private getActionUrl(token: string, action: 'confirm' | 'complete' | 'cancel'): string {
    return `${this.getApiBaseUrl()}/order-actions/${token}?action=${action}`;
  }

  private getOrderActionEmailHtml(params: {
    orderId: string;
    placeName: string;
    totalAmount: number;
    items: Array<{ name: string; quantity: number; total_price: number }>;
    confirmUrl: string;
    completeUrl: string;
    cancelUrl: string;
  }): string {
    const formatCurrency = (value: number) =>
      `${Math.max(0, value).toLocaleString('vi-VN')}đ`;
    const itemsHtml = params.items
      .map(
        (item) =>
          `<li>${item.name} x${item.quantity} - ${formatCurrency(item.total_price)}</li>`,
      )
      .join('');

    return `
      <div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.5">
        <h2>Đơn đặt món mới</h2>
        <p><strong>Mã đơn:</strong> ${params.orderId}</p>
        <p><strong>Nhà hàng:</strong> ${params.placeName}</p>
        <p><strong>Tổng tiền:</strong> ${formatCurrency(params.totalAmount)}</p>
        <p><strong>Món đã đặt:</strong></p>
        <ul>${itemsHtml}</ul>
        <p>Vui lòng chọn thao tác xử lý đơn:</p>
        <p>
          <a href="${params.confirmUrl}" style="display:inline-block;background:#2563eb;color:white;padding:10px 14px;border-radius:8px;text-decoration:none;font-weight:700">Xác nhận đơn</a>
          <a href="${params.completeUrl}" style="display:inline-block;background:#10b981;color:white;padding:10px 14px;border-radius:8px;text-decoration:none;font-weight:700;margin-left:8px">Hoàn thành</a>
          <a href="${params.cancelUrl}" style="display:inline-block;background:#ef4444;color:white;padding:10px 14px;border-radius:8px;text-decoration:none;font-weight:700;margin-left:8px">Hủy đơn</a>
        </p>
        <p style="color:#64748b;font-size:13px">Link có hiệu lực trong 3 ngày. Trang quản lý đối tác chỉ hiển thị trạng thái sau khi nhà hàng thao tác qua email.</p>
      </div>
    `;
  }

  private async sendOrderActionEmail(params: {
    orderId: string;
    placeName: string;
    totalAmount: number;
    items: Array<{ name: string; quantity: number; total_price: number }>;
  }): Promise<boolean> {
    const apiKey = process.env.RESEND_API_KEY;
    const to = process.env.ORDER_NOTIFICATION_EMAIL || 'trip.datn2026@gmail.com';
    const from = process.env.RESEND_FROM || 'Travel Advisor <onboarding@resend.dev>';

    if (!apiKey) {
      console.warn('RESEND_API_KEY is missing. Skipped order email notification.');
      return false;
    }

    const token = this.createOrderActionToken(params.orderId);

    await axios.post(
      'https://api.resend.com/emails',
      {
        from,
        to,
        subject: `Đơn đặt món mới tại ${params.placeName}`,
        html: this.getOrderActionEmailHtml({
          ...params,
          confirmUrl: this.getActionUrl(token, 'confirm'),
          completeUrl: this.getActionUrl(token, 'complete'),
          cancelUrl: this.getActionUrl(token, 'cancel'),
        }),
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );

    return true;
  }

  private getTargetStatus(action: string): 'processing' | 'completed' | 'cancelled' {
    if (action === 'confirm') return 'processing';
    if (action === 'complete') return 'completed';
    if (action === 'cancel') return 'cancelled';
    throw new BadRequestException('Thao tác xử lý đơn không hợp lệ');
  }

  private canTransitionOrderStatus(currentStatus: string, targetStatus: string): boolean {
    const transitions: Record<string, string[]> = {
      pending: ['processing', 'cancelled'],
      processing: ['completed', 'cancelled'],
      completed: [],
      cancelled: [],
    };

    return transitions[currentStatus]?.includes(targetStatus) ?? false;
  }

  async handleOrderEmailAction(token: string, action: string) {
    const { orderId } = this.verifyOrderActionToken(token);
    const targetStatus = this.getTargetStatus(action);

    const { data: order, error: orderError } = await supabase
      .schema('order_sys')
      .from('orders')
      .select('id, status')
      .eq('id', orderId)
      .maybeSingle<{ id: string; status: string }>();

    if (orderError) {
      throw new InternalServerErrorException(orderError.message);
    }
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn hàng');
    }

    if (!this.canTransitionOrderStatus(order.status, targetStatus)) {
      return {
        success: false,
        order_id: order.id,
        current_status: order.status,
        requested_status: targetStatus,
        message: 'Trạng thái đơn hiện tại không cho phép thao tác này',
      };
    }

    const { data, error } = await supabase
      .schema('order_sys')
      .from('orders')
      .update({ status: targetStatus })
      .eq('id', order.id)
      .select('id, status')
      .single<{ id: string; status: string }>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return {
      success: true,
      order_id: data.id,
      status: data.status,
      message: 'Cập nhật trạng thái đơn hàng thành công',
    };
  }

  private extractCityName(
    cityData:
      | {
          name: string | null;
        }
      | {
          name: string | null;
        }[]
      | null,
  ): string | null {
    if (!cityData) {
      return null;
    }

    if (Array.isArray(cityData)) {
      return cityData[0]?.name ?? null;
    }

    return cityData.name ?? null;
  }

  private mapFoodCategory(name: string | null): 'main' | 'drink' {
    const value = (name ?? '').toLowerCase();
    const drinkKeywords = [
      'ca phe',
      'cafe',
      'coffee',
      'tra',
      'tea',
      'nuoc',
      'juice',
      'soda',
      'beer',
      'bia',
      'latte',
      'smoothie',
      'da xay',
    ];

    if (drinkKeywords.some((keyword) => value.includes(keyword))) {
      return 'drink';
    }

    return 'main';
  }

  private buildFoodImage(seed: string): string {
    return `https://picsum.photos/seed/${seed}-food/320/240`;
  }

  async getOrderPopup(placeId: string) {
    const { data: place, error } = await supabase
      .schema('travel')
      .from('places')
      .select(
        'id, name, address, city_id, cities(name), average_rating, review_count',
      )
      .eq('id', placeId)
      .maybeSingle<PlaceRow>();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    if (!place) {
      throw new NotFoundException('Place not found');
    }

    return {
      place: {
        id: place.id,
        name: place.name,
        address: place.address,
        city: this.extractCityName(place.cities),
      },
      suggestion: {
        title: `Bạn sắp đến ${place.name}`,
        message:
          'Bạn có muốn đặt trước món ăn để không phải chờ đợi khi đến nơi?',
      },
      actions: {
        primary: {
          label: 'Dat mon ngay',
          target: `/places/${place.id}/order/items`,
        },
        secondary: {
          label: 'Bo qua',
          target: 'back',
        },
      },
      meta: {
        estimated_wait_minutes: 20,
        rating: Number(place.average_rating) || 0,
        review_count: place.review_count || 0,
      },
    };
  }

  async getItineraryOrderPlaces(itineraryId: string, touristId: string) {
    if (!itineraryId || !touristId) {
      throw new BadRequestException('itinerary_id and tourist_id are required');
    }

    const { data: itinerary, error: itineraryError } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('id, creator_id')
      .eq('id', itineraryId)
      .eq('creator_id', touristId)
      .maybeSingle<ItineraryOwnerRow>();

    if (itineraryError) {
      throw new InternalServerErrorException(itineraryError.message);
    }

    if (!itinerary) {
      throw new NotFoundException('Itinerary not found for this tourist');
    }

    const { data: details, error: detailsError } = await supabase
      .schema('travel')
      .from('itinerary_details')
      .select('id, place_id, visit_date, arrival_time')
      .eq('itinerary_id', itineraryId)
      .order('visit_date', { ascending: true })
      .order('arrival_time', { ascending: true })
      .returns<ItineraryDetailRow[]>();

    if (detailsError) {
      throw new InternalServerErrorException(detailsError.message);
    }

    const orderedDetails = (details ?? []).filter((item) => !!item.place_id);
    if (orderedDetails.length === 0) {
      return { itinerary_id: itineraryId, places: [] };
    }

    const orderedUniquePlaceIds: string[] = [];
    const firstOccurrence = new Map<string, ItineraryDetailRow>();
    for (const item of orderedDetails) {
      if (firstOccurrence.has(item.place_id)) {
        continue;
      }
      firstOccurrence.set(item.place_id, item);
      orderedUniquePlaceIds.push(item.place_id);
    }

    const { data: placeRows, error: placeError } = await supabase
      .schema('travel')
      .from('places')
      .select('id, name')
      .in('id', orderedUniquePlaceIds)
      .returns<Array<{ id: string; name: string }>>();

    if (placeError) {
      throw new InternalServerErrorException(placeError.message);
    }

    const placeMap = new Map(
      (placeRows ?? []).map((item) => [item.id, item.name]),
    );

    const { data: placeCategoryRows, error: placeCategoryError } =
      await supabase
        .schema('travel')
        .from('place_categories')
        .select('place_id, category_id')
        .in('place_id', orderedUniquePlaceIds)
        .returns<PlaceCategoryRow[]>();

    if (placeCategoryError) {
      throw new InternalServerErrorException(placeCategoryError.message);
    }

    const categoryIds = Array.from(
      new Set((placeCategoryRows ?? []).map((item) => item.category_id)),
    );

    const categoryMap = new Map<string, string>();
    if (categoryIds.length > 0) {
      const { data: categories, error: categoryError } = await supabase
        .schema('travel')
        .from('categories')
        .select('id, name')
        .in('id', categoryIds)
        .returns<CategoryRow[]>();

      if (categoryError) {
        throw new InternalServerErrorException(categoryError.message);
      }

      for (const item of categories ?? []) {
        categoryMap.set(item.id, item.name);
      }
    }

    const categoriesByPlace = new Map<string, string[]>();
    for (const row of placeCategoryRows ?? []) {
      const categoryName = categoryMap.get(row.category_id);
      if (!categoryName) {
        continue;
      }
      const list = categoriesByPlace.get(row.place_id) ?? [];
      list.push(categoryName);
      categoriesByPlace.set(row.place_id, list);
    }

    const filtered = orderedUniquePlaceIds
      .map((placeId) => {
        const categories = categoriesByPlace.get(placeId) ?? [];
        const eligible = categories.some((name) =>
          this.isOrderEligibleCategory(name),
        );

        if (!eligible) {
          return null;
        }

        const occurrence = firstOccurrence.get(placeId);
        return {
          itinerary_detail_id: occurrence?.id ?? '',
          place_id: placeId,
          place_name: placeMap.get(placeId) ?? 'Địa điểm',
          visit_date: occurrence?.visit_date ?? null,
          arrival_time: occurrence?.arrival_time ?? null,
          categories,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item != null)
      .map((item, index) => ({
        order: index + 1,
        ...item,
      }));

    return {
      itinerary_id: itineraryId,
      places: filtered,
    };
  }

  async createOrder(placeId: string, payload: CreateOrderDto) {
    if (!placeId || !payload.tourist_id) {
      throw new BadRequestException('place_id and tourist_id are required');
    }

    if (!payload.items || payload.items.length === 0) {
      throw new BadRequestException('items must not be empty');
    }

    const { data: place, error: placeError } = await supabase
      .schema('travel')
      .from('places')
      .select('id, name')
      .eq('id', placeId)
      .maybeSingle<{ id: string; name: string }>();

    if (placeError) {
      throw new InternalServerErrorException(placeError.message);
    }

    if (!place) {
      throw new NotFoundException('Place not found');
    }

    const requestedFoodItemIds = Array.from(
      new Set(payload.items.map((item) => item.food_item_id)),
    );

    const { data: menuItems, error: menuError } = await supabase
      .schema('order_sys')
      .from('food_items')
      .select('id, place_id, name, price, is_active')
      .in('id', requestedFoodItemIds)
      .returns<CreateOrderFoodItemRow[]>();

    if (menuError) {
      throw new InternalServerErrorException(menuError.message);
    }

    const menuMap = new Map((menuItems ?? []).map((item) => [item.id, item]));

    const normalizedItems = payload.items.map((item) => {
      const menu = menuMap.get(item.food_item_id);
      if (!menu) {
        throw new BadRequestException(
          `food_item_id ${item.food_item_id} not found`,
        );
      }
      if (menu.place_id !== placeId) {
        throw new BadRequestException(
          `food_item_id ${item.food_item_id} does not belong to this place`,
        );
      }
      if (menu.is_active === false) {
        throw new BadRequestException(
          `food_item_id ${item.food_item_id} is inactive`,
        );
      }

      const unitPrice = Number(menu.price) || 0;
      const quantity = item.quantity;
      const totalPrice = unitPrice * quantity;

      return {
        food_item_id: item.food_item_id,
        name: menu.name || 'Món ăn',
        quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
      };
    });

    const totalAmount = normalizedItems.reduce(
      (sum, item) => sum + item.total_price,
      0,
    );

    const orderedAt = new Date().toISOString();

    const orderId = randomUUID();
    const orderInsertVariants = [
      {
        id: orderId,
        ordered_at: orderedAt,
        total_amount: totalAmount,
        status: 'pending',
        notes: payload.notes ?? null,
        tourist_id: payload.tourist_id,
        itinerary_detail_id: payload.itinerary_detail_id ?? null,
      },
      {
        id: orderId,
        ordered_at: orderedAt,
        total_amount: totalAmount,
        status: 'pending',
        tourist_id: payload.tourist_id,
      },
      {
        id: orderId,
        ordered_at: orderedAt,
        status: 'pending',
        tourist_id: payload.tourist_id,
      },
    ];

    let orderInsertError: { code?: string; message?: string } | null = null;
    for (const variant of orderInsertVariants) {
      const { error } = await supabase
        .schema('order_sys')
        .from('orders')
        .insert([variant]);

      if (!error) {
        orderInsertError = null;
        break;
      }

      orderInsertError = error as { code?: string; message?: string };

      const isUnknownColumn = error.code === '42703';
      const isInvalidStatusEnum =
        (error.message || '').includes('order_status_enum') &&
        (error.message || '').includes('invalid input value for enum');

      if (!isUnknownColumn && !isInvalidStatusEnum) {
        break;
      }
    }

    if (orderInsertError) {
      throw new InternalServerErrorException(orderInsertError.message);
    }

    const orderItemRowVariants = [
      normalizedItems.map((item) => ({
        id: randomUUID(),
        quantity: item.quantity,
        unit_price: item.unit_price,
        total_price: item.total_price,
        order_id: orderId,
        food_item_id: item.food_item_id,
      })),
      normalizedItems.map((item) => ({
        id: randomUUID(),
        quantity: item.quantity,
        order_id: orderId,
        food_item_id: item.food_item_id,
      })),
      normalizedItems.map((item) => ({
        order_id: orderId,
        food_item_id: item.food_item_id,
      })),
    ];

    let insertedOrderItems = false;
    let orderItemsError: { code?: string; message?: string } | null = null;
    for (const rows of orderItemRowVariants) {
      const { error } = await supabase
        .schema('order_sys')
        .from('order_items')
        .insert(rows);

      if (!error) {
        insertedOrderItems = true;
        orderItemsError = null;
        break;
      }

      orderItemsError = error as { code?: string; message?: string };
      if (error.code !== '42703') {
        break;
      }
    }

    if (!insertedOrderItems && orderItemsError) {
      const { error: fallbackError } = await supabase
        .schema('order_sys')
        .from('order_item')
        .insert(orderItemRowVariants[orderItemRowVariants.length - 1]);

      if (fallbackError) {
        throw new InternalServerErrorException(
          fallbackError.message ||
            orderItemsError.message ||
            'Failed to create order items',
        );
      }
    }

    let emailSent = false;
    try {
      emailSent = await this.sendOrderActionEmail({
        orderId,
        placeName: place.name,
        totalAmount,
        items: normalizedItems.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          total_price: item.total_price,
        })),
      });
    } catch (emailError) {
      console.error('Failed to send order action email:', emailError);
    }

    return {
      success: true,
      order_id: orderId,
      total_amount: totalAmount,
      items: normalizedItems,
      email_sent: emailSent,
      message: 'Đặt món thành công',
    };
  }

  async getFoodItems(
    placeId: string,
    search?: string,
    category: FoodCategory = 'all',
    page: number = 1,
    limit: number = 20,
  ) {
    if (!['all', 'main', 'drink'].includes(category)) {
      throw new BadRequestException(
        'category must be one of: all, main, drink',
      );
    }

    const { data: place, error: placeError } = await supabase
      .schema('travel')
      .from('places')
      .select('id, name')
      .eq('id', placeId)
      .maybeSingle<{ id: string; name: string }>();

    if (placeError) {
      throw new InternalServerErrorException(placeError.message);
    }

    if (!place) {
      throw new NotFoundException('Place not found');
    }

    let query = supabase
      .schema('order_sys')
      .from('food_items')
      .select('id, name, description, price, place_id', { count: 'exact' })
      .eq('place_id', placeId)
      .order('name', { ascending: true });

    if (search) {
      query = query.ilike('name', `%${search}%`);
    }

    const offset = (page - 1) * limit;
    const { data, error, count } = await query.range(
      offset,
      offset + limit - 1,
    );

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    let items = ((data ?? []) as FoodItemRow[]).map((item) => ({
      id: item.id,
      name: item.name ?? '',
      description: item.description ?? '',
      price: Number(item.price) || 0,
      category: this.mapFoodCategory(item.name),
      image_url: this.buildFoodImage(item.id),
    }));

    if (category !== 'all') {
      items = items.filter((item) => item.category === category);
    }

    const prices = items.map((item) => item.price);

    return {
      place: {
        id: place.id,
        name: place.name,
      },
      filters: {
        categories: [
          { value: 'all', label: 'Tat ca' },
          { value: 'main', label: 'Mon chinh' },
          { value: 'drink', label: 'Do uong' },
        ],
      },
      items,
      summary: {
        total_items: items.length,
        min_price: prices.length ? Math.min(...prices) : 0,
        max_price: prices.length ? Math.max(...prices) : 0,
      },
      pagination: {
        page,
        limit,
        total: count || 0,
        pages: Math.ceil((count || 0) / limit),
      },
    };
  }
}
