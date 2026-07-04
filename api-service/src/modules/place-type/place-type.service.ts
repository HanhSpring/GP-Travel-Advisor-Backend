import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { supabase } from '../../config/supabase';
import { PlaceType } from './entity/place-type.entity';

@Injectable()
export class PlaceTypesService {
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
      } as PlaceType;
    });
  }
}
