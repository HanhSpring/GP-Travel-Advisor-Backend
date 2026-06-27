import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
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

@Injectable()
export class OrdersService {
  constructor() {}

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
    const statusCandidates = ['pending', 'processing', 'confirmed', 'created'];

    const orderInsertVariants = statusCandidates.flatMap((status) => [
      {
        id: orderId,
        ordered_at: orderedAt,
        total_amount: totalAmount,
        status,
        notes: payload.notes ?? null,
        tourist_id: payload.tourist_id,
        itinerary_detail_id: payload.itinerary_detail_id ?? null,
      },
      {
        id: orderId,
        ordered_at: orderedAt,
        total_amount: totalAmount,
        status,
        tourist_id: payload.tourist_id,
      },
      {
        id: orderId,
        ordered_at: orderedAt,
        status,
        tourist_id: payload.tourist_id,
      },
    ]);

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

    return {
      success: true,
      order_id: orderId,
      total_amount: totalAmount,
      items: normalizedItems,
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
