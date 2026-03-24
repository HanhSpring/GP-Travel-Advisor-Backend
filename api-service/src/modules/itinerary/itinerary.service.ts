import { Injectable } from '@nestjs/common'
import { supabase } from '../../config/supabase'

@Injectable()
export class ItineraryService {

async getMyItineraries(userId: string) {

  const { data, error } = await supabase
    .schema('travel')
    .rpc('get_my_itineraries', {
      p_user_id: userId
    })

  if (error) {
    console.error("Supabase RPC error:", error)
    throw error
  }

  return data
}
}