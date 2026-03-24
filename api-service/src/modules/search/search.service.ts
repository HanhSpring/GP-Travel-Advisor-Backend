import { Injectable, InternalServerErrorException } from '@nestjs/common'
import { supabase } from 'src/config/supabase'

@Injectable()
export class SearchService {

  async autocomplete(query: string) {

    const { data, error } = await supabase
      .schema('travel')
      .rpc('search_autocomplete', {
        p_query: query
      })

    if (error) {
      console.error('Autocomplete error:', error)
      throw new InternalServerErrorException(error.message)
    }

    return data
  }

  async searchAdvanced(query: string) {

    const { data, error } = await supabase
      .schema('travel')
      .rpc('search_places_advanced', {
        p_query: query
      })

    if (error) {
      console.error('Search error:', error)
      throw new InternalServerErrorException(error.message)
    }

    return data
  }

  async getPlacesByFilter(city: string, category: string) {

    const { data, error } = await supabase
      .schema('travel') 
      .rpc('get_places_by_filter', {
        p_city: city,
        p_category: category
      })

    if (error) {
      console.error('Supabase RPC error:', error)
      throw new InternalServerErrorException(error.message)
    }

    return data
  }
}