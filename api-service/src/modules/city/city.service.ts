import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { supabase } from '../../config/supabase';
import { City } from './entity/city.entity';

@Injectable()
export class CitiesService {
  async findAll(searchKeyword?: string): Promise<City[]> {
    const { data, error } = await supabase.rpc('get_cities_for_plan_trip', {
      p_keyword: searchKeyword?.trim() ?? null,
    });

    if (error) {
      throw new InternalServerErrorException(
        `Lỗi khi lấy danh sách thành phố: ${error.message}`,
      );
    }

    return data as City[];
  }
}
