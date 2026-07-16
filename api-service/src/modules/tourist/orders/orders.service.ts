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
  image_url?: string[] | string | null;
  category?: string | null;
  is_active?: boolean | null;
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

interface TypeCategoryRow {
  id: string;
  name: string | null;
}

interface PlaceTypeRow {
  id: string;
  name: string | null;
  category_id: string | null;
  categories: TypeCategoryRow | TypeCategoryRow[] | null;
}

interface OrderPlaceRow {
  id: string;
  name: string;
  type_id: string | null;
  types: PlaceTypeRow | PlaceTypeRow[] | null;
}

interface OrderRow {
  id: string;
  total_amount: number | null;
}

type FoodCategory = 'all' | 'main' | 'drink';

import { CommonNotificationsService } from '../../common/notifications/notifications.service';

@Injectable()
export class OrdersService {
  constructor(private readonly notificationsService: CommonNotificationsService) {}

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
      normalized.includes('am thuc') ||
      normalized.includes('cafe') ||
      normalized.includes('ca phe') ||
      normalized.includes('restaurant') ||
      normalized.includes('nha hang')
    );
  }

  private extractSingle<T>(data: T | T[] | null): T | null {
    if (!data) {
      return null;
    }

    return Array.isArray(data) ? (data[0] ?? null) : data;
  }

  private isOrderEligibleType(
    typeName: string | null,
    categoryName: string | null,
  ): boolean {
    if (categoryName && this.isOrderEligibleCategory(categoryName)) {
      return true;
    }

    const normalizedType = this.normalizeText(typeName ?? '');
    const eligibleTypeNames = [
      'pub/bar',
      'nha hang',
      'cafe & do uong',
      'tiem banh & trang mieng',
      'quan chay',
      'quan an',
      'buffet & khu am thuc',
    ];

    return eligibleTypeNames.includes(normalizedType);
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
    const payload = this.base64UrlEncode(
      JSON.stringify({ orderId, expiresAt }),
    );
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

  private getActionUrl(
    token: string,
    action: 'confirm' | 'complete' | 'cancel',
  ): string {
    return `${this.getApiBaseUrl()}/order-actions/${token}?action=${action}`;
  }

  private getOrderActionEmailHtml(params: {
    orderId: string;
    placeName: string;
    totalAmount: number;
    items: Array<{ name: string; quantity: number; total_price: number }>;
    confirmUrl: string;
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
          <a href="${params.cancelUrl}" style="display:inline-block;background:#ef4444;color:white;padding:10px 14px;border-radius:8px;text-decoration:none;font-weight:700;margin-left:8px">Hủy đơn</a>
        </p>
        <p style="color:#64748b;font-size:13px">Link có hiệu lực trong 3 ngày.</p>
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
    const to =
      process.env.ORDER_NOTIFICATION_EMAIL || 'trip.datn2026@gmail.com';
    const from =
      process.env.RESEND_FROM || 'Travel Advisor <onboarding@resend.dev>';

    if (!apiKey) {
      console.warn(
        'RESEND_API_KEY is missing. Skipped order email notification.',
      );
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

  private getTargetStatus(
    action: string,
  ): 'processing' | 'cancelled' {
    if (action === 'confirm') return 'processing';
    if (action === 'cancel') return 'cancelled';
    throw new BadRequestException('Thao tác xử lý đơn không hợp lệ');
  }

  private canTransitionOrderStatus(
    currentStatus: string,
    targetStatus: string,
  ): boolean {
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
      .select('id, status, place_id')
      .eq('id', orderId)
      .maybeSingle<{ id: string; status: string; place_id: string | null }>();

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

    const updatePayload: Record<string, unknown> = { status: targetStatus };

    if (targetStatus === 'processing') {
      const now = new Date();
      updatePayload.confirmed_at = now.toISOString();
      const prepMinutes = await this.getEstimatedPrepTime(orderId, order.place_id);
      if (prepMinutes) {
        updatePayload.auto_complete_at = new Date(
          now.getTime() + prepMinutes * 60 * 1000,
        ).toISOString();
      }
    }

    const { data, error } = await supabase
      .schema('order_sys')
      .from('orders')
      .update(updatePayload)
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

  private async getEstimatedPrepTime(
    orderId: string,
    placeId: string | null,
  ): Promise<number | null> {
    // Try via place_id stored on the order (available after migration)
    if (placeId) {
      const { data } = await supabase
        .schema('travel')
        .from('places')
        .select('estimated_preparation_time')
        .eq('id', placeId)
        .maybeSingle<{ estimated_preparation_time: number | null }>();
      if (data?.estimated_preparation_time) return data.estimated_preparation_time;
    }

    // Fallback: join through order_items → food_items → places
    const { data: items } = await supabase
      .schema('order_sys')
      .from('order_items')
      .select('food_item_id')
      .eq('order_id', orderId)
      .limit(1);

    const foodItemId = (items as Array<{ food_item_id: string }> | null)?.[0]
      ?.food_item_id;
    if (!foodItemId) return null;

    const { data: foodItem } = await supabase
      .schema('order_sys')
      .from('food_items')
      .select('place_id')
      .eq('id', foodItemId)
      .maybeSingle<{ place_id: string }>();

    if (!foodItem?.place_id) return null;

    const { data: place } = await supabase
      .schema('travel')
      .from('places')
      .select('estimated_preparation_time')
      .eq('id', foodItem.place_id)
      .maybeSingle<{ estimated_preparation_time: number | null }>();

    return place?.estimated_preparation_time ?? null;
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
    const value = this.normalizeText(name ?? '');
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

  private normalizeFoodCategory(
    category: string | null | undefined,
    name: string | null,
  ): 'main' | 'drink' {
    const normalized = this.normalizeText(category ?? '');

    if (
      normalized === 'drink' ||
      normalized.includes('do uong') ||
      normalized.includes('thuc uong') ||
      normalized.includes('nuoc') ||
      normalized.includes('cafe') ||
      normalized.includes('ca phe')
    ) {
      return 'drink';
    }

    if (
      normalized === 'main' ||
      normalized.includes('mon chinh') ||
      normalized.includes('mon an') ||
      normalized.includes('food')
    ) {
      return 'main';
    }

    return this.mapFoodCategory(name);
  }

  private extractFoodImageUrl(
    imageUrl: string[] | string | null | undefined,
    seed: string,
  ): string {
    if (Array.isArray(imageUrl)) {
      const firstUrl = imageUrl.find(
        (url) => typeof url === 'string' && url.trim().length > 0,
      );
      if (firstUrl) {
        return firstUrl.trim();
      }
    }

    if (typeof imageUrl === 'string' && imageUrl.trim().length > 0) {
      return imageUrl.trim();
    }

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
      .select(
        'id, name, type_id, types(id, name, category_id, categories(id, name))',
      )
      .in('id', orderedUniquePlaceIds)
      .returns<OrderPlaceRow[]>();

    if (placeError) {
      throw new InternalServerErrorException(placeError.message);
    }

    const placeMap = new Map(
      (placeRows ?? []).map((item) => [item.id, item.name]),
    );
    const placeTypeMap = new Map(
      (placeRows ?? []).map((item) => [item.id, item]),
    );

    const filtered = orderedUniquePlaceIds
      .map((placeId) => {
        const place = placeTypeMap.get(placeId);
        const type = this.extractSingle(place?.types ?? null);
        const category = this.extractSingle(type?.categories ?? null);
        const typeName = type?.name ?? null;
        const categoryName = category?.name ?? null;
        const categories = [categoryName, typeName].filter(
          (value): value is string => !!value,
        );
        const eligible = this.isOrderEligibleType(typeName, categoryName);

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
      .select('id, name, estimated_preparation_time, vendor_id')
      .eq('id', placeId)
      .maybeSingle<{ id: string; name: string; estimated_preparation_time: number | null; vendor_id: string | null }>();

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
        place_id: placeId,
      },
      {
        id: orderId,
        ordered_at: orderedAt,
        total_amount: totalAmount,
        status: 'pending',
        tourist_id: payload.tourist_id,
        place_id: placeId,
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

    if (place.vendor_id) {
      await this.notificationsService.createNotification(
        [place.vendor_id],
        'Đơn đặt món mới',
        `Bạn có một đơn đặt món mới tại "${place.name}" với tổng tiền ${totalAmount.toLocaleString('vi-VN')}đ.`,
        'success',
        'new_order',
        { order_id: orderId, place_id: placeId }
      );
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
      .select(
        'id, name, description, price, place_id, image_url, category, is_active',
        {
          count: 'exact',
        },
      )
      .eq('place_id', placeId)
      .or('is_active.is.null,is_active.eq.true')
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
      category: this.normalizeFoodCategory(item.category, item.name),
      image_url: this.extractFoodImageUrl(item.image_url, item.id),
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
