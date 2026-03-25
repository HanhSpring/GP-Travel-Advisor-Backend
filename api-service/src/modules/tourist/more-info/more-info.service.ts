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
}

interface OrderItemRow {
  order_id: string;
  food_item_id: string;
}

interface FoodItemRow {
  id: string;
  name: string | null;
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

    if (value.includes('preparing') || value.includes('pending')) {
      return 'Dang chuan bi';
    }

    if (value.includes('shipping')) {
      return 'Dang giao';
    }

    if (value.includes('delivered') || value.includes('completed')) {
      return 'Da giao';
    }

    if (value.includes('cancel')) {
      return 'Da huy';
    }

    return 'Dang xu ly';
  }

  async getMoreInfo(touristId: string) {
    if (!touristId) {
      throw new BadRequestException('tourist_id is required');
    }

    const { data: user, error: userError } = await supabase
      .schema('core')
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
      .select('id, status, ordered_at')
      .eq('tourist_id', touristId)
      .order('ordered_at', { ascending: false })
      .limit(5);

    let recentOrders: Array<{
      order_id: string;
      order_code: string;
      item_name: string;
      status: string;
      status_label: string;
    }> = [];

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
      const orderIds = orders.map((item) => item.id);

      const orderItemsResult = orderIds.length
        ? await supabase
            .schema('order_sys')
            .from('order_items')
            .select('order_id, food_item_id')
            .in('order_id', orderIds)
        : { data: [], error: null };

      if (orderItemsResult.error) {
        if (orderItemsResult.error.code === '42P01') {
          orderFallbackMessage =
            'He thong chi tiet don hang chua duoc khoi tao trong CSDL';
        } else {
          throw new InternalServerErrorException(
            orderItemsResult.error.message,
          );
        }
      }

      const orderItems = (orderItemsResult.data ?? []) as OrderItemRow[];
      const foodItemIds = Array.from(
        new Set(orderItems.map((item) => item.food_item_id)),
      );

      const foodItemsResult = foodItemIds.length
        ? await supabase
            .schema('order_sys')
            .from('food_items')
            .select('id, name')
            .in('id', foodItemIds)
        : { data: [], error: null };

      if (foodItemsResult.error) {
        throw new InternalServerErrorException(foodItemsResult.error.message);
      }

      const foodItems = (foodItemsResult.data ?? []) as FoodItemRow[];

      recentOrders = orders.slice(0, 2).map((order) => {
        const firstItem = orderItems.find((item) => item.order_id === order.id);
        const foodName = foodItems.find(
          (item) => item.id === firstItem?.food_item_id,
        )?.name;

        return {
          order_id: order.id,
          order_code: `#${order.id.slice(0, 6).toUpperCase()}`,
          item_name: foodName ?? 'Don hang am thuc',
          status: order.status ?? 'processing',
          status_label: this.mapOrderStatusLabel(order.status),
        };
      });
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
}
