import { Injectable } from '@nestjs/common'
import { supabase } from '../../config/supabase'

@Injectable()
export class BusinessService {

  async getVendorPlaces(vendorId:string){

    const { data, error } = await supabase
      .schema('travel')
      .from('places')
      .select('*')
      .eq('vendor_id', vendorId)

    if(error) throw error

    return data
  }

}