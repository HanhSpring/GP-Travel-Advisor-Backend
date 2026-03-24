import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { BusinessService } from './business.service'
import { VendorDto, PlaceDto, OrderDto } from './dto/business-query.dto'
import { DashboardDto, PlaceItemDto, OrderItemDto } from './dto/business-response.dto'
import {
  Controller,
  Get,
  Query,
  Post,
  Body,
  UploadedFile,
  UseInterceptors
} from '@nestjs/common'

import {
  ApiConsumes,
  ApiBody
} from '@nestjs/swagger'

import { CreateFullPlaceDto } from './dto/create-full-place.dto'

import { FileInterceptor } from '@nestjs/platform-express'

@ApiTags('Business')
@Controller('business')
export class BusinessController {

  constructor(private readonly service: BusinessService) { }

  @Get('places')
  @ApiOperation({ summary: 'Get places managed by vendor' })
  @ApiResponse({ type: [PlaceItemDto] })
  getVendorPlaces(@Query() query: VendorDto) {
    return this.service.getVendorPlaces(query.vendorId)
  }

  @Get('place-detail')
  getPlaceDetail(@Query() query: PlaceDto) {
    return this.service.getPlaceDetail(query.placeId)
  }

  @Get('orders')
  @ApiResponse({ type: [OrderItemDto] })
  getOrders(@Query() query: PlaceDto) {
    return this.service.getOrdersByPlace(query.placeId)
  }

  @Get('order-detail')
  getOrderDetail(@Query() query: OrderDto) {
    return this.service.getOrderDetail(query.orderId)
  }

  @Get('place-services')
  getPlaceServices(@Query() query: PlaceDto) {
    return this.service.getPlaceServices(query.placeId)
  }

  @Get('dashboard')
  @ApiResponse({ type: DashboardDto })
  getDashboard(@Query() query: VendorDto) {
    return this.service.getDashboard(query.vendorId)
  }

  @Post('add-new-place')
  @ApiOperation({ summary: 'Tạo địa điểm + services + menu Excel' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    type: CreateFullPlaceDto
  })
  @UseInterceptors(FileInterceptor('file'))
  createFull(
    @Body() body: any,
    @UploadedFile() file: Express.Multer.File
  ) {

    const dto = {
      name: body.name,
      address: body.address,
      city: body.city,
      latitude: Number(body.latitude),
      longitude: Number(body.longitude),
    categories: this.parseFlexible(body.categories),
    services: this.parseFlexible(body.services)
    }

    return this.service.createFullPlace(dto, file)
  }

private parseFlexible(value: any) {
  if (!value) return []

  // 👉 nếu là array rồi
  if (Array.isArray(value)) return value

  // 👉 nếu là JSON string
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      // 👉 nếu chỉ là string đơn (Restaurant)
      return [value]
    }
  }

  return [value]
}
}