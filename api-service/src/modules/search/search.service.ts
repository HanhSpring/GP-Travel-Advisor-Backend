import { Injectable } from '@nestjs/common'
import { supabase } from '../../config/supabase'

@Injectable()
export class SearchService {

  async searchPlaces(query: string) {

    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .select('*')
      .ilike('name', `%${query}%`)
      .eq('is_active', true)

    if (error) {
      console.error("Supabase error:", error)
      throw error
    }

    return data
  }

}