import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { supabase } from '../../config/supabase';
import { PlaceType } from './entity/place-type.entity';

@Injectable()
export class PlaceTypesService {
  async findAll(searchKeyword?: string): Promise<PlaceType[]> {
    let query = supabase
      .schema('travel')
      .from('types')
      .select('id, name')
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

    return data as PlaceType[];
  }
}
