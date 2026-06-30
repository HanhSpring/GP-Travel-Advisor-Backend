import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { supabase } from '../../../config/supabase';

interface UserRow {
  id: string;
  full_name: string | null;
}

interface ReviewRow {
  id: string;
  place_id: string;
  rating: number;
  created_at: string;
  review_type: 'with_content' | 'without_content' | null;
}

interface PlaceRow {
  id: string;
  name: string;
}

interface OrderRow {
  id: string;
  status: string | null;
  ordered_at: string | null;
  total_amount?: number | null;
  notes?: string | null;
  tourist_id?: string;
  itinerary_detail_id?: string | null;
}

interface OrderItemRow {
  id?: string;
  order_id: string;
  food_item_id: string;
  quantity?: number | null;
  unit_price?: number | null;
  total_price?: number | null;
}

interface FoodItemRow {
  id: string;
  name: string | null;
  price?: number | null;
  place_id?: string | null;
}

interface OrderSummary {
  order_id: string;
  order_code: string;
  restaurant_name: string;
  status: string;
  status_label: string;
  ordered_at: string | null;
  total_amount: number;
}

@Injectable()
export class MoreInfoService {
  private mapMembershipLabel(reviewCount: number): string {
    if (reviewCount >= 20) {
      return 'Thanh vien Kim cuong';
    }

    if (reviewCount >= 10) {
      return 'Thanh vien Vang';
    }

    return 'Thanh vien';
  }

  private mapOrderStatusLabel(status: string | null): string {
    const value = (status ?? '').toLowerCase();

    if (value === 'pending') {
      return 'Chờ xác nhận';
    }

    if (value === 'processing') {
      return 'Đang chuẩn bị';
    }

    if (value === 'completed') {
      return 'Hoàn thành';
    }

    if (value === 'cancelled' || value === 'canceled') {
      return 'Bị huỷ';
    }

    return 'Đang chuẩn bị';
  }

  private buildOrderCode(orderId: string): string {
    return `#TRV${orderId.slice(0, 6).toUpperCase()}`;
  }

  private async buildOrderSummaries(
    orders: OrderRow[],
  ): Promise<OrderSummary[]> {
    const orderIds = orders.map((item) => item.id);

    const orderItemsResult = orderIds.length
      ? await supabase
          .schema('order_sys')
          .from('order_items')
          .select(
            'id, order_id, food_item_id, quantity, unit_price, total_price',
          )
          .in('order_id', orderIds)
      : { data: [], error: null };

    if (orderItemsResult.error) {
      throw new InternalServerErrorException(orderItemsResult.error.message);
    }

    const orderItems = (orderItemsResult.data ?? []) as OrderItemRow[];
    const foodItemIds = Array.from(
      new Set(orderItems.map((item) => item.food_item_id)),
    );

    const foodItemsResult = foodItemIds.length
      ? await supabase
          .schema('order_sys')
          .from('food_items')
          .select('id, name, price, place_id')
          .in('id', foodItemIds)
      : { data: [], error: null };

    if (foodItemsResult.error) {
      throw new InternalServerErrorException(foodItemsResult.error.message);
    }

    const foodItems = (foodItemsResult.data ?? []) as FoodItemRow[];
    const placeIds = Array.from(
      new Set(
        foodItems
          .map((item) => item.place_id)
          .filter((value): value is string => !!value),
      ),
    );

    const placesResult = placeIds.length
      ? await supabase
          .schema('travel')
          .from('places')
          .select('id, name')
          .in('id', placeIds)
      : { data: [], error: null };

    if (placesResult.error) {
      throw new InternalServerErrorException(placesResult.error.message);
    }

    const places = (placesResult.data ?? []) as PlaceRow[];

    return orders.map((order) => {
      const firstItem = orderItems.find((item) => item.order_id === order.id);
      const foodItem = foodItems.find(
        (item) => item.id === firstItem?.food_item_id,
      );
      const place = places.find((item) => item.id === foodItem?.place_id);

      return {
        order_id: order.id,
        order_code: this.buildOrderCode(order.id),
        restaurant_name: place?.name ?? 'Quán ăn',
        status: order.status ?? 'processing',
        status_label: this.mapOrderStatusLabel(order.status),
        ordered_at: order.ordered_at ?? null,
        total_amount: Number(order.total_amount) || 0,
      };
    });
  }

