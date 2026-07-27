import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { supabase } from '../../config/supabase';
import { PlaceType } from './entity/place-type.entity';

@Injectable()
export class PlaceTypesService {
  private resolveDataMode(...values: Array<string | null | undefined>) {
    const value = values
      .filter(Boolean)
      .join(' ')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    if (/(luu tru|khach san|nha nghi|hotel|motel|hostel|homestay|resort|villa|can ho|accommodation)/.test(value)) {
      return 'accommodation' as const;
    }
    if (/(am thuc|nha hang|quan an|an uong|food|restaurant|cafe|coffee)/.test(value)) {
      return 'food' as const;
    }
    return 'service' as const;
  }

  async findAll(searchKeyword?: string): Promise<PlaceType[]> {
    let query = supabase
      .schema('travel')
      .from('types')
      .select('id, name, categories(id, name)')
      .order('name', { ascending: true });

    if (searchKeyword?.trim()) {
      query = query.ilike('name', `%${searchKeyword.trim()}%`);
    }

    const { data, error } = await query;

    if (error) {
      throw new InternalServerErrorException(
        `Lỗi khi lấy danh sách loại hình kinh doanh: ${error.message}`,
      );
    }

    return ((data ?? []) as any[]).map((row) => {
      const cat = Array.isArray(row.categories) ? row.categories[0] : row.categories;
      return {
        id: row.id,
        name: row.name,
        category_id: cat?.id ?? null,
        category_name: cat?.name ?? null,
        data_mode: this.resolveDataMode(cat?.name, row.name),
      } as PlaceType;
    });
  }
}
