import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { supabase } from '../../config/supabase';
import { City } from './entity/city.entity';

@Injectable()
export class CitiesService {
  async findAll(searchKeyword?: string): Promise<City[]> {
    let query = supabase
      .schema('travel')
      .from('cities')
      .select('id, name')
      .order('name', { ascending: true })
      .limit(20);

    if (searchKeyword) {
      query = query.ilike('name', `%${searchKeyword}%`);
    }

    const { data, error } = await query;

    if (error) {
      throw new InternalServerErrorException(`Lỗi khi lấy danh sách thành phố: ${error.message}`);
    }

    return data as City[];
  }
}