  async getMoreInfo(touristId: string) {
    if (!touristId) {
      throw new BadRequestException('tourist_id is required');
    }

    const { data: user, error: userError } = await supabase
      .schema('public')
      .from('users')
      .select('id, full_name')
      .eq('id', touristId)
      .maybeSingle<UserRow>();

    if (userError) {
      throw new InternalServerErrorException(userError.message);
    }

    if (!user) {
      throw new NotFoundException('Tourist user not found');
    }

    const { data: reviewRows, error: reviewError } = await supabase
      .schema('review_ai')
      .from('reviews')
      .select('id, place_id, rating, created_at, review_type')
      .eq('tourist_id', touristId)
      .order('created_at', { ascending: false });

    if (reviewError) {
      throw new InternalServerErrorException(reviewError.message);
    }

    const reviews = (reviewRows ?? []) as ReviewRow[];
    const placeIds = Array.from(new Set(reviews.map((item) => item.place_id)));

    const placesResult = placeIds.length
      ? await supabase
          .schema('travel')
          .from('places')
          .select('id, name')
          .in('id', placeIds)
      : { data: [], error: null };

    if (placesResult.error) {
      throw new InternalServerErrorException(placesResult.error.message);
    }

    const places = (placesResult.data ?? []) as PlaceRow[];

    const reviewed = reviews.slice(0, 3).map((item) => {
      const place = places.find((p) => p.id === item.place_id);

      return {
        place_id: item.place_id,
        place_name: place?.name ?? 'Dia diem',
        rating: item.rating,
        reviewed_at: item.created_at,
      };
    });

    const pendingReviewRows = reviews.filter(
      (item) => item.review_type === 'without_content',
    );

    const pending = pendingReviewRows.slice(0, 3).map((item) => {
      const place = places.find((p) => p.id === item.place_id);

      return {
        place_id: item.place_id,
        place_name: place?.name ?? 'Dia diem',
        reason: 'Cho ban chia se',
      };
    });

    // Optional order tables may not exist yet in current DB.
    const orderResult = await supabase
      .schema('order_sys')
      .from('orders')
      .select('id, status, ordered_at, total_amount')
      .eq('tourist_id', touristId)
      .order('ordered_at', { ascending: false })
      .limit(2);

    let recentOrders: OrderSummary[] = [];

    let orderFallbackMessage: string | null = null;

    if (orderResult.error) {
      if (orderResult.error.code === '42P01') {
        orderFallbackMessage =
          'He thong don hang chua duoc khoi tao trong CSDL';
      } else {
        throw new InternalServerErrorException(orderResult.error.message);
      }
    } else {
      const orders = (orderResult.data ?? []) as OrderRow[];
      recentOrders = await this.buildOrderSummaries(orders);
    }

    return {
      user: {
        id: user.id,
        full_name: user.full_name ?? 'Nguoi dung',
        membership_label: this.mapMembershipLabel(reviews.length),
        avatar_url: null,
      },
      place_reviews: {
        reviewed,
        pending_count: pendingReviewRows.length,
        pending,
        view_all_target: '/reviews',
      },
      food_orders: {
        recent_orders: recentOrders,
        fallback_message: orderFallbackMessage,
        view_all_target: '/orders',
      },
      actions: {
        account_settings_target: '/account-settings',
        logout_target: '/auth/logout',
      },
    };
  }

  async getOrders(touristId: string) {
    if (!touristId) {
      throw new BadRequestException('tourist_id is required');
    }

    const { data, error } = await supabase
      .schema('order_sys')
      .from('orders')
      .select('id, status, ordered_at, total_amount')
      .eq('tourist_id', touristId)
      .order('ordered_at', { ascending: false });

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const orders = (data ?? []) as OrderRow[];
    return {
      orders: await this.buildOrderSummaries(orders),
    };
  }

  async getOrderDetail(orderId: string, touristId: string) {
    if (!orderId || !touristId) {
      throw new BadRequestException('order_id and tourist_id are required');
    }

    const { data: order, error: orderError } = await supabase
      .schema('order_sys')
      .from('orders')
      .select(
        'id, status, ordered_at, total_amount, notes, tourist_id, itinerary_detail_id',
      )
      .eq('id', orderId)
      .eq('tourist_id', touristId)
      .maybeSingle<OrderRow>();

    if (orderError) {
      throw new InternalServerErrorException(orderError.message);
    }

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const { data: itemRows, error: itemsError } = await supabase
      .schema('order_sys')
      .from('order_items')
      .select('id, order_id, food_item_id, quantity, unit_price, total_price')
      .eq('order_id', orderId);

    if (itemsError) {
      throw new InternalServerErrorException(itemsError.message);
    }

    const orderItems = (itemRows ?? []) as OrderItemRow[];
    const foodItemIds = Array.from(
      new Set(orderItems.map((item) => item.food_item_id)),
    );

    const foodItemsResult = foodItemIds.length
      ? await supabase
          .schema('order_sys')
          .from('food_items')
          .select('id, name, price, place_id')
          .in('id', foodItemIds)
      : { data: [], error: null };

    if (foodItemsResult.error) {
      throw new InternalServerErrorException(foodItemsResult.error.message);
    }

    const foodItems = (foodItemsResult.data ?? []) as FoodItemRow[];
    const placeIds = Array.from(
      new Set(
        foodItems
          .map((item) => item.place_id)
          .filter((value): value is string => !!value),
      ),
    );

    const placesResult = placeIds.length
      ? await supabase
          .schema('travel')
          .from('places')
          .select('id, name')
          .in('id', placeIds)
      : { data: [], error: null };

    if (placesResult.error) {
      throw new InternalServerErrorException(placesResult.error.message);
    }

    const places = (placesResult.data ?? []) as PlaceRow[];
    const firstFoodItem = foodItems[0];
    const place = places.find((item) => item.id === firstFoodItem?.place_id);

    return {
      order: {
        order_id: order.id,
        order_code: this.buildOrderCode(order.id),
        restaurant_name: place?.name ?? 'Quán ăn',
        status: order.status ?? 'processing',
        status_label: this.mapOrderStatusLabel(order.status),
        ordered_at: order.ordered_at ?? null,
        total_amount: Number(order.total_amount) || 0,
        notes: order.notes ?? null,
      },
      items: orderItems.map((item) => {
        const foodItem = foodItems.find(
          (food) => food.id === item.food_item_id,
        );
        const quantity = Number(item.quantity) || 1;
        const unitPrice = Number(item.unit_price ?? foodItem?.price) || 0;
        const totalPrice = Number(item.total_price) || unitPrice * quantity;

        return {
          id: item.id ?? `${order.id}:${item.food_item_id}`,
          food_item_id: item.food_item_id,
          name: foodItem?.name ?? 'Món ăn',
          quantity,
          unit_price: unitPrice,
          total_price: totalPrice,
        };
      }),
    };
  }
}
