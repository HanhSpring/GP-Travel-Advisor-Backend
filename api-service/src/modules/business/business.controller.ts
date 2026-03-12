import { Controller, Get, Query } from '@nestjs/common'
import { ApiTags, ApiOperation } from '@nestjs/swagger'
import { BusinessService } from './business.service'

@ApiTags('Business')
@Controller('business')
export class BusinessController {

  constructor(private readonly service: BusinessService){}

  @Get('places')
  @ApiOperation({ summary: 'Get vendor places' })
  getPlaces(@Query('vendorId') vendorId:string){
    return this.service.getVendorPlaces(vendorId)
  }

}