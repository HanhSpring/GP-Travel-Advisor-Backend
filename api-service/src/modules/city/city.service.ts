import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { supabase } from '../../config/supabase';
import { City } from './entity/city.entity';

@Injectable()
export class CitiesService {
  async findAll(
    searchKeyword?: string,
    destinationOnly?: boolean,
  ): Promise<City[]> {
    const { data, error } = await supabase.rpc('get_cities_for_plan_trip', {
      p_keyword: searchKeyword?.trim() || null,
      p_destination_only: !!destinationOnly,
    });

    if (error) {
      throw new InternalServerErrorException(
        `Lỗi khi lấy danh sách thành phố: ${error.message}`,
      );
    }

    return data as City[];
  }
}
