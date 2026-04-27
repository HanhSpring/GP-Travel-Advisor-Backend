import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { supabase } from 'src/config/supabase';

type SearchRow = Record<string, unknown>;

@Injectable()
export class SearchService {
  private asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  async autocomplete(query: string): Promise<SearchRow[]> {
    const { data, error } = await supabase
      .schema('travel')
      .rpc('search_autocomplete', {
        p_query: query,
      })
      .returns<SearchRow[]>();

    if (error) {
      console.error('Autocomplete error:', error);
      throw new InternalServerErrorException(error.message);
    }

    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) {
      return rows;
    }

    const placeIds = Array.from(
      new Set(
        rows
          .filter(
            (item) =>
              this.asString(item['type']).trim().toLowerCase() === 'place',
          )
          .map((item) => this.asString(item['id']).trim())
          .filter((id) => id.length > 0),
      ),
    );

    if (placeIds.length === 0) {
      return rows;
    }

    const { data: validPlaces, error: validPlacesError } = await supabase
      .schema('travel')
      .from('places')
      .select('id')
      .in('id', placeIds)
      .eq('is_approved', true)
      .eq('is_active', true)
      .returns<Array<{ id: string }>>();

    if (validPlacesError) {
      throw new InternalServerErrorException(validPlacesError.message);
    }

    const validPlaceIds = new Set((validPlaces ?? []).map((item) => item.id));

    return rows.filter((item) => {
      const type = this.asString(item['type']).trim().toLowerCase();
      if (type !== 'place') {
        return true;
      }

      const id = this.asString(item['id']).trim();
      return id.length > 0 && validPlaceIds.has(id);
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
