import { Injectable } from '@nestjs/common'
import { supabase } from '../../config/supabase'

@Injectable()
export class ItineraryService {

  async createItinerary(body:any){

    const { data, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .insert([body])
      .select()

    if(error) throw error

    return data
  }

  async getMyItinerary(userId:string){

    const { data, error } = await supabase
      .schema('travel')
      .from('itineraries')
      .select('*')
      .eq('creator_id', userId)

    if(error) throw error

    return data
  }

}