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
}
