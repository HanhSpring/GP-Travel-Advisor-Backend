import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { supabase } from 'src/config/supabase';

type SearchRow = Record<string, unknown>;

export interface AutocompleteItem {
  id: string;
  name: string;
  type: 'place' | 'city';
  image: string;
  city: string;
  rating: number;
  score: number;
}

@Injectable()
export class SearchService {
  private readonly defaultPlaceImageUrl =
    process.env.DEFAULT_PLACE_IMAGE_URL ||
    'https://placehold.co/1080x720?text=No+Image';

  private asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  /**
   * Autocomplete: gọi RPC travel.search_autocomplete (đã nâng cấp ở migration
   * sql/2026_search_optimization.sql) — trả id, name, type, image, city, rating, score.
   * Map phòng thủ để vẫn chạy được kể cả khi DB còn function bản cũ (chưa có image/city/rating).
   */
  async autocomplete(query: string): Promise<AutocompleteItem[]> {
    const q = (query ?? '').trim();
    if (q.length === 0) {
      return [];
    }

    // Chỉ truyền p_query để tương thích cả function cũ (1 tham số) lẫn mới (p_limit có default).
    const { data, error } = await supabase
      .schema('travel')
      .rpc('search_autocomplete', { p_query: q })
      .returns<SearchRow[]>();

    if (error) {
      // Không ném 500: lỗi tạm thời (vd timeout) → trả rỗng để FE hiện "không có kết quả"
      // thay vì banner đỏ "failed to search locations".
      console.error('Autocomplete error:', error);
      return [];
    }

    const rows = Array.isArray(data) ? data : [];
    return rows.map((row) => {
      const type =
        this.asString(row['type']).trim().toLowerCase() === 'city'
          ? 'city'
          : 'place';
      const image = this.asString(row['image']).trim();

      return {
        id: this.asString(row['id']),
        name: this.asString(row['name']),
        type,
        // Place không có ảnh → dùng ảnh mặc định; city để rỗng (FE hiện icon).
        image: type === 'place' ? image || this.defaultPlaceImageUrl : image,
        city: this.asString(row['city']),
        rating: Number(row['rating']) || 0,
        score: Number(row['score']) || 0,
      };
    });
  }

  async searchAdvanced(query: string): Promise<SearchRow[]> {
    const result = (await supabase
      .schema('travel')
      .rpc('search_places_advanced', {
        p_query: query,
      })) as { data: unknown; error: { message: string } | null };

    const { data, error } = result;

    if (error) {
      console.error('Search error:', error);
      throw new InternalServerErrorException(error.message);
    }

    return Array.isArray(data) ? (data as SearchRow[]) : [];
  }

  async getPlacesByFilter(
    city: string,
    category: string,
  ): Promise<SearchRow[]> {
    const result = (await supabase
      .schema('travel')
      .rpc('get_places_by_filter', {
        p_city: city,
        p_category: category,
      })) as { data: unknown; error: { message: string } | null };

    const { data, error } = result;

    if (error) {
      console.error('Supabase RPC error:', error);
      throw new InternalServerErrorException(error.message);
    }

    return Array.isArray(data) ? (data as SearchRow[]) : [];
  }

  private deg2rad(deg: number): number {
    return deg * (Math.PI / 180);
  }

  private getDistanceFromLatLonInKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371; // Bán kính Trái Đất (km)
    const dLat = this.deg2rad(lat2 - lat1);
    const dLon = this.deg2rad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.deg2rad(lat1)) *
        Math.cos(this.deg2rad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  async getNearbyPlaces(
    lat: number,
    lng: number,
    limit: number = 20,
    excludeIds: string[] = [],
    preferCategory: string = '',
    radius: number = 10,
  ): Promise<any[]> {
    // Pre-filter with bounding box to avoid fetching the entire table.
    const latDelta = radius / 111.32;
    const lngDelta = radius / (111.32 * Math.cos((lat * Math.PI) / 180));

    let query = supabase
      .schema('travel')
      .from('places')
      .select(
        'id, name, address, average_rating, review_count, image_url, latitude, longitude, open_hour_compressed, types(id, category_id, categories(id, name))',
      )
      .eq('is_approved', true)
      .eq('is_active', true)
      .gte('latitude', lat - latDelta)
      .lte('latitude', lat + latDelta)
      .gte('longitude', lng - lngDelta)
      .lte('longitude', lng + lngDelta);

    if (excludeIds.length > 0) {
      query = query.not('id', 'in', `(${excludeIds.join(',')})`);
    }

    const { data, error } = await query;

    if (error) {
      console.error('getNearbyPlaces error:', error);
      throw new InternalServerErrorException(error.message);
    }

    const places = (data || []) as any[];
    const normalizedPrefer = preferCategory.trim().toLowerCase();

    const placesWithDistance = places.map((place) => {
      const distance =
        place.latitude && place.longitude
          ? this.getDistanceFromLatLonInKm(lat, lng, place.latitude, place.longitude)
          : Infinity;

      let category = 'Tham quan';
      const typeData = Array.isArray(place.types) ? place.types[0] : place.types;
      if (typeData && typeData.categories) {
        const catData = Array.isArray(typeData.categories) ? typeData.categories[0] : typeData.categories;
        if (catData && catData.name) category = catData.name;
      }

      let parsedImageUrl = 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=600&q=80';
      if (Array.isArray(place.image_url) && place.image_url.length > 0) {
        parsedImageUrl = place.image_url[0];
      } else if (typeof place.image_url === 'string' && place.image_url.trim().length > 0) {
        parsedImageUrl = place.image_url;
      }

      const isSameCategory =
        normalizedPrefer.length > 0 &&
        category.trim().toLowerCase() === normalizedPrefer;

      return {
        id: place.id,
        name: place.name,
        address: place.address || '',
        category,
        rating: place.average_rating || 0,
        reviewCount: place.review_count || 0,
        imageUrl: parsedImageUrl,
        distanceKm: distance === Infinity ? null : Number(distance.toFixed(1)),
        latitude: place.latitude,
        longitude: place.longitude,
        isSameCategory,
        openHourCompressed: place.open_hour_compressed || null,
      };
    });

    // Bounding box over-approximates — do a precise Haversine filter as the final step.
    const inRadius = placesWithDistance
      .filter((p) => p.distanceKm !== null && p.distanceKm <= radius)
      .sort((a, b) => (a.distanceKm as number) - (b.distanceKm as number));

    // Same-category places first (sorted by distance), then the rest.
    const sameCategory = inRadius.filter((p) => p.isSameCategory);
    const others = inRadius.filter((p) => !p.isSameCategory);

    return [...sameCategory, ...others].slice(0, limit);
  }
}

