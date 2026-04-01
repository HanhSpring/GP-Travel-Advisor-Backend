import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { supabase } from '../../../config/supabase';

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

type FoodCategory = 'all' | 'main' | 'drink';

@Injectable()
export class OrdersService {
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
        title: `Ban sap den ${place.name}`,
        message:
          'Ban co muon dat truoc mon an de khong phai cho doi khi den noi?',
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
